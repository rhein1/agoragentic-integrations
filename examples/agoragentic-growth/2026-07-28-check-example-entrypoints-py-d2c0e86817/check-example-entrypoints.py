#!/usr/bin/env python3
"""Offline checker for documented example entrypoints and relative Markdown links."""

from __future__ import annotations

import argparse
import os
import re
import shlex
import sys
import tempfile
from pathlib import Path
from typing import Dict, Iterable, List, NamedTuple, Optional, Sequence, Tuple


README_NAMES = {"README.md", "CONTRIBUTING.md", "EXAMPLES.md", "GETTING_STARTED.md"}
ENTRYPOINT_SUFFIXES = {".py", ".mjs", ".js", ".ts", ".tsx", ".sh"}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv"}
LINK_RE = re.compile(r"(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+[\"'][^)]*[\"'])?\)")
REFERENCE_DEFINITION_RE = re.compile(
    r"^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))"
)
REFERENCE_USAGE_RE = re.compile(r"(?<!!)\[([^\]]+)\]\[([^\]]*)\]")
INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
COMMAND_RE = re.compile(r"(?<![\w-])(?:python3?|py|node|bash|sh)\s+[^`\n]+", re.IGNORECASE)
INTERPRETERS = {"python", "python3", "py", "node", "bash", "sh"}
SHELL_FENCE_LANGUAGES = {
    "", "bat", "bash", "cmd", "console", "powershell", "pwsh", "sh", "shell",
    "terminal", "zsh",
}
ENV_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
ENTRYPOINT_CUES = ("example", "entrypoint", "quickstart", "run ", "runnable")
ENTRYPOINT_TOKEN_RE = re.compile(
    r"^(?:\.{0,2}[\\/])?[A-Za-z0-9_.@+-]+"
    r"(?:[\\/][A-Za-z0-9_.@+-]+)*\.(?:py|mjs|js|ts|tsx|sh)"
    r"(?:[?#].*)?$",
    re.IGNORECASE,
)


class Finding(NamedTuple):
    path: str
    line: int
    code: str
    message: str


def iter_files(root: Path, names: set[str]) -> Iterable[Path]:
    for directory, subdirs, files in os.walk(root):
        subdirs[:] = sorted(d for d in subdirs if d not in SKIP_DIRS)
        for name in sorted(files):
            if name in names:
                yield Path(directory) / name


def is_local_target(target: str) -> bool:
    return not (
        target.startswith(("#", "/", "mailto:", "http://", "https://"))
        or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target)
    )


def clean_target(target: str) -> str:
    return target.split("#", 1)[0].split("?", 1)[0]


def looks_like_entrypoint(path: Path, label: str = "") -> bool:
    del label
    return path.suffix.lower() in ENTRYPOINT_SUFFIXES


def is_entrypoint_token(value: str) -> bool:
    return bool(ENTRYPOINT_TOKEN_RE.fullmatch(value))


def markdown_regions(lines: Sequence[str]) -> List[Tuple[int, str, bool, str]]:
    regions: List[Tuple[int, str, bool, str]] = []
    in_fence = False
    fence_marker = ""
    fence_language = ""
    for number, line in enumerate(lines, 1):
        match = FENCE_RE.match(line)
        if match:
            marker = match.group(1)
            remainder = match.group(2).strip()
            if not in_fence:
                in_fence = True
                fence_marker = marker
                fence_language = remainder.split(maxsplit=1)[0].casefold() if remainder else ""
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


def normalize_reference_label(label: str) -> str:
    return " ".join(label.split()).casefold()


def reference_definitions(
    regions: Sequence[Tuple[int, str, bool, str]],
) -> Dict[str, Tuple[str, int]]:
    definitions: Dict[str, Tuple[str, int]] = {}
    for number, line, in_fence, _fence_language in regions:
        if in_fence:
            continue
        match = REFERENCE_DEFINITION_RE.match(line)
        if not match:
            continue
        target = (match.group(2) or match.group(3) or "").strip()
        definitions.setdefault(
            normalize_reference_label(match.group(1)), (target, number)
        )
    return definitions


