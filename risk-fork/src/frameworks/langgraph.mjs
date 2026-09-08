import { types as utilTypes } from 'node:util';

import { isRiskForkFrameworkToolAdapter } from '../framework-tool-adapter.mjs';

export const LANGGRAPH_RISK_FORK_NODE_SCHEMA =
  'agoragentic.risk-fork.langgraph-node-adapter.v1';

const SAFE_STATE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function normalizeInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError('LangGraph Risk Fork adapter input must be a plain data-only object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const prototype = Object.getPrototypeOf(value);
  const allowed = new Set(['enforcement', 'input_key', 'output_key']);
  if ((prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0
    || Object.keys(descriptors).some((key) => !allowed.has(key))
    || Object.values(descriptors).some((descriptor) => (
      !descriptor.enumerable || descriptor.get || descriptor.set
    ))) {
    throw new TypeError('LangGraph Risk Fork adapter input contains unsupported properties');
  }
  const enforcement = descriptors.enforcement?.value;
  if (!isRiskForkFrameworkToolAdapter(enforcement)
    || enforcement.status.framework !== 'langgraph') {
    throw new TypeError(
      'LangGraph adapter requires an exact LangGraph Risk Fork enforcement adapter',
    );
  }
  const inputKey = descriptors.input_key?.value ?? 'tool_input';
  const outputKey = descriptors.output_key?.value ?? 'risk_fork_result';
  if (typeof inputKey !== 'string' || !SAFE_STATE_KEY.test(inputKey)
    || typeof outputKey !== 'string' || !SAFE_STATE_KEY.test(outputKey)
    || inputKey === outputKey) {
    throw new TypeError('LangGraph input_key and output_key must be distinct safe state keys');
  }
  return { enforcement, inputKey, outputKey };
}

function readStateArguments(state, inputKey) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || utilTypes.isProxy(state)) {
    throw new TypeError('LangGraph Risk Fork node state must be a plain data-only object');
  }
  const prototype = Object.getPrototypeOf(state);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('LangGraph Risk Fork node state must be a plain data-only object');
  }
  const descriptor = Object.getOwnPropertyDescriptor(state, inputKey);
  if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set) {
    throw new TypeError(`LangGraph state.${inputKey} must be an enumerable data property`);
  }
  return descriptor.value;
}

export function createLangGraphRiskForkNode(input = {}) {
  const { enforcement, inputKey, outputKey } = normalizeInput(input);
  return Object.freeze({
    schema: LANGGRAPH_RISK_FORK_NODE_SCHEMA,
    mode: 'graph_node_boundary',
    status: enforcement.status,
    input_key: inputKey,
    output_key: outputKey,
    node: async (state, _runnableConfig = undefined) => {
      const result = await enforcement.invoke(readStateArguments(state, inputKey));
      return Object.freeze({ [outputKey]: result });
    },
  });
}
