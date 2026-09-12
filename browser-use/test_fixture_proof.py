"""Provider/browser-free boundary tests; real browser execution is a separate gate."""
import asyncio
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from fixture_proof import FIXTURE, PROBE_URL, VIEWPORTS, abort_external, initial_report, runtime_digest, sha256, write_new, run_proof, exercise, qualification_lock
from browser_runtime import prepare_browser, file_digest, tree_digest

class FixtureBoundaryTests(unittest.TestCase):
    def test_only_bundled_static_content(self):
        self.assertNotIn('<script', FIXTURE)
        self.assertNotIn('src=', FIXTURE)
        self.assertIn("default-src 'none'", FIXTURE)
        self.assertEqual(VIEWPORTS, (375, 768, 1280))

    def test_no_unearned_success_or_runtime_claim(self):
        report = initial_report()
        self.assertEqual(report['status'], 'not_run')
        for field in ['route_abort_observed', 'production_qualified', 'browser_use_runtime_exercised',
                      'settlement_performed', 'os_isolation_verified', 'os_network_absence_verified',
                      'process_exit_independently_verified']:
            self.assertIs(report[field], False)

    def test_every_request_is_aborted_without_following_it(self):
        for url in [PROBE_URL, 'http://127.0.0.1/', 'file:///private', 'https://public.example/', 'data:text/plain,x']:
            calls, observed = [], []
            class Request: pass
            class Route:
                request = Request()
                async def abort(self, code): calls.append(code)
            route = Route(); route.request.url = url
            asyncio.run(abort_external(route, observed))
            self.assertEqual(calls, ['blockedbyclient'])
            self.assertEqual(observed, ['fixed_probe' if url == PROBE_URL else 'other_request'])
            self.assertNotIn(url, json.dumps(observed))

    def test_failed_abort_is_not_positive_interception_evidence(self):
        observed = []
        class Request:
            url = PROBE_URL
        class Route:
            request = Request()
            async def abort(self, code):
                raise RuntimeError("synthetic abort failure")
        with self.assertRaises(RuntimeError):
            asyncio.run(abort_external(Route(), observed))
        self.assertEqual(observed, [])

    def test_runtime_digest_matches_exact_regular_file(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'fixture-binary'; file.write_bytes(b'not executed')
            self.assertEqual(runtime_digest(file, sha256(b'not executed')), sha256(b'not executed'))
            with self.assertRaisesRegex(ValueError, 'browser_digest_mismatch'):
                runtime_digest(file, '0' * 64)
            with self.assertRaisesRegex(ValueError, 'invalid_browser_digest'):
                runtime_digest(file, 'wrong')

    def test_directory_is_not_an_executable(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(ValueError, 'invalid_browser_executable'):
                runtime_digest(Path(root))

    def test_report_write_never_overwrites(self):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / 'report.json'; write_new(file, b'original')
            with self.assertRaises(FileExistsError): write_new(file, b'replacement')
            self.assertEqual(file.read_bytes(), b'original')

    def test_private_copy_survives_original_replacement_and_is_removed(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'chrome'; source.write_bytes(b'original'); source.chmod(0o700)
            (Path(root) / 'resource.pak').write_bytes(b'resource')
            with prepare_browser(source, sha256(b'original')) as prepared:
                source.write_bytes(b'replaced')
                self.assertNotEqual(prepared.executable, source)
                self.assertEqual(prepared.executable.read_bytes(), b'original')
                self.assertEqual(prepared.executable.stat().st_mode & 0o222, 0)
                prepared.verify()
                copied_root = prepared.root.parent
            self.assertFalse(copied_root.exists())
            self.assertEqual(source.read_bytes(), b'replaced')

    def test_tampered_copy_fails_revalidation(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'chrome'; source.write_bytes(b'original')
            with prepare_browser(source, sha256(b'original')) as prepared:
                prepared.executable.chmod(0o600); prepared.executable.write_bytes(b'replaced'); prepared.executable.chmod(0o400)
                with self.assertRaisesRegex(ValueError, 'launch_copy_changed'):
                    prepared.verify()

    def test_bundle_pin_covers_resources_not_just_executable(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'chrome'; source.write_bytes(b'original')
            resource = Path(root) / 'resource.pak'; resource.write_bytes(b'resource')
            expected_tree = tree_digest([['chrome', 8, sha256(b'original')], ['resource.pak', 8, sha256(b'resource')]])
            with prepare_browser(source, sha256(b'original'), expected_tree) as prepared:
                self.assertEqual(len(prepared.identities), 2)
            resource.write_bytes(b'modified')
            with self.assertRaisesRegex(ValueError, 'browser_bundle_digest_mismatch'):
                with prepare_browser(source, sha256(b'original'), expected_tree):
                    self.fail('changed resource reached launch boundary')

    def test_descriptor_mismatch_fails_before_read(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'chrome'; source.write_bytes(b'original')
            other = Path(root) / 'other'; other.write_bytes(b'replaced')
            original_open = os.open
            def substitute(file, *args, **kwargs):
                return original_open(other if Path(file) == source else file, *args, **kwargs)
            with patch('browser_runtime.os.open', side_effect=substitute), patch('browser_runtime.os.read') as reader:
                with self.assertRaisesRegex(ValueError, 'browser_changed_during_hash'):
                    file_digest(source)
                reader.assert_not_called()

    def test_launch_uses_verified_copy_when_installation_is_replaced(self):
        with tempfile.TemporaryDirectory() as root:
            source_dir = Path(root) / 'installation'; source_dir.mkdir()
            source = source_dir / 'chrome'; source.write_bytes(b'original'); source.chmod(0o700)
            launched = []
            class Browser:
                version = 'synthetic-not-a-browser'
                closed = False
                async def close(self): self.closed = True
                def is_connected(self): return not self.closed
            browser = Browser()
            async def launch(**kwargs):
                source.write_bytes(b'replaced')
                selected = Path(kwargs['executable_path'])
                launched.append(selected)
                self.assertNotEqual(selected, source)
                self.assertEqual(selected.read_bytes(), b'original')
                return browser
            runtime = SimpleNamespace(chromium=SimpleNamespace(launch=launch))
            class Manager:
                async def __aenter__(self): return runtime
                async def __aexit__(self, *args): return False
            modules = {'playwright': SimpleNamespace(), 'playwright.async_api': SimpleNamespace(async_playwright=Manager)}
            async def probe():
                event = asyncio.Event(); event.set()
                return await run_proof(Path(root) / 'output', chromium_path=source, expected_sha256=sha256(b'original'), cancel_event=event)
            with patch.dict(sys.modules, modules), patch('fixture_proof.importlib.metadata.version', return_value='1.57.0'):
                report = asyncio.run(probe())
            self.assertEqual(report['status'], 'cancelled')
            self.assertEqual(report['runtime']['browser_executable_sha256'], sha256(b'original'))
            self.assertTrue(report['runtime']['launch_copy_verified_after'])
            self.assertTrue(report['runtime_copy_removed'])
            self.assertTrue(browser.closed)
            self.assertEqual(len(launched), 1)

    def test_active_cancellation_occurs_after_first_case_and_closes_context(self):
        with tempfile.TemporaryDirectory() as root:
            class Page:
                url = 'about:blank#evidence'
                def set_default_timeout(self, value): pass
                async def set_content(self, *args, **kwargs): pass
                def locator(self, value): return self
                async def inner_text(self): return 'Governed work fixture'
                def get_by_role(self, *args, **kwargs): return self
                async def click(self): pass
                async def evaluate(self, code): return False
                async def screenshot(self, **kwargs): return b'synthetic-not-a-png'
            class Context:
                closed = False
                async def route(self, *args): pass
                async def new_page(self): return Page()
                async def close(self): self.closed = True
            context = Context()
            class Browser:
                async def new_context(self, **kwargs): return context
            async def probe():
                event, report = asyncio.Event(), initial_report()
                work = asyncio.create_task(exercise(Browser(), Path(root), report, cancel_after_first_case=True, cancel_event=event))
                await asyncio.wait_for(event.wait(), 2)
                self.assertFalse(work.done())
                self.assertEqual(len(report['cases']), 1)
                work.cancel()
                with self.assertRaises(asyncio.CancelledError): await work
                self.assertTrue(context.closed)
                self.assertEqual(report['cancellation_stage'], 'after_first_screenshot')
            asyncio.run(probe())

    def test_committed_lock_has_all_hashed_python_dependencies(self):
        root = Path(__file__).parent
        lock = json.loads((root / 'browser-runtime-lock.json').read_text())
        text = (root / 'requirements-proof.txt').read_text()
        for name, version in lock['dependencies'].items():
            self.assertRegex(text, name + '==' + version.replace('.', r'\.') + r' --hash=sha256:[a-f0-9]{64}')
        self.assertEqual(lock['browser']['playwright_revision'], '1200')
        self.assertRegex(lock['browser']['tree_sha256'], r'^[a-f0-9]{64}$')
        self.assertFalse(lock['provenance']['publisher_signature_verified'])

    def test_default_runtime_rejects_dependency_drift(self):
        with patch('fixture_proof.platform.system', return_value='Linux'), patch('fixture_proof.platform.machine', return_value='x86_64'), patch('fixture_proof.sys.version_info', (3,12,10)), patch('fixture_proof.importlib.metadata.version', return_value='unexpected'):
            with self.assertRaisesRegex(ValueError, 'runtime_dependency_mismatch'):
                qualification_lock()

if __name__ == '__main__': unittest.main()
