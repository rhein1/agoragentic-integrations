import { types as utilTypes } from 'node:util';

import { isRiskForkFrameworkToolAdapter } from '../framework-tool-adapter.mjs';

export const OPENAI_AGENTS_RISK_FORK_TOOL_SCHEMA =
  'agoragentic.risk-fork.openai-agents-tool-adapter.v1';

function requireEnforcement(value) {
  if (!isRiskForkFrameworkToolAdapter(value)
    || value.status.framework !== 'openai-agents') {
    throw new TypeError(
      'OpenAI Agents adapter requires an exact OpenAI Agents Risk Fork enforcement adapter',
    );
  }
  return value;
}

function readInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError('OpenAI Agents Risk Fork adapter input must be a plain data-only object');
  }
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0
    || Object.keys(descriptors).some((key) => key !== 'enforcement')
    || !descriptors.enforcement?.enumerable
    || descriptors.enforcement.get
    || descriptors.enforcement.set) {
    throw new TypeError('OpenAI Agents Risk Fork adapter input must contain only enforcement');
  }
  return descriptors.enforcement.value;
}

export function createOpenAIAgentsRiskForkTool(input = {}) {
  const enforcement = requireEnforcement(readInput(input));
  return Object.freeze({
    schema: OPENAI_AGENTS_RISK_FORK_TOOL_SCHEMA,
    mode: 'function_tool_execute_boundary',
    status: enforcement.status,
    needsApproval: true,
    execute: async (argumentsValue = {}, _runContext = undefined) => (
      enforcement.invoke(argumentsValue)
    ),
  });
}
