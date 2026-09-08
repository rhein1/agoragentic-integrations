import { types as utilTypes } from 'node:util';

import { isRiskForkFrameworkToolAdapter } from '../framework-tool-adapter.mjs';

export const LANGCHAIN_RISK_FORK_TOOL_SCHEMA =
  'agoragentic.risk-fork.langchain-tool-adapter.v1';

function readEnforcement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError('LangChain Risk Fork adapter input must be a plain data-only object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0
    || Object.keys(descriptors).some((key) => key !== 'enforcement')
    || !descriptors.enforcement?.enumerable
    || descriptors.enforcement.get
    || descriptors.enforcement.set) {
    throw new TypeError('LangChain Risk Fork adapter input must contain only enforcement');
  }
  const enforcement = descriptors.enforcement.value;
  if (!isRiskForkFrameworkToolAdapter(enforcement)
    || enforcement.status.framework !== 'langchain') {
    throw new TypeError(
      'LangChain adapter requires an exact LangChain Risk Fork enforcement adapter',
    );
  }
  return enforcement;
}

export function createLangChainRiskForkTool(input = {}) {
  const enforcement = readEnforcement(input);
  return Object.freeze({
    schema: LANGCHAIN_RISK_FORK_TOOL_SCHEMA,
    mode: 'tool_handler_boundary',
    status: enforcement.status,
    handler: async (argumentsValue = {}, _runnableConfig = undefined) => (
      enforcement.invoke(argumentsValue)
    ),
  });
}
