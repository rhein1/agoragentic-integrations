#!/usr/bin/env python3
"""Offline smoke checker for example entrypoints documented in README files."""

from __future__ import annotations

import argparse
import ast
import dataclasses
import pathlib
import re
import sys
import tempfile
import textwrap
from typing import Iterable, List, Sequence, Tuple


COMMAND = re.compile(
    r"(?m)^[ \t]*(?:[$>]\s*)?"
    r"(?:python(?:3)?|node)\s+"
    r"([^\s;&|`'\"\\]+)"
    r"(?:\s|$)"
)
README_NAMES = {"README", "README.md", "README.rst", "README.txt"}
SUPPORTED = {".py", ".mjs", ".js"}


@dataclasses.dataclass(frozen=True)
class Finding:
    code: str
    path: str
    detail: str

    def render(self) -> str:
        suffix = f": {self.detail}" if self.detail else ""
        return f"{self.code} {self.path}{suffix}"


def read_text(path: pathlib.Path) -> str:
    return path.read_text(encoding="utf-8")


def repository_readmes(root: pathlib.Path) -> Iterable[pathlib.Path]:
    examples = root / "examples"
    if not examples.is_dir():
        return ()
    return sorted(
        path for path in examples.rglob("*")
        if path.is_file() and path.name in README_NAMES
    )


def documented_entrypoints(readme: pathlib.Path) -> List[str]:
    values: List[str] = []
    for match in COMMAND.finditer(read_text(readme)):
        candidate = match.group(1).strip()
        if candidate.startswith(("./", "../")):
            values.append(candidate)
    return values


def resolve_entrypoint(readme: pathlib.Path, value: str) -> pathlib.Path:
    return (readme.parent / value).resolve()


def relative_path(root: pathlib.Path, path: pathlib.Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()


def syntax_finding(root: pathlib.Path, path: pathlib.Path) -> Finding | None:
    suffix = path.suffix.lower()
    if suffix not in SUPPORTED:
        return Finding(
            "unsupported_entrypoint_type",
            relative_path(root, path),
            "use a .py, .mjs, or .js example",
        )
    if suffix == ".py":
        try:
            ast.parse(read_text(path), filename=str(path))
        except (OSError, SyntaxError) as exc:
            return Finding("invalid_python_syntax", relative_path(root, path), str(exc))
    else:
        source = read_text(path)
        if not source.strip():
            return Finding(
                "empty_entrypoint",
                relative_path(root, path),
                "entrypoint contains no executable text",
            )
    return None


def check_readme(root: pathlib.Path, readme: pathlib.Path) -> List[Finding]:
    findings: List[Finding] = []
    readme_name = relative_path(root, readme)
    try:
        entries = documented_entrypoints(readme)
    except (OSError, UnicodeDecodeError) as exc:
        return [Finding("unreadable_readme", readme_name, str(exc))]
    if not entries:
        return [
            Finding(
                "no_documented_entrypoint",
                readme_name,
                "add a runnable python or node command using a relative path",
            )
        ]
    seen = set()
    for value in entries:
        if value in seen:
            findings.append(
                Finding("duplicate_documented_entrypoint", readme_name, value)
            )
            continue
        seen.add(value)
        target = resolve_entrypoint(readme, value)
        if root not in target.parents:
            findings.append(Finding("entrypoint_outside_repository", readme_name, value))
            continue
        if not target.is_file():
            findings.append(
                Finding(
                    "missing_entrypoint",
                    relative_path(root, target),
                    f"documented by {readme_name}",
                )
            )
            continue
        try:
            finding = syntax_finding(root, target)
        except (OSError, UnicodeDecodeError) as exc:
            finding = Finding(
                "unreadable_entrypoint", relative_path(root, target), str(exc)
            )
        if finding is not None:
            findings.append(finding)
    return findings


def check_repository(root: pathlib.Path) -> List[Finding]:
    readmes = list(repository_readmes(root))
    if not readmes:
        # Repositories may legitimately have no examples yet; there is
        # nothing to validate until an examples README is added.
        return []
    findings: List[Finding] = []
    for readme in readmes:
        findings.extend(check_readme(root, readme))
    return findings


def make_case(files: dict[str, str]) -> pathlib.Path:
    root = pathlib.Path(tempfile.mkdtemp(prefix="entrypoint-smoke-"))
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(content), encoding="utf-8")
    return root


def test_cases() -> Sequence[Tuple[str, dict[str, str], Sequence[str]]]:
    return (
        (
            "empty_repository",
            {},
            (),
        ),
        (
            "valid_python",
            {
                "examples/demo/README.md": "Run with `python3 ./main.py`.\n",
                "examples/demo/main.py": "print('ok')\n",
            },
            (),
        ),
        (
            "valid_node",
            {
                "examples/demo/README.md": "```sh\nnode ./main.mjs\n```\n",
                "examples/demo/main.mjs": "console.log('ok');\n",
            },
            (),
        ),
        (
            "missing_file",
            {"examples/demo/README.md": "python3 ./missing.py\n"},
            ("missing_entrypoint",),
        ),
        (
            "bad_python",
            {
                "examples/demo/README.md": "python ./main.py\n",
                "examples/demo/main.py": "def broken(:\n",
            },
            ("invalid_python_syntax",),
        ),
        (
            "duplicate",
            {
                "examples/demo/README.md": "python ./main.py\npython3 ./main.py\n",
                "examples/demo/main.py": "print(1)\n",
            },
            ("duplicate_documented_entrypoint",),
        ),
        (
            "undocumented",
            {"examples/demo/README.md": "Install dependencies first.\n"},
            ("no_documented_entrypoint",),
        ),
    )


def self_test() -> None:
    for name, files, expected in test_cases():
        findings = check_repository(make_case(files))
        actual = tuple(item.code for item in findings)
        if actual != tuple(expected):
            raise AssertionError(f"{name}: expected {expected!r}, got {actual!r}")
    print("self-tests: 7 cases passed")
    print("AGOS_RUNTIME_OK")


def main(argv: Sequence[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Check local example entrypoints documented under examples/."
    )
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path.cwd())
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        self_test()
        return 0
    findings = check_repository(args.root.resolve())
    for finding in findings:
        print(finding.render())
    if findings:
        print(f"FAIL: {len(findings)} finding(s)")
        return 1
    print("PASS: documented example entrypoints are locally readable and valid")
    print("AGOS_RUNTIME_OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
