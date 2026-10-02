import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from agoragentic.governance import GovernanceError, create_default_policy, govern


async def observe_cancellation(awaitable, observed):
    # Python 3.8 Task.result/await may create a fresh CancelledError. Observe the
    # wrapper boundary inside the task to test SDK identity and metadata.
    try:
        return await awaitable
    except asyncio.CancelledError as exc:
        observed.append(exc)
        raise


class CancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_outer_persistence_failure_retains_inner_notification_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            policy = create_default_policy()
            policy["default_decision"] = "allow"
            inner_root = Path(root, "inner")
            inner_root.mkdir()
            outer_root = Path(root, "outer")
            outer_root.mkdir()
            entered = asyncio.Event()
            delivered = []
            cancellations = []

            async def inner_tool():
                Path(inner_root, "effect.txt").write_text("one bounded write")

            async def notify(receipt):
                delivered.append(receipt)
                entered.set()
                try:
                    await asyncio.Future()
                except asyncio.CancelledError as exc:
                    cancellations.append(exc)
                    raise

            inner = govern(inner_tool, action="inner.write", policy=policy,
                           cwd=inner_root, on_receipt=notify)

            async def outer_tool():
                await inner()

            observed = []
            task = asyncio.create_task(observe_cancellation(govern(outer_tool, action="outer.run", policy=policy,
                                             cwd=outer_root)(), observed))
            await asyncio.wait_for(entered.wait(), 2)
            directory = outer_root / ".agoragentic" / "receipts"
            directory.rmdir()
            directory.write_text("obstruction")
            task.cancel()
            with self.assertRaises(asyncio.CancelledError) as raised:
                await task
            self.assertTrue(task.cancelled())
            self.assertIs(observed[0], cancellations[0])
            self.assertEqual(observed[0].agoragentic_receipt, delivered[0])
            self.assertEqual(delivered[0]["action"], "inner.write")
            persisted = json.loads((inner_root / delivered[0]["path"]).read_text())
            self.assertEqual(persisted["receipt_id"], delivered[0]["receipt_id"])
            self.assertEqual(persisted["outcome"], "completed")
            self.assertEqual(observed[0].agoragentic_receipt_error, {
                "code": "receipt_persistence_failed", "phase": "tool",
                "action": "outer.run", "outcome": "cancelled_effect_uncertain",
            })
            self.assertEqual(len(list(Path(root).rglob("*.json"))), 1)

    async def test_cancellation_survives_receipt_persistence_failure_in_each_phase(self):
        for phase in ("approval", "tool", "evidence"):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as root:
                policy = create_default_policy()
                entered = asyncio.Event()
                cancellations = []

                async def pause(at):
                    if at == phase:
                        entered.set()
                        try:
                            await asyncio.Future()
                        except asyncio.CancelledError as exc:
                            cancellations.append(exc)
                            raise

                async def approve(request):
                    await pause("approval")
                    return True

                async def tool():
                    Path(root, "effect.txt").write_text("one bounded write")
                    await pause("tool")
                    return "private-result"

                async def evidence(result):
                    await pause("evidence")
                    return result

                observed = []
                task = asyncio.create_task(observe_cancellation(govern(tool, action="file.write", policy=policy,
                    cwd=root, approve=approve, evidence=evidence)(), observed))
                await asyncio.wait_for(entered.wait(), 2)
                directory = Path(root, ".agoragentic", "receipts")
                directory.rmdir()  # Verified empty fixture directory, inside TemporaryDirectory.
                directory.write_text("private-obstruction")
                task.cancel()
                with self.assertRaises(asyncio.CancelledError) as raised:
                    await task
                self.assertTrue(task.cancelled())
                self.assertIs(observed[0], cancellations[0])
                self.assertIsNone(observed[0].agoragentic_receipt)
                self.assertEqual(observed[0].agoragentic_receipt_error, {
                    "code": "receipt_persistence_failed", "phase": phase, "action": "file.write",
                    "outcome": {"approval": "approval_failed", "tool": "cancelled_effect_uncertain",
                                "evidence": "completed_evidence_failed"}[phase],
                })
                self.assertEqual(Path(root, "effect.txt").exists(), phase != "approval")
                self.assertEqual(directory.read_text(), "private-obstruction")
                self.assertEqual(list(Path(root).rglob("*.json")), [])
                marker = json.dumps(observed[0].agoragentic_receipt_error)
                self.assertNotIn("private-", marker)
                self.assertNotIn(root, marker)

    async def test_async_callback_failures_and_disabled_receipts(self):
        for enabled in (True, False):
            for phase in ("approval", "evidence", "notification"):
                with self.subTest(enabled=enabled, phase=phase), tempfile.TemporaryDirectory() as root:
                    policy = create_default_policy()
                    calls = []
                    delivered = []

                    async def fail(at):
                        if phase == at:
                            raise RuntimeError("private-callback-error")

                    async def approve(request):
                        await fail("approval")
                        return True

                    async def tool(payload):
                        calls.append(True)
                        return payload

                    async def evidence(result):
                        await fail("evidence")
                        return result

                    async def notify(receipt):
                        delivered.append(receipt)
                        await fail("notification")

                    wrapped = govern(tool, action="tool.run", policy=policy, cwd=root,
                                     receipts=enabled, approve=approve, evidence=evidence, on_receipt=notify)
                    with self.assertRaises(GovernanceError) as raised:
                        await wrapped("private-payload")
                    self.assertEqual(len(calls), 0 if phase == "approval" else 1)
                    files = list(Path(root, ".agoragentic/receipts").glob("*.json"))
                    self.assertEqual(len(files), int(enabled))
                    if enabled:
                        raw = files[0].read_text()
                        receipt = json.loads(raw)
                        self.assertEqual(receipt["outcome"], {"approval": "approval_failed",
                            "evidence": "completed_evidence_failed", "notification": "completed"}[phase])
                        self.assertEqual(raised.exception.receipt["receipt_id"], receipt["receipt_id"])
                        self.assertNotIn("private-", raw)
                        if phase == "notification":
                            self.assertEqual(delivered[0]["receipt_id"], receipt["receipt_id"])
                    else:
                        self.assertIsNone(raised.exception.receipt)
                        self.assertFalse(Path(root, ".agoragentic").exists())

    async def test_integrated_policy_flow(self):
        with tempfile.TemporaryDirectory() as root:
            policy = create_default_policy()
            policy["actions"] = {"*": {"decision": "deny"}, "file.read": {"decision": "allow"},
                                 "file.write": {"decision": "ask"}}
            effects = []

            async def read():
                return "ready"

            async def write():
                effects.append(True)
                Path(root, "bounded.txt").write_text("one")
                return "private-result"

            self.assertEqual(await govern(read, action="file.read", policy=policy, cwd=root)(), "ready")
            with self.assertRaises(GovernanceError):
                await govern(write, action="file.write", policy=policy, cwd=root)()
            self.assertEqual(effects, [])
            entered = asyncio.Event()
            approved = asyncio.Future()

            async def approve(request):
                entered.set()
                return await approved

            task = asyncio.create_task(govern(write, action="file.write", policy=policy,
                                             cwd=root, approve=approve)())
            await asyncio.wait_for(entered.wait(), 2)
            self.assertEqual(effects, [])
            approved.set_result(True)
            self.assertEqual(await task, "private-result")
            policy["actions"]["file.write"] = {"decision": "deny"}
            with self.assertRaises(GovernanceError):
                await govern(write, action="file.write", policy=policy, cwd=root, approved=True,
                             approve=lambda _: self.fail("deny bypass"))()
            self.assertEqual(effects, [True])
            receipts = [json.loads(p.read_text()) for p in Path(root, ".agoragentic/receipts").glob("*.json")]
            self.assertEqual(len(receipts), 4)
            self.assertNotIn("private-result", json.dumps(receipts))

    async def test_phase_cancellation_persists_one_receipt_and_propagates(self):
        phases = ("approval", "tool", "evidence", "notification")
        for phase, enabled in ((phase, enabled) for phase in phases for enabled in (True, False)):
            with self.subTest(phase=phase, enabled=enabled), tempfile.TemporaryDirectory() as root:
                policy = create_default_policy()
                policy["actions"]["file.write"] = {"decision": "ask"}
                entered = asyncio.Event()
                delivered = []

                async def pause(at):
                    if at == phase:
                        entered.set()
                        await asyncio.Future()

                async def approve(request):
                    await pause("approval")
                    return True

                async def tool(payload):
                    Path(root, "effect.txt").write_text("one bounded write")
                    await pause("tool")
                    return payload

                async def evidence(result):
                    await pause("evidence")
                    return result

                async def notify(receipt):
                    delivered.append(receipt)
                    await pause("notification")

                wrapped = govern(tool, action="file.write", policy=policy, cwd=root,
                                 receipts=enabled, approve=approve, evidence=evidence, on_receipt=notify)
                observed = []
                task = asyncio.create_task(observe_cancellation(wrapped("private-payload-and-error"), observed))
                await asyncio.wait_for(entered.wait(), 2)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError) as raised:
                    await task
                self.assertTrue(task.cancelled())
                files = list(Path(root, ".agoragentic/receipts").glob("*.json"))
                if not enabled:
                    self.assertEqual(files, [])
                    self.assertIsNone(observed[0].agoragentic_receipt)
                    self.assertFalse(Path(root, ".agoragentic").exists())
                    continue
                self.assertEqual(len(files), 1)
                raw = files[0].read_text()
                receipt = json.loads(raw)
                self.assertEqual(receipt["outcome"], {
                    "approval": "approval_failed", "tool": "cancelled_effect_uncertain",
                    "evidence": "completed_evidence_failed", "notification": "completed",
                }[phase])
                self.assertEqual(Path(root, "effect.txt").exists(), phase != "approval")
                self.assertNotIn("private-payload-and-error", raw)
                self.assertEqual(observed[0].agoragentic_receipt["receipt_id"], receipt["receipt_id"])
                for flag in ("provider_execution", "payment", "settlement"):
                    self.assertFalse(receipt["proof_scope"][flag])
                if phase == "notification":
                    self.assertEqual(delivered[0]["receipt_id"], receipt["receipt_id"])
