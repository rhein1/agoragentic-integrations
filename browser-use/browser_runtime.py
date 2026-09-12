"""Bound a synthetic browser run to a private, read-only copy of reviewed bytes.

The copy removes reliance on a mutable installation path. It is NOT protection
against a privileged process or malicious code running as the same OS user.
"""
from __future__ import annotations
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
from typing import BinaryIO, Iterator

MAX_FILE = 512 * 1024 * 1024
MAX_TOTAL = 768 * 1024 * 1024
MAX_ENTRIES = 2000


def identity(info: os.stat_result) -> tuple[int, ...]:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_nlink)


def file_digest(filename: Path, sink: BinaryIO | None = None, *,
                remaining_bytes: int | None = None) -> tuple[str, os.stat_result]:
    if remaining_bytes is not None and (type(remaining_bytes) is not int or remaining_bytes < 0):
        raise ValueError('invalid_browser_budget')
    limit = MAX_FILE if remaining_bytes is None else min(MAX_FILE, remaining_bytes)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    fd = os.open(filename, flags)
    try:
        before, named = os.fstat(fd), filename.lstat()
        if (not stat.S_ISREG(before.st_mode) or not stat.S_ISREG(named.st_mode)
                or before.st_nlink != 1 or not before.st_ino or before.st_size > MAX_FILE):
            raise ValueError('invalid_browser_executable')
        if identity(before) != identity(named):
            raise ValueError('browser_changed_during_hash')
        if before.st_size > limit:
            raise ValueError('browser_bundle_size_limit')
        total, digest = 0, hashlib.sha256()
        while True:
            # Probe at most one byte beyond the allowance, never write that byte.
            # This also catches a source growing after the descriptor size check.
            chunk = os.read(fd, min(1024 * 1024, limit - total + 1))
            if not chunk:
                break
            if len(chunk) > limit - total:
                code = 'browser_bundle_size_limit' if remaining_bytes is not None and remaining_bytes <= MAX_FILE else 'browser_size_limit'
                raise ValueError(code)
            total += len(chunk)
            digest.update(chunk)
            if sink is not None and sink.write(chunk) != len(chunk):
                raise OSError('browser_copy_short_write')
        if (total != before.st_size or identity(before) != identity(os.fstat(fd))
                or identity(before) != identity(filename.lstat()) or filename.is_symlink()):
            raise ValueError('browser_changed_during_hash')
        return digest.hexdigest(), before
    finally:
        os.close(fd)


def inventory(root: Path) -> list[Path]:
    files: list[Path] = []
    entries = 0
    def walk(directory: Path, depth: int) -> None:
        nonlocal entries
        if depth > 16:
            raise ValueError('browser_inventory_limit')
        with os.scandir(directory) as listing:
            for entry in listing:
                entries += 1
                if entries > MAX_ENTRIES or entry.is_symlink():
                    raise ValueError('invalid_browser_inventory')
                item = Path(entry.path)
                if entry.is_dir(follow_symlinks=False):
                    walk(item, depth + 1)
                elif entry.is_file(follow_symlinks=False):
                    files.append(item)
                else:
                    raise ValueError('invalid_browser_inventory')
    if root.is_symlink() or not root.is_dir():
        raise ValueError('invalid_browser_inventory')
    walk(root, 0)
    return sorted(files)


def tree_digest(records: list[list[object]]) -> str:
    return hashlib.sha256(json.dumps(records, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()


@dataclass
class PreparedBrowser:
    root: Path
    executable: Path
    executable_sha256: str
    tree_sha256: str
    identities: dict[str, tuple[int, ...]]
    total_bytes: int

    def verify(self) -> None:
        records: list[list[object]] = []
        total = 0
        for file in inventory(self.root):
            relative = file.relative_to(self.root).as_posix()
            digest, info = file_digest(file, remaining_bytes=MAX_TOTAL - total)
            total += info.st_size
            if self.identities.get(relative) != identity(info):
                raise ValueError('launch_copy_changed')
            if stat.S_IMODE(info.st_mode) & 0o222:
                raise ValueError('launch_copy_writable')
            records.append([relative, info.st_size, digest])
        if total != self.total_bytes or len(records) != len(self.identities) or tree_digest(records) != self.tree_sha256:
            raise ValueError('launch_copy_changed')


def cleanup_owned(directory: Path) -> None:
    # Only the freshly allocated test-owned tree is passed here. Never follow
    # a link while restoring permissions needed to remove read-only copies.
    for root, dirs, files in os.walk(directory, followlinks=False):
        os.chmod(root, 0o700)
        for name in files:
            file = Path(root) / name
            if not file.is_symlink():
                os.chmod(file, 0o600)
    shutil.rmtree(directory)


@contextmanager
def prepare_browser(executable: Path, expected: str, expected_tree: str | None = None) -> Iterator[PreparedBrowser]:
    import re
    if not re.fullmatch(r'[a-f0-9]{64}', expected) or (expected_tree is not None and not re.fullmatch(r'[a-f0-9]{64}', expected_tree)):
        raise ValueError('invalid_browser_digest')
    if executable.is_symlink() or not executable.is_file():
        raise ValueError('invalid_browser_executable')
    executable = executable.absolute()
    source = executable.parent.resolve(strict=True)
    owned = Path(tempfile.mkdtemp(prefix='agoragentic-browser-runtime-'))
    target = owned / 'bundle'
    target.mkdir(mode=0o700)
    try:
        records: list[list[object]] = []
        identities: dict[str, tuple[int, ...]] = {}
        total, selected_digest = 0, None
        for file in inventory(source):
            relative = file.relative_to(source)
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            # Hash and copy the same verified descriptor within the remaining
            # aggregate allowance. A rejected file cannot overshoot disk usage.
            with destination.open('xb') as sink:
                digest, info = file_digest(file, sink, remaining_bytes=MAX_TOTAL - total)
                sink.flush()
                os.fsync(sink.fileno())
            total += info.st_size
            if total > MAX_TOTAL:
                raise ValueError('browser_bundle_size_limit')
            os.chmod(destination, 0o500 if info.st_mode & 0o111 else 0o400)
            identities[relative.as_posix()] = identity(destination.lstat())
            records.append([relative.as_posix(), info.st_size, digest])
            if relative.as_posix() == executable.name:
                selected_digest = digest
        actual_tree = tree_digest(records)
        if selected_digest != expected:
            raise ValueError('browser_digest_mismatch')
        if expected_tree is not None and actual_tree != expected_tree:
            raise ValueError('browser_bundle_digest_mismatch')
        for root, _, _ in os.walk(target, topdown=False):
            os.chmod(root, 0o500)
        prepared = PreparedBrowser(target, target / executable.name, expected, actual_tree, identities, total)
        prepared.verify()
        yield prepared
    finally:
        cleanup_owned(owned)
