"""Synthetic-only Browser Proof acceptance harness; not a Browser Use executor.

No target URL, HTML, credentials, profile or JavaScript input is accepted.
Playwright's disposable browser context is not an OS network/security sandbox.
"""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import stat
from typing import Any

PLAYWRIGHT_VERSION = "1.57.0"
VIEWPORTS = (375, 768, 1280)
PROBE_URL = "https://agoragentic-fixture.invalid/out-of-scope"
FIXTURE = """<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Agoragentic Browser Proof fixture</title>
<style>body{font:17px/1.5 system-ui;max-width:60rem;margin:1rem auto;padding:0 1rem}a{display:inline-block;padding:.75rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid;padding:1rem}section{margin-top:2rem}:focus-visible{outline:3px solid}</style></head>
<body><h1>Governed work fixture</h1><p>Synthetic evidence only. No production or payment action.</p>
<a href="#evidence">Review evidence</a><section id="evidence"><h2>Receipt fixture</h2>
<p>Outcome: pending independent verification.</p><pre>authority: none\nsettlement: not performed</pre>
<details><summary>What this does not prove</summary><p>This is not Browser Use compatibility, OS isolation or production protection.</p></details>
</section></body></html>"""


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def runtime_digest(executable: Path, expected: str | None = None) -> str:
    info = executable.lstat()
    if not stat.S_ISREG(info.st_mode) or executable.is_symlink() or info.st_size > 512 * 1024 * 1024:
        raise ValueError("invalid_browser_executable")
    if expected is not None and not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise ValueError("invalid_browser_digest")
    h = hashlib.sha256()
    total = 0
    with executable.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            total += len(chunk)
            if total > 512 * 1024 * 1024:
                raise ValueError("browser_size_limit")
            h.update(chunk)
    after = executable.stat()
    if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError("browser_changed_during_hash")
    result = h.hexdigest()
    if expected is not None and result != expected:
        raise ValueError("browser_digest_mismatch")
    return result


def initial_report() -> dict[str, Any]:
    return {"artifact_kind": "browser_fixture_test_report", "scope": "bundled_synthetic_html_only",
            "fixture_sha256": sha256(FIXTURE.encode()), "status": "not_run", "cases": [],
            "network_probe": "not_run", "route_abort_observed": False,
            "browser_connection_closed": False, "process_exit_independently_verified": False,
            "os_isolation_verified": False, "os_network_absence_verified": False,
            "browser_use_runtime_exercised": False, "production_qualified": False,
            "settlement_performed": False, "public_target_tested": False}


