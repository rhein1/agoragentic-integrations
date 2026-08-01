#!/usr/bin/env python3
"""Offline checks for documented examples and repository-relative navigation."""

from __future__ import annotations

import argparse
import os
import re
import shlex
import sys
import tempfile
from pathlib import Path
from typing import Dict, Iterable, List, NamedTuple, Optional, Sequence, Tuple
from urllib.parse import unquote, urlsplit


MARKDOWN_SUFFIXES = {".md", ".markdown"}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv"}
LINK_RE = re.compile(r"(?<!!)\[([^\]]*)\]\(([^)\n]+)\)")
HTML_LINK_RE = re.compile(r"""(?i)<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']""")
REFERENCE_DEFINITION_RE = re.compile(
    r"^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))"
)
REFERENCE_USAGE_RE = re.compile(r"(?<!!)\[([^\]]+)\]\[([^\]]*)\]")
INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
COMMAND_RE = re.compile(
    r"(?<![\w-])(?:python3?|py|node)\s+[^`\n]+", re.IGNORECASE
)
INTERPRETERS = {"python", "python3", "py", "node"}
SHELL_FENCE_LANGUAGES = {
    "", "bat", "bash", "cmd", "console", "powershell", "pwsh", "sh",
    "shell", "terminal", "zsh",
}
ENV_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
ENTRYPOINT_TOKEN_RE = re.compile(
    r"^(?:\.{0,2}[\\/])?[A-Za-z0-9_.@+-]+"
    r"(?:[\\/][A-Za-z0-9_.@+-]+)*\.(?:py|mjs|js)(?:[?#].*)?$",
    re.IGNORECASE,
)
NAV_HINT_RE = re.compile(r"(?i)(?:nav|menu|sidebar|toc|navigation)")


class Finding(NamedTuple):
    code: str
    path: str
    detail: str

    def line(self) -> str:
        return f"{self.code}: {self.path}: {self.detail}"


class DocumentLink(NamedTuple):
    raw: str
    label: str
    line: int


def relative_files(root: Path) -> Iterable[Path]:
    for directory, subdirs, files in os.walk(root):
        subdirs[:] = sorted(item for item in subdirs if item not in SKIP_DIRS)
        for name in sorted(files):
            yield Path(directory) / name


def is_external(target: str) -> bool:
    parsed = urlsplit(target)
    return bool(parsed.scheme or parsed.netloc) or target.startswith(("#", "mailto:"))


def clean_target(raw: str) -> str:
    target = raw.strip().split(None, 1)[0]
    target = target.strip("<>")
    return unquote(urlsplit(target).path)


def normalize_reference_label(label: str) -> str:
    return " ".join(label.split()).casefold()


def markdown_regions(text: str) -> List[Tuple[int, str, bool, str]]:
    regions: List[Tuple[int, str, bool, str]] = []
    in_fence = False
    fence_marker = ""
    fence_language = ""
    for number, line in enumerate(text.splitlines(), 1):
        match = FENCE_RE.match(line)
        if match:
            marker = match.group(1)
            remainder = match.group(2).strip()
            if not in_fence:
                in_fence = True
                fence_marker = marker
                fence_language = (
                    remainder.split(maxsplit=1)[0].casefold() if remainder else ""
                )
                continue
            if (marker[0] == fence_marker[0]
                    and len(marker) >= len(fence_marker)
                    and not remainder):
                in_fence = False
                fence_marker = ""
                fence_language = ""
                continue
        regions.append((number, line, in_fence, fence_language))
    return regions


def document_links(
    source: Path, root: Path, text: str,
) -> Tuple[List[DocumentLink], List[Finding]]:
    links: List[DocumentLink] = []
    findings: List[Finding] = []
    regions = markdown_regions(text)
    definitions: Dict[str, Tuple[str, int]] = {}
    for number, line, in_fence, _language in regions:
        if in_fence:
            continue
        match = REFERENCE_DEFINITION_RE.match(line)
        if match:
            definitions.setdefault(
                normalize_reference_label(match.group(1)),
                ((match.group(2) or match.group(3) or "").strip(), number),
            )

    relative_source = str(source.relative_to(root))
    for number, line, in_fence, _language in regions:
        if in_fence:
            continue
        for match in LINK_RE.finditer(line):
            links.append(DocumentLink(match.group(2), match.group(1).strip(), number))
        for match in HTML_LINK_RE.finditer(line):
            links.append(DocumentLink(match.group(1), "", number))
        if REFERENCE_DEFINITION_RE.match(line):
            continue
        for match in REFERENCE_USAGE_RE.finditer(line):
            label = match.group(2) or match.group(1)
            definition = definitions.get(normalize_reference_label(label))
            if definition is None:
                findings.append(Finding(
                    "missing_reference_definition",
                    relative_source,
                    f"line {number}: reference link has no definition: {label!r}",
                ))
                continue
            raw, _definition_line = definition
            links.append(DocumentLink(raw, match.group(1).strip(), number))
    return links, findings


