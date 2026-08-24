import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from agoragentic.governance import (
    GovernanceError,
    create_default_policy,
    evaluate_policy,
    govern,
    load_policy,
)


def receipt_files(root):
    return list((Path(root) / ".agoragentic" / "receipts").glob("*.json"))


def read_only_receipt(root):
    files = receipt_files(root)
    assert len(files) == 1
    raw = files[0].read_text(encoding="utf-8")
    return raw, json.loads(raw)


class GovernanceTests(unittest.TestCase):
    def test_shared_json_compatible_policy_file_loads(self):
        with tempfile.TemporaryDirectory() as root:
            policy = create_default_policy()
            policy["actions"]["memory.read"] = {"decision": "allow"}
            Path(root, "agoragentic.yaml").write_text(
                json.dumps(policy),
                encoding="utf-8",
            )

            loaded = load_policy(cwd=root)

            self.assertEqual(loaded, policy)
            self.assertTrue(evaluate_policy(loaded, "memory.read")["execute"])

    def test_ask_requires_approval_and_deny_cannot_be_overridden(self):
        policy = create_default_policy()
        ask = evaluate_policy(policy, "process.run")
        self.assertFalse(ask["execute"])
        self.assertEqual(ask["reason"], "explicit_approval_required")

        policy["actions"]["process.run"]["decision"] = "deny"
        denied = evaluate_policy(policy, "process.run", approved=True)
        self.assertFalse(denied["execute"])
        self.assertEqual(denied["reason"], "policy_denied")

    def test_sync_tool_executes_after_approval_with_shape_only_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            policy = create_default_policy()
            policy["actions"]["email.send"] = {"decision": "ask"}
            calls = []

            def tool(*, payload):
                calls.append(payload)
                return {"delivered": True, "secret": payload}

            safe_tool = govern(
                tool,
                action="email.send",
                policy=policy,
                approve=lambda request: request["action"] == "email.send",
                cwd=root,
            )
            secret = "private-message"
            self.assertEqual(safe_tool(payload=secret)["secret"], secret)
            self.assertEqual(calls, [secret])

            raw, receipt = read_only_receipt(root)
            self.assertEqual(receipt["classification"], "local_tool_evidence")
            self.assertEqual(receipt["evidence"]["keyword_names"], ["payload"])
            self.assertEqual(receipt["evidence"]["result"], {
                "type": "object",
                "keys": ["delivered", "secret"],
            })
            self.assertFalse(receipt["proof_scope"]["payment"])
            self.assertNotIn(secret, raw)

    def test_blocked_tool_never_runs_and_still_receipts_the_decision(self):
        with tempfile.TemporaryDirectory() as root:
            policy = create_default_policy()
            policy["actions"]["email.send"] = {"decision": "deny"}
            calls = []
            safe_tool = govern(
                lambda: calls.append(True),
                action="email.send",
                policy=policy,
                approved=True,
                cwd=root,
            )
            with self.assertRaises(GovernanceError) as raised:
                safe_tool()
            self.assertEqual(raised.exception.code, "policy_denied")
            self.assertEqual(calls, [])
            _, receipt = read_only_receipt(root)
            self.assertEqual(receipt["outcome"], "not_executed")

    def test_receipt_path_escape_fails_before_tool_execution(self):
        with tempfile.TemporaryDirectory() as root:
            policy = create_default_policy()
            policy["receipts"]["directory"] = "../outside-receipts"
            calls = []
            safe_tool = govern(
                lambda: calls.append(True),
                action="process.run",
                policy=policy,
                approved=True,
                cwd=root,
            )
            with self.assertRaises(GovernanceError) as raised:
                safe_tool()
            self.assertEqual(raised.exception.code, "path_outside_project")
            self.assertEqual(calls, [])

    def test_owner_authority_cannot_be_delegated(self):
        policy = create_default_policy()
        policy["authority"]["spend"] = "agent"
        with self.assertRaisesRegex(GovernanceError, "authority.spend must remain owner_only"):
            evaluate_policy(policy, "process.run")

    def test_tool_failure_is_receipted_without_error_message(self):
        with tempfile.TemporaryDirectory() as root:
            policy = create_default_policy()
            policy["actions"]["tool.fail"] = {"decision": "allow"}
            secret = "sensitive failure details"

            def failing_tool():
                raise ValueError(secret)

            safe_tool = govern(failing_tool, action="tool.fail", policy=policy, cwd=root)
            with self.assertRaisesRegex(ValueError, secret):
                safe_tool()
            raw, receipt = read_only_receipt(root)
            self.assertEqual(receipt["outcome"], "failed")
            self.assertEqual(receipt["evidence"]["error_code"], "ValueError")
            self.assertNotIn(secret, raw)

    def test_evidence_failure_does_not_reclassify_completed_tool_as_failed(self):
        with tempfile.TemporaryDirectory() as root:
            policy = create_default_policy()
            policy["actions"]["tool.run"] = {"decision": "allow"}
            calls = []

            def evidence(_result):
                raise RuntimeError("private evidence error")

            safe_tool = govern(
                lambda: calls.append(True) or {"ok": True},
                action="tool.run",
                policy=policy,
                evidence=evidence,
                cwd=root,
            )
            with self.assertRaises(GovernanceError) as raised:
                safe_tool()
            self.assertEqual(raised.exception.code, "evidence_failed")
            self.assertEqual(calls, [True])
            raw, receipt = read_only_receipt(root)
            self.assertEqual(receipt["outcome"], "completed_evidence_failed")
            self.assertNotIn("private evidence error", raw)


class AsyncGovernanceTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_tool_and_async_approval_share_the_same_boundary(self):
        with tempfile.TemporaryDirectory() as root:
            policy = create_default_policy()
            policy["actions"]["memory.read"] = {"decision": "ask"}
            calls = []

            async def approve(request):
                await asyncio.sleep(0)
                return request["action"] == "memory.read"

            async def tool(query):
                calls.append(query)
                await asyncio.sleep(0)
                return [query]

            safe_tool = govern(
                tool,
                action="memory.read",
                policy=policy,
                approve=approve,
                cwd=root,
            )
            self.assertEqual(await safe_tool("refund"), ["refund"])
            self.assertEqual(calls, ["refund"])
            raw, receipt = read_only_receipt(root)
            self.assertEqual(receipt["evidence"]["result"], {"type": "array", "length": 1})
            self.assertNotIn("refund", raw)


if __name__ == "__main__":
    unittest.main()
