"""Installed Python SDK registration/control-wire contract; no CLI or model.

The SDK is real. Only its CLI transport peer is synthetic. This checks that a
registered callback's deny survives SDK dispatch/serialization, not that a live
Claude Code process enforces it. Private SDK seams are deliberately version pinned.
"""
import asyncio
import json
from importlib.metadata import version
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agoragentic_claude_agent import ClaudeAgentSdkGatingAdapter
from claude_agent_sdk import ClaudeAgentOptions, HookMatcher
from claude_agent_sdk._internal.client import InternalClient
from claude_agent_sdk._internal.query import Query
from claude_agent_sdk._internal.transport import Transport


class WirePeer(Transport):
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.responses = asyncio.Queue()
        self.registration = None

    async def connect(self): pass
    async def end_input(self): pass
    def is_ready(self): return True
    async def close(self): pass

    async def write(self, data):
        frame = json.loads(data)
        if frame['type'] == 'control_request':
            assert frame['request']['subtype'] == 'initialize'
            self.registration = frame['request']['hooks']['PreToolUse']
            await self.incoming.put({'type': 'control_response', 'response': {
                'subtype': 'success', 'request_id': frame['request_id'], 'response': {}}})
        else:
            await self.responses.put(frame['response'])

    async def read_messages(self):
        while True:
            yield await self.incoming.get()


class SdkContract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Windows asyncio creates a loopback socketpair while constructing its loop.
        # Install the I/O guard after loop construction, before any SDK work.
        guard = patch('socket.socket.connect', side_effect=AssertionError('network forbidden'))
        guard.start()
        self.addCleanup(guard.stop)

    async def test_registered_hook_denial_survives_real_sdk_wire_dispatch(self):
        self.assertEqual(version('claude-agent-sdk'), '0.2.139')
        options = ClaudeAgentOptions(hooks=ClaudeAgentSdkGatingAdapter().sdk_hooks())
        self.assertIsInstance(options.hooks['PreToolUse'][0], HookMatcher)
        peer = WirePeer()
        query = Query(peer, True, hooks=InternalClient()._convert_hooks_to_internal_format(options.hooks))
        await query.start()
        try:
            await asyncio.wait_for(query.initialize(), 5)
            self.assertEqual(len(peer.registration), 1)
            self.assertIsNone(peer.registration[0]['matcher'])
            callback_id, = peer.registration[0]['hookCallbackIds']
            for name, reason in [('agoragentic_execute', 'Approval_Required'),
                                 ('Bash', 'Unsupported_Tool'), ('agoragentic_match', None)]:
                await peer.incoming.put({'type': 'control_request', 'request_id': name, 'request': {
                    'subtype': 'hook_callback', 'callback_id': callback_id, 'tool_use_id': 'fixture',
                    'input': {'hook_event_name': 'PreToolUse', 'tool_name': name,
                              'tool_input': {'constraints': {'max_cost_usdc': '0.1'}}}}})
                response = await asyncio.wait_for(peer.responses.get(), 5)
                self.assertEqual(response['subtype'], 'success')
                self.assertEqual(response['request_id'], name)
                if reason:
                    self.assertEqual(response['response']['hookSpecificOutput'], {
                        'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                        'permissionDecisionReason': reason})
                else:
                    self.assertEqual(response['response'], {})
        finally:
            await query.close()
            query.close_receive_stream()


if __name__ == '__main__':
    unittest.main(verbosity=2)