def link_findings(
    readme: Path,
    root: Path,
    number: int,
    label: str,
    raw_target: str,
) -> List[Finding]:
    if not is_local_target(raw_target):
        return []
    target = clean_target(raw_target.strip().strip("<>"))
    if not target:
        return []

    relative_readme = str(readme.relative_to(root))
    destination = (readme.parent / target).resolve()
    try:
        destination.relative_to(root.resolve())
    except ValueError:
        return [Finding(relative_readme, number, "link_escapes_root",
                        f"relative link leaves repository: {raw_target}")]

    findings: List[Finding] = []
    if not destination.exists():
        findings.append(Finding(relative_readme, number, "missing_relative_link",
                                f"documented target does not exist: {raw_target}"))
        if looks_like_entrypoint(Path(target), label):
            findings.append(Finding(
                relative_readme,
                number,
                "missing_example_entrypoint",
                f"example command references missing file: {raw_target}",
            ))
    elif looks_like_entrypoint(destination, label) and not destination.is_file():
        findings.append(Finding(relative_readme, number, "entrypoint_not_file",
                                f"documented entrypoint is not a file: {raw_target}"))
    return findings


def check_readme(readme: Path, root: Path) -> List[Finding]:
    findings: List[Finding] = []
    lines = readme.read_text(encoding="utf-8").splitlines()
    regions = markdown_regions(lines)
    definitions = reference_definitions(regions)
    for number, line, in_fence, _fence_language in regions:
        if in_fence:
            continue
        for match in LINK_RE.finditer(line):
            label, raw_target = match.groups()
            findings.extend(link_findings(
                readme, root, number, label, raw_target
            ))

        if REFERENCE_DEFINITION_RE.match(line):
            continue
        for match in REFERENCE_USAGE_RE.finditer(line):
            label = match.group(2) or match.group(1)
            definition = definitions.get(normalize_reference_label(label))
            if definition is None:
                findings.append(Finding(
                    str(readme.relative_to(root)),
                    number,
                    "missing_reference_definition",
                    f"reference link has no definition: {label}",
                ))
                continue
            raw_target, _definition_line = definition
            findings.extend(link_findings(
                readme, root, number, match.group(1), raw_target
            ))
    return findings


def command_entrypoint(value: str, allow_standalone: bool = False) -> Optional[str]:
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
    if not tokens:
        return None

    first = tokens[0].casefold()
    if first not in INTERPRETERS:
        candidate = tokens[0].rstrip(",;)")
        filename = Path(clean_target(candidate)).name
        if (allow_standalone and len(tokens) == 1
                and is_entrypoint_token(candidate)
                and filename == filename.lower()):
            return candidate
        return None

    for token in tokens[1:]:
        if token in {"&&", "||", "|", ";"}:
            break
        candidate = token.rstrip(",;)")
        if candidate.startswith("-"):
            continue
        if is_entrypoint_token(candidate):
            return candidate
        return None
    return None


def entrypoint_mentions(
    line: str, in_fence: bool, fence_language: str,
) -> List[str]:
    if in_fence and fence_language not in SHELL_FENCE_LANGUAGES:
        return []
    values: List[str] = []
    snippets = [line] if in_fence else INLINE_CODE_RE.findall(line)
    allow_standalone = (
        not in_fence and any(cue in line.casefold() for cue in ENTRYPOINT_CUES)
    )
    for snippet in snippets:
        candidate = command_entrypoint(snippet, allow_standalone=allow_standalone)
        if candidate:
            values.append(candidate)

    if not in_fence:
        for match in COMMAND_RE.finditer(INLINE_CODE_RE.sub("", line)):
            candidate = command_entrypoint(match.group(0))
            if candidate:
                values.append(candidate)
    return list(dict.fromkeys(values))


def resolve_entrypoint(
    readme: Path, root: Path, value: str,
) -> Tuple[Optional[Path], bool]:
    target = clean_target(value.strip().strip("<>"))
    if not target or not is_local_target(target):
        return None, False
    raw_path = Path(target)
    if raw_path.is_absolute():
        return None, False

    normalized = target.replace("\\", "/")
    if normalized.startswith(("./", "../")) or "/" not in normalized:
        candidates = [(readme.parent / raw_path).resolve()]
    else:
        candidates = [(root / raw_path).resolve(), (readme.parent / raw_path).resolve()]

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
    destination = next(
        (candidate for candidate in safe_candidates if candidate.exists()),
        safe_candidates[0],
    )
    return destination, False


def check_entrypoint_mentions(readme: Path, root: Path) -> List[Finding]:
    findings: List[Finding] = []
    lines = readme.read_text(encoding="utf-8").splitlines()
    for number, line, in_fence, fence_language in markdown_regions(lines):
        for value in entrypoint_mentions(line, in_fence, fence_language):
            destination, escaped = resolve_entrypoint(readme, root, value)
            if escaped:
                findings.append(Finding(
                    str(readme.relative_to(root)),
                    number,
                    "entrypoint_escapes_root",
                    f"example command leaves repository: {value}",
                ))
                continue
            if destination is None:
                continue
            if not destination.exists():
                findings.append(Finding(str(readme.relative_to(root)), number,
                                        "missing_example_entrypoint",
                                        f"example command references missing file: {value}"))
            elif not destination.is_file():
                findings.append(Finding(str(readme.relative_to(root)), number,
                                        "entrypoint_not_file",
                                        f"example command target is not a file: {value}"))
    return findings