def resolve_link(source: Path, target: str, root: Path) -> Path:
    path = clean_target(target)
    if path.startswith("/"):
        return root / path.lstrip("/")
    return (source.parent / path).resolve()


def check_relative_links(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    for source in relative_files(root):
        if source.suffix.lower() not in MARKDOWN_SUFFIXES:
            continue
        try:
            text = source.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            findings.append(Finding(
                "unreadable_markdown",
                str(source.relative_to(root)),
                "file is not UTF-8 text",
            ))
            continue
        links, reference_findings = document_links(source, root, text)
        findings.extend(reference_findings)
        for raw, label, line in links:
            target = clean_target(raw)
            if not target or is_external(raw):
                continue
            resolved = resolve_link(source, raw, root)
            try:
                resolved.relative_to(root.resolve())
            except ValueError:
                findings.append(Finding(
                    "link_escapes_root",
                    str(source.relative_to(root)),
                    f"line {line}: relative target {target!r} leaves repository root",
                ))
                continue
            if not resolved.exists():
                shown = label or target
                findings.append(Finding(
                    "missing_relative_link",
                    str(source.relative_to(root)),
                    f"line {line}: {shown!r} points to {target!r}",
                ))
    return findings


def navigation_targets(root: Path) -> List[Tuple[Path, str, str]]:
    found: List[Tuple[Path, str, str]] = []
    for source in relative_files(root):
        if source.suffix.lower() not in MARKDOWN_SUFFIXES:
            continue
        try:
            text = source.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        links, _reference_findings = document_links(source, root, text)
        for raw, label, _line in links:
            if is_external(raw) or not clean_target(raw):
                continue
            if NAV_HINT_RE.search(source.name) or NAV_HINT_RE.search(label):
                found.append((source, clean_target(raw), label))
    return found


def check_duplicate_navigation(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    seen: dict[Tuple[str, str], Tuple[Path, str]] = {}
    for source, target, label in navigation_targets(root):
        key = (str(source.resolve()), target.lower())
        if key in seen:
            previous, previous_label = seen[key]
            detail = f"also listed at {previous.name!r}"
            if previous_label and label and previous_label != label:
                detail += f" with label {previous_label!r}"
            findings.append(Finding(
                "duplicate_navigation_target",
                str(source.relative_to(root)),
                f"{target!r}; {detail}",
            ))
        else:
            seen[key] = (source, label)
    return findings


def command_entrypoint(value: str) -> Optional[str]:
    try:
        tokens = shlex.split(value, posix=False)
    except ValueError:
        tokens = value.split()
    tokens = [token.strip("\"'") for token in tokens]
    while tokens and tokens[0] in {"$", ">"}:
        tokens.pop(0)
    if tokens and tokens[0].casefold() == "env":
        tokens.pop(0)
    while tokens and ENV_ASSIGNMENT_RE.match(tokens[0]):
        tokens.pop(0)
    if not tokens or tokens[0].casefold() not in INTERPRETERS:
        return None
    for token in tokens[1:]:
        if token in {"&&", "||", "|", ";"}:
            break
        candidate = token.rstrip(",;)")
        if candidate.startswith("-"):
            continue
        return candidate if ENTRYPOINT_TOKEN_RE.fullmatch(candidate) else None
    return None


def entrypoint_mentions(
    line: str, in_fence: bool, fence_language: str,
) -> List[str]:
    if in_fence and fence_language not in SHELL_FENCE_LANGUAGES:
        return []
    values: List[str] = []
    snippets = [line] if in_fence else INLINE_CODE_RE.findall(line)
    for snippet in snippets:
        candidate = command_entrypoint(snippet)
        if candidate:
            values.append(candidate)
    if not in_fence:
        for match in COMMAND_RE.finditer(INLINE_CODE_RE.sub("", line)):
            candidate = command_entrypoint(match.group(0))
            if candidate:
                values.append(candidate)
    return list(dict.fromkeys(values))


def resolve_entrypoint(
    source: Path, root: Path, value: str,
) -> Tuple[Optional[Path], bool]:
    target = clean_target(value.strip().strip("<>"))
    if not target or is_external(target) or target.startswith("/"):
        return None, False
    raw_path = Path(target)
    if raw_path.is_absolute():
        return None, False
    normalized = target.replace("\\", "/")
    if normalized.startswith(("./", "../")) or "/" not in normalized:
        candidates = [(source.parent / raw_path).resolve()]
    else:
        candidates = [(root / raw_path).resolve(), (source.parent / raw_path).resolve()]
    safe_candidates: List[Path] = []
    for candidate in candidates:
        try:
            candidate.relative_to(root.resolve())
        except ValueError:
            continue
        if candidate not in safe_candidates:
            safe_candidates.append(candidate)
    if not safe_candidates:
        return None, True
    return next(
        (candidate for candidate in safe_candidates if candidate.exists()),
        safe_candidates[0],
    ), False


def check_entrypoints(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    for source in relative_files(root):
        if source.suffix.lower() not in MARKDOWN_SUFFIXES:
            continue
        try:
            text = source.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for line, content, in_fence, language in markdown_regions(text):
            for value in entrypoint_mentions(content, in_fence, language):
                entry, escaped = resolve_entrypoint(source, root, value)
                relative_source = str(source.relative_to(root))
                if escaped:
                    findings.append(Finding(
                        "entrypoint_escapes_root",
                        relative_source,
                        f"line {line}: command leaves repository root: {value!r}",
                    ))
                    continue
                if entry is None:
                    continue
                if not entry.is_file():
                    findings.append(Finding(
                        "missing_example_entrypoint",
                        relative_source,
                        f"line {line}: command references missing file: {value!r}",
                    ))
                    continue
                try:
                    entry_text = entry.read_text(encoding="utf-8")
                except UnicodeDecodeError:
                    findings.append(Finding(
                        "unreadable_entrypoint",
                        str(entry.relative_to(root)),
                        f"documented by {relative_source}:{line}",
                    ))
                    continue
                if not entry_text.strip():
                    findings.append(Finding(
                        "empty_entrypoint",
                        str(entry.relative_to(root)),
                        f"documented by {relative_source}:{line}",
                    ))
    return findings


def check(root: Path) -> List[Finding]:
    return (
        check_relative_links(root)
        + check_duplicate_navigation(root)
        + check_entrypoints(root)
    )


def render(findings: Sequence[Finding]) -> int:
    if not findings:
        print("example entrypoints: checked")
        print("relative links: checked")
        print("navigation targets: checked")
        print("AGOS_RUNTIME_OK")
        return 0
    print(f"offline repository checks failed ({len(findings)} finding(s))")
    for finding in findings:
        print(f"  {finding.line()}")
    return 1


def self_test() -> int:
    cases = [
        (
            "valid",
            {"README.md": "[source](examples/run.py)\n```sh\npython examples/run.py\n```\n",
             "examples/run.py": "print('ok')\n"},
            [],
        ),
        ("missing-link", {"README.md": "[bad](missing.md)\n"},
         ["missing_relative_link"]),
        ("escape", {"README.md": "[bad](../../outside.md)\n"},
         ["link_escapes_root"]),
        ("missing-reference", {"README.md": "[bad][missing]\n"},
         ["missing_reference_definition"]),
        ("collapsed-reference", {"README.md": "[run][]\n\n[run]: missing.py\n"},
         ["missing_relative_link"]),
        ("reference-link",
         {"README.md": "[run][demo]\n\n[demo]: examples/missing.py\n"},
         ["missing_relative_link"]),
        ("reference-escape", {"README.md": "[bad][out]\n\n[out]: ../outside.md\n"},
         ["link_escapes_root"]),
        ("missing-command", {"README.md": "```sh\nnode examples/missing.mjs\n```\n"},
         ["missing_example_entrypoint"]),
        ("missing-prose-command",
         {"README.md": "Run node examples/missing.mjs to verify it.\n"},
         ["missing_example_entrypoint"]),
        ("nested-root-command",
         {"docs/README.md": "```sh\nnode examples/run.mjs\n```\n",
          "examples/run.mjs": "console.log('ok');\n"}, []),
        ("module-source-link",
         {"README.md": "[module](adapter.py)\n", "adapter.py": "VALUE = 1\n"}, []),
        ("empty-command",
         {"README.md": "```sh\npython run.py\n```\n", "run.py": ""},
         ["empty_entrypoint"]),
        ("duplicate-nav",
         {"README.md": "[nav](one.md)\n[nav](one.md)\n", "one.md": "# One\n"},
         ["duplicate_navigation_target"]),
        ("prose-ignored",
         {"README.md": "Use `AGORAGENTIC_API_KEY` with `POST /api/execute`.\n"}, []),
    ]
    failures = 0
    for name, files, expected_codes in cases:
        with tempfile.TemporaryDirectory(prefix="example-check-") as directory:
            root = Path(directory)
            for filename, content in files.items():
                path = root / filename
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
            actual_codes = [finding.code for finding in check(root)]
            if actual_codes != expected_codes:
                print(
                    f"self-test failure: {name}: expected {expected_codes}, "
                    f"got {actual_codes}",
                    file=sys.stderr,
                )
                failures += 1
    if failures:
        return 1
    print("self-tests: passed")
    print("AGOS_RUNTIME_OK")
    return 0


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "root",
        nargs="?",
        type=Path,
        default=Path("."),
        help="repository root to check",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run deterministic checks without reading a repository",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.self_test:
        return self_test()
    root = args.root.expanduser().resolve()
    if not root.is_dir():
        print(f"repository root is not a directory: {root}", file=sys.stderr)
        return 2
    return render(check(root))


if __name__ == "__main__":
    raise SystemExit(main())
