import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from agoragentic.governance import GovernanceError, create_default_policy, govern


class HostileCancellation(asyncio.CancelledError):
    def __setattr__(self, name, value):
        if name.startswith('agoragentic_'):
            raise RuntimeError('private-metadata-error')
        super().__setattr__(name, value)

    @property
    def agoragentic_receipt(self):
        raise RuntimeError('private-property-error')


def policy():
    result = create_default_policy()
    result['default_decision'] = 'allow'
    return result


class ReceiptIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def test_original_failures_survive_storage_failure_sync_and_async(self):
        for asynchronous in (False, True):
            for phase in ('approval', 'tool', 'evidence'):
                with self.subTest(asynchronous=asynchronous, phase=phase), tempfile.TemporaryDirectory() as root:
                    p = policy()
                    p['default_decision'] = 'ask'
                    original = RuntimeError('private-original')
                    effects = []

                    def fail(at):
                        if at == phase:
                            directory = Path(root, '.agoragentic/receipts')
                            directory.rmdir()
                            directory.write_text('private-obstruction')
                            raise original

                    def tool():
                        effects.append(1)
                        fail('tool')
                        return 'private-result'

                    async def async_tool():
                        return tool()

                    wrapped = govern(async_tool if asynchronous else tool, action='file.write',
                        policy=p, cwd=root, approve=lambda _: fail('approval') or True,
                        evidence=lambda _: fail('evidence'))
                    with self.assertRaises(RuntimeError) as raised:
                        if asynchronous:
                            await wrapped()
                        else:
                            wrapped()
                    error = raised.exception
                    self.assertIs(error if phase == 'tool' else error.__cause__, original)
                    self.assertIsNone(error.agoragentic_receipt)
                    self.assertEqual(error.agoragentic_receipt_error, {
                        'code': 'receipt_persistence_failed', 'phase': phase, 'action': 'file.write',
                        'outcome': {'approval': 'approval_failed', 'tool': 'failed',
                                    'evidence': 'completed_evidence_failed'}[phase]})
                    self.assertEqual(len(effects), int(phase != 'approval'))
                    self.assertEqual(list(Path(root).rglob('*.json')), [])

    async def test_hostile_cancellation_preserved_in_all_phases(self):
        for phase in ('approval', 'tool', 'evidence', 'notification'):
            for obstruct in (False, True):
                with self.subTest(phase=phase, obstruct=obstruct), tempfile.TemporaryDirectory() as root:
                    p = policy()
                    p['default_decision'] = 'ask'
                    original = HostileCancellation('private-cancel')
                    effects = []

                    async def fail(at):
                        if phase == at:
                            if obstruct and phase != 'notification':
                                directory = Path(root, '.agoragentic/receipts')
                                directory.rmdir()
                                directory.write_text('private-obstruction')
                            raise original

                    async def approve(_):
                        await fail('approval')
                        return True

                    async def tool():
                        effects.append(1)
                        await fail('tool')
                        return 'private-result'

                    async def evidence(_):
                        await fail('evidence')

                    async def notify(_):
                        await fail('notification')

                    with self.assertRaises(asyncio.CancelledError) as raised:
                        await govern(tool, action='file.write', policy=p, cwd=root,
                                     approve=approve, evidence=evidence, on_receipt=notify)()
                    self.assertIs(raised.exception, original)
                    self.assertEqual(len(effects), int(phase != 'approval'))
                    receipts = [json.loads(f.read_text()) for f in Path(root).rglob('*.json')]
                    self.assertEqual(len(receipts), int(not obstruct or phase == 'notification'))
                    if receipts:
                        self.assertEqual(receipts[0]['outcome'], {'approval': 'approval_failed',
                            'tool': 'cancelled_effect_uncertain', 'evidence': 'completed_evidence_failed',
                            'notification': 'completed'}[phase])
                        self.assertNotIn('private-', json.dumps(receipts))

    async def test_nested_cancellation_keeps_inner_receipt_with_successful_outer_write(self):
        with tempfile.TemporaryDirectory() as root:
            original = asyncio.CancelledError('private-cancel')

            async def tool():
                return 'done'

            async def notify(receipt):
                receipt['receipt_id'] = 'nonexistent'
                receipt['proof_scope']['payment'] = True
                raise original

            inner = govern(tool, action='inner.run', policy=policy(), cwd=root, on_receipt=notify)
            outer = govern(inner, action='outer.run', policy=policy(), cwd=root)
            with self.assertRaises(asyncio.CancelledError) as raised:
                await outer()
            self.assertIs(raised.exception, original)
            receipts = [json.loads(f.read_text()) for f in Path(root).rglob('*.json')]
            self.assertEqual(len(receipts), 2)
            self.assertEqual(original.agoragentic_receipt['action'], 'inner.run')
            self.assertFalse(original.agoragentic_receipt['proof_scope']['payment'])
            enclosing = original.agoragentic_enclosing_receipts
            self.assertEqual([r['action'] for r in enclosing], ['outer.run'])
            self.assertEqual(enclosing[0]['outcome'], 'cancelled_effect_uncertain')
            self.assertEqual({r['receipt_id'] for r in receipts},
                             {original.agoragentic_receipt['receipt_id'], enclosing[0]['receipt_id']})

    async def test_nested_notification_errors_and_mutation_sync_and_async(self):
        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous), tempfile.TemporaryDirectory() as root:
                def notify(receipt):
                    receipt['receipt_id'] = 'nonexistent'
                    receipt['action'] = 'wrong.action'
                    receipt['proof_scope']['payment'] = True
                    raise RuntimeError('private-callback')

                async def async_tool():
                    return 'done'

                inner = govern(async_tool if asynchronous else lambda: 'done', action='inner.run',
                               policy=policy(), cwd=root, on_receipt=notify)
                outer = govern(inner, action='outer.run', policy=policy(), cwd=root)
                with self.assertRaises(GovernanceError) as raised:
                    if asynchronous:
                        await outer()
                    else:
                        outer()
                error = raised.exception
                self.assertEqual(error.code, 'receipt_callback_failed')
                self.assertEqual(error.receipt['action'], 'inner.run')
                self.assertIs(error.agoragentic_receipt, error.receipt)
                self.assertFalse(error.receipt['proof_scope']['payment'])
                self.assertEqual([r['action'] for r in error.agoragentic_enclosing_receipts], ['outer.run'])
                receipts = [json.loads(f.read_text()) for f in Path(root).rglob('*.json')]
                self.assertEqual(len(receipts), 2)
                self.assertIn(error.receipt['receipt_id'], [r['receipt_id'] for r in receipts])
