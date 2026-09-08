// Compile against the installed SDK, without starting a client or model.
import type { Options, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAgentSdkGatingAdapter } from '../agoragentic_claude_agent.ts';
const adapter = new ClaudeAgentSdkGatingAdapter();
export const callback: HookCallback = adapter.preToolUse.bind(adapter);
export const options: Pick<Options, 'hooks'> = { hooks: adapter.sdkHooks() };
