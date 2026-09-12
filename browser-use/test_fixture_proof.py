"""Provider/browser-free boundary tests; real browser execution is a separate gate."""
import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from fixture_proof import FIXTURE, PROBE_URL, VIEWPORTS, abort_external, initial_report, runtime_digest, sha256, write_new

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

if __name__ == '__main__': unittest.main()