def check(root: Path) -> List[Finding]:
    findings: List[Finding] = []
    for readme in iter_files(root, README_NAMES):
        findings.extend(check_readme(readme, root))
        findings.extend(check_entrypoint_mentions(readme, root))
    return list(dict.fromkeys(findings))


def render(findings: Sequence[Finding]) -> str:
    if not findings:
        return "No broken documented example entrypoints or relative links found."
    return "\n".join(
        f"{item.path}:{item.line}: {item.code}: {item.message}"
        for item in findings
    )


def write_fixture(root: Path, files: Dict[str, str]) -> None:
    for filename, content in files.items():
        path = root / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def self_test() -> None:
    cases = [
        (
            {"examples/README.md": "[run](hello.py)\n",
             "examples/hello.py": "print('ok')\n"},
            [],
        ),
        (
            {"examples/README.md": "[run](missing.py)\n"},
            ["missing_relative_link", "missing_example_entrypoint"],
        ),
        (
            {"examples/README.md": "Run `missing.py` as an example.\n"},
            ["missing_example_entrypoint"],
        ),
        (
            {"examples/README.md": "[run][hello]\n\n[hello]: hello.py\n",
             "examples/hello.py": "print('ok')\n"},
            [],
        ),
        (
            {"examples/README.md": "[run][missing-ref]\n"},
            ["missing_reference_definition"],
        ),
        (
            {"examples/README.md": "[run][]\n\n[run]: missing.py\n"},
            ["missing_relative_link", "missing_example_entrypoint"],
        ),
        (
            {"examples/README.md": "[outside][escape]\n\n[escape]: ../../secret.py\n"},
            ["link_escapes_root"],
        ),
        (
            {"README.md": "Run `node examples/hello.mjs --demo`.\n",
             "examples/hello.mjs": "console.log('ok');\n"},
            [],
        ),
        (
            {"docs/README.md": "```sh\nnode examples/hello.mjs\n```\n",
             "examples/hello.mjs": "console.log('ok');\n"},
            [],
        ),
        (
            {"README.md": "```sh\nnode examples/missing.mjs\n```\n"},
            ["missing_example_entrypoint"],
        ),
        (
            {"docs/README.md": "```sh\nnode ../../outside.mjs\n```\n"},
            ["entrypoint_escapes_root"],
        ),
        (
            {"README.md": (
                "````markdown\n```sh\nnode examples/missing.mjs\n```\n````\n"
            )},
            [],
        ),
        (
            {"README.md": (
                "Example settings: `AGORAGENTIC_API_KEY`, `/api/execute`, "
                "`execute()`, `examples/`, and `npx package@latest`.\n"
            )},
            [],
        ),
        (
            {"README.md": "[external](https://example.test/missing.py)\n[anchor](#hello)\n"},
            [],
        ),
        (
            {"examples/README.md": "[run](hello.py#section)\n",
             "examples/hello.py": "print('ok')\n"},
            [],
        ),
    ]
    for files, expected in cases:
        with tempfile.TemporaryDirectory(prefix="example-check-") as name:
            root = Path(name)
            write_fixture(root, files)
            actual = [finding.code for finding in check(root)]
            assert actual == expected, (files, actual, expected)
    with tempfile.TemporaryDirectory(prefix="example-check-") as name:
        root = Path(name)
        (root / "README.md").write_text(
            "```text\n[ignored](missing.py)\n```\n", encoding="utf-8"
        )
        assert check(root) == []
    print("AGOS_RUNTIME_OK")


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Check documented local example entrypoints without network access."
    )
    parser.add_argument("root", nargs="?", default=".", type=Path,
                        help="repository root to inspect (default: current directory)")
    parser.add_argument("--self-test", action="store_true",
                        help="run deterministic local tests")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    root = args.root.resolve()
    if not root.is_dir():
        print(f"error: repository root is not a directory: {root}", file=sys.stderr)
        return 2
    findings = check(root)
    print(render(findings))
    if findings:
        print(f"\n{len(findings)} finding(s); fix documented paths before publishing.")
        return 1
    print("AGOS_RUNTIME_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
