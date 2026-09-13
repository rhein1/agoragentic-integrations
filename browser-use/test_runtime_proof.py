"""No browser/provider dependency: enforce actual bytes written, not just errors."""
import hashlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import browser_runtime as runtime


class RuntimeBudgetTests(unittest.TestCase):
    def test_aggregate_rejection_never_writes_past_ceiling_and_cleans(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'chrome'
            source.write_bytes(b'123456')
            (Path(root) / 'resource').write_bytes(b'abcdef')
            observed, removed = [], []
            cleanup = runtime.cleanup_owned
            def inspect_before_cleanup(directory):
                observed.append(sum(p.stat().st_size for p in directory.rglob('*') if p.is_file()))
                cleanup(directory)
                removed.append(not directory.exists())
            with patch.object(runtime, 'MAX_TOTAL', 8), patch.object(runtime, 'cleanup_owned', side_effect=inspect_before_cleanup):
                with self.assertRaisesRegex(ValueError, 'browser_bundle_size_limit'):
                    with runtime.prepare_browser(source, hashlib.sha256(b'123456').hexdigest()):
                        self.fail('oversized bundle reached launch')
            self.assertEqual(observed, [6])
            self.assertEqual(removed, [True])

    def test_exact_aggregate_budget_and_empty_trailing_resource_succeed(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'chrome'; source.write_bytes(b'123456')
            (Path(root) / 'resource').write_bytes(b'ab')
            (Path(root) / 'zero').write_bytes(b'')
            with patch.object(runtime, 'MAX_TOTAL', 8):
                with runtime.prepare_browser(source, hashlib.sha256(b'123456').hexdigest()) as prepared:
                    self.assertEqual(prepared.total_bytes, 8)
                    prepared.verify()

    def test_oversized_descriptor_is_refused_before_reading_or_writing(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'chrome'; source.write_bytes(b'123')
            sink = io.BytesIO()
            with patch.object(runtime.os, 'read') as reader:
                with self.assertRaisesRegex(ValueError, 'browser_bundle_size_limit'):
                    runtime.file_digest(source, sink, remaining_bytes=2)
                reader.assert_not_called()
            self.assertEqual(sink.getvalue(), b'')

    def test_growth_probe_cannot_write_the_over_budget_byte(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'chrome'; source.write_bytes(b'12345678')
            sink = io.BytesIO()
            with patch.object(runtime.os, 'read', side_effect=[b'1234', b'5678', b'9']) as reader:
                with self.assertRaisesRegex(ValueError, 'browser_bundle_size_limit'):
                    runtime.file_digest(source, sink, remaining_bytes=8)
            self.assertEqual(sink.getvalue(), b'12345678')
            self.assertEqual(reader.call_args.args[1], 1)

    def test_identity_change_after_copy_still_rejects(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / 'chrome'; source.write_bytes(b'12345678')
            class MutatingSink(io.BytesIO):
                def write(self, data):
                    result = super().write(data)
                    info = source.stat()
                    os.utime(source, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000000))
                    return result
            with self.assertRaisesRegex(ValueError, 'browser_changed_during_hash'):
                runtime.file_digest(source, MutatingSink(), remaining_bytes=8)

    def test_invalid_remaining_budget_is_rejected_before_open(self):
        for value in [-1, True, 1.5, '8']:
            with patch.object(runtime.os, 'open') as opener:
                with self.assertRaisesRegex(ValueError, 'invalid_browser_budget'):
                    runtime.file_digest(Path('unused'), remaining_bytes=value)
                opener.assert_not_called()


if __name__ == '__main__':
    unittest.main()