def write_new(filename: Path, data: bytes) -> None:
    fd = os.open(filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


async def abort_external(route: Any, observed: list[str]) -> None:
    # Every actual request is denied. The only page content comes from FIXTURE.
    # Never call continue_(), fetch(), or fulfill() with remote/user content.
    observed.append("fixed_probe" if route.request.url == PROBE_URL else "other_request")
    await route.abort("blockedbyclient")


async def exercise(browser: Any, output: Path, report: dict[str, Any]) -> None:
    for width in VIEWPORTS:
        context = await browser.new_context(java_script_enabled=False, service_workers="block",
                                            accept_downloads=False, offline=True,
                                            viewport={"width": width, "height": 900})
        observed: list[str] = []
        async def deny(route: Any) -> None:
            await abort_external(route, observed)
        try:
            await context.route("**/*", deny)
            page = await context.new_page()
            page.set_default_timeout(3000)
            await page.set_content(FIXTURE, wait_until="domcontentloaded")
            if await page.locator("h1").inner_text() != "Governed work fixture":
                raise AssertionError("heading_mismatch")
            await page.get_by_role("link", name="Review evidence").click()
            if page.url != "about:blank#evidence":
                raise AssertionError("anchor_navigation_mismatch")
            if await page.evaluate("document.documentElement.scrollWidth > window.innerWidth"):
                raise AssertionError("horizontal_overflow")
            # This fixed evaluation reads layout only; no caller-authored JS exists.
            png = await page.screenshot(type="png", animations="disabled")
            if len(png) > 1024 * 1024:
                raise ValueError("screenshot_limit")
            name = f"fixture-{width}.png"
            write_new(output / name, png)
            report["cases"].append({"viewport_width": width, "heading": "passed", "anchor_navigation": "passed",
                                    "horizontal_overflow": False, "screenshot": name,
                                    "screenshot_sha256": sha256(png), "screenshot_bytes": len(png)})
            if width == VIEWPORTS[-1]:
                try:
                    await page.goto(PROBE_URL, timeout=3000, wait_until="domcontentloaded")
                except Exception:
                    # Error text can contain paths/URLs. Keep only measured gate evidence.
                    report["route_abort_observed"] = "fixed_probe" in observed
                    report["network_probe"] = "route_aborted" if report["route_abort_observed"] else "blocked_before_route_or_unknown"
                else:
                    raise AssertionError("unexpected_external_navigation")
        finally:
            await asyncio.wait_for(context.close(), timeout=5)
    if len(report["cases"]) == len(VIEWPORTS) and report["route_abort_observed"]:
        report["status"] = "fixture_passed"
    else:
        report["status"] = "blocked"
        report["reason"] = "route_boundary_not_exercised"


async def run_proof(output: Path, *, chromium_path: Path | None = None,
                    expected_sha256: str | None = None,
                    cancel_event: asyncio.Event | None = None) -> dict[str, Any]:
    # Output is a fresh, owner-chosen directory; no previous run is overwritten.
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    report = initial_report()
    browser = None
    tasks: list[asyncio.Task[Any]] = []
    try:
        from playwright.async_api import async_playwright
        installed = importlib.metadata.version("playwright")
        if installed != PLAYWRIGHT_VERSION:
            raise ValueError("playwright_version_mismatch")
        if (chromium_path is None) != (expected_sha256 is None):
            raise ValueError("custom_browser_requires_path_and_digest")
        async with async_playwright() as runtime:
            executable = chromium_path or Path(runtime.chromium.executable_path)
            digest = runtime_digest(executable, expected_sha256)
            report["runtime"] = {"playwright_version": installed, "browser_executable_sha256": digest,
                                 "selection": "explicit_digest_pinned" if chromium_path else "installed_playwright_bundle"}
            # Only immutable synthetic fixtures run here. No sandbox/production claim.
            # No command-line security override or authenticated profile is accepted.
            browser_env = {key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR") if key in os.environ}
            browser_env.update({"PATH": os.defpath, "LANG": "C.UTF-8"})
            browser = await runtime.chromium.launch(executable_path=str(executable), headless=True, timeout=10000, env=browser_env)
            report["runtime"]["browser_version"] = browser.version
            try:
                if cancel_event is not None and cancel_event.is_set():
                    report["status"] = "cancelled"
                else:
                    work = asyncio.create_task(exercise(browser, output, report)); tasks.append(work)
                    if cancel_event is None:
                        await asyncio.wait_for(work, timeout=20)
                    else:
                        cancellation = asyncio.create_task(cancel_event.wait()); tasks.append(cancellation)
                        done, _ = await asyncio.wait(tasks, timeout=20, return_when=asyncio.FIRST_COMPLETED)
                        if cancellation in done:
                            report["status"] = "cancelled"
                            work.cancel()
                        elif work in done:
                            await work
                        else:
                            raise TimeoutError("fixture_deadline")
            finally:
                for task in tasks:
                    if not task.done(): task.cancel()
                if tasks: await asyncio.gather(*tasks, return_exceptions=True)
                try:
                    await asyncio.wait_for(browser.close(), timeout=5)
                    report["browser_connection_closed"] = not browser.is_connected()
                except Exception:
                    report["status"] = "blocked"; report["reason"] = "browser_cleanup_unknown"
    except asyncio.CancelledError:
        report["status"] = "cancelled"
    except Exception as error:
        report["status"] = "blocked"
        # Typed labels, no exception messages, command lines or private browser paths.
        report["reason"] = type(error).__name__
    if report["status"] == "fixture_passed" and not report["browser_connection_closed"]:
        report["status"] = "blocked"; report["reason"] = "browser_cleanup_unknown"
    write_new(output / "report.json", (json.dumps(report, indent=2) + "\n").encode())
    return report


async def cli() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--chromium-path", type=Path)
    parser.add_argument("--expected-sha256")
    parser.add_argument("--cancel-before-work", action="store_true", help="Exercise the cancellation fixture, not a successful run")
    args = parser.parse_args()
    event = asyncio.Event() if args.cancel_before_work else None
    if event is not None: event.set()
    result = await run_proof(args.output, chromium_path=args.chromium_path,
                             expected_sha256=args.expected_sha256, cancel_event=event)
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "fixture_passed" else 2


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(cli()))
    except (OSError, ValueError):
        print('{"status":"blocked","reason":"invalid_local_run_configuration"}')
        raise SystemExit(2)
