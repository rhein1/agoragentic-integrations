# Risk Fork framework adapters

This package contains thin, JavaScript-only adapter surfaces for OpenAI Agents,
LangChain, and LangGraph. They place deterministic Risk Fork enforcement inside
the function that a framework invokes for a tool or graph node. They are
source-only, opt-in, default-off, provider-free, and not evidence of live traffic
protection.

## Current truth

| Property | Current state |
|---|---|
| OpenAI Agents JS function-tool adapter | Source included; external SDK not bundled |
| LangChain JS tool-handler adapter | Source included; external framework not bundled |
| LangGraph JS node adapter | Source included; external framework not bundled |
| Default-on interception | No |
| Model or provider calls in the demo/tests | None |
| Qualified Risk Fork provider or framework executor | Not included |
| Stable host invocation key and durable direct-effect fence | Not included |
| Hosted `risk-forkd` activation | Not included |
| Live agent traffic protected by installing this source | No |
| Python framework adapters | Not included |

The adapters use the same fail-closed, factory-identity pattern as the
`risk-forkd` and MCP enforcement surfaces, but they do not impersonate an MCP
enforcement boundary. Native framework tools enter the exact branded
`createRiskForkHostBoundary()` object. MCP relay traffic continues to use
[`MCP_HOST_ADAPTER.md`](./MCP_HOST_ADAPTER.md) and the separately branded MCP
boundary.

## Enforcement flow

```text
framework tool or node
        |
        v
framework-specific wrapper (no direct callback exposed)
        |
        v
branded framework adapter
        |
        +--> host-owned, request-bound plan source
        |
        +--> exact Risk Fork host pre-effect boundary
        |
        +--> deterministic decision
               |
               +-- LOW ----------> hidden trusted direct executor
               +-- ELEVATED -----> blocked unless a fork was actually prepared
               +-- prepared ELEVATED/HIGH/IRREV. --> retained receipt; clean commit
               +-- denied -------> blocked receipt; no executor
```

The model cannot provide a risk label, owner policy, descriptor, plan, executor,
SDK context, or framework runtime configuration. Tool arguments are bounded,
canonical, authority-free JSON. Proxies, accessors, shared object identities,
secret-shaped material, risk-label fields, and structural copies of branded
capabilities fail closed.

The adapter never accepts an original `execute` callback. A host wraps its
effect implementation with `createTrustedRiskForkFrameworkExecutor()` and the
module retains the callbacks in a private `WeakMap`. This makes the protected
wrapper the only callback that should be registered with the framework. It
cannot stop application code from separately retaining and calling an
unwrapped effect function; eliminating that bypass remains an embedding-host
responsibility.

The capability brands establish same-module factory identity only. They do not
prove that the descriptor describes the actual effect, that the plan and
effective arguments match the executor's semantics, that the callback has a
durable effect fence, or that every framework route is intercepted. The
embedding owner must qualify and exact-bind those relationships before live
use; the public status therefore keeps `executor_qualified` and
`framework_interception_verified` false.

After the trusted LOW executor starts, callback failure or invalid output is
returned as an authority-free `direct_effect_ambiguous` receipt with
`retry_allowed: false`; it is not thrown back to the framework. This prevents
LangChain or LangGraph policies that retry rejected calls from automatically
invoking that same wrapper again. It does not fence a process crash, graph
resume/re-execution, or a new tool call issued by a model or user. Production use
still requires a stable host-bound invocation key and a durable effect fence in
the executor; neither is supplied or claimed by this source tranche.

## Build the common enforcement object

The same common construction is used by all three framework shims:

```js
import {
  createRiskForkFrameworkToolAdapter,
  createRiskForkFrameworkToolPlan,
  createTrustedRiskForkFrameworkExecutor,
  createTrustedRiskForkFrameworkPlanSource,
} from '@agoragentic/risk-fork/framework-tool-adapter';
import {
  createRiskForkHostBoundary,
  createTrustedRiskDescriptorSource,
} from '@agoragentic/risk-fork/host-boundary';

// Host-owned implementations. They must not come from model/tool arguments.
const descriptorSource = createTrustedRiskDescriptorSource(resolveDescriptor);
const hostBoundary = createRiskForkHostBoundary({
  controller: qualifiedController,
  trusted_descriptor_source: descriptorSource,
  create_execution_binding: createExecutionBinding,
});

const planSource = createTrustedRiskForkFrameworkPlanSource((request) => (
  createRiskForkFrameworkToolPlan(request, {
    operation_input: buildSavepointBoundOperation(request),
  })
));

const retainedReceipts = new Map();
const executor = createTrustedRiskForkFrameworkExecutor({
  async execute_direct(argumentsValue, context) {
    // Receives host-planned effective_arguments, never the unchecked caller
    // object, and runs only after a validated LOW/NORMAL_EXECUTION decision.
    return executeLowRiskEffect(argumentsValue, context);
  },
  execute_prepared_action(action, context) {
    // Injected only into a separate clean-commit call. This callback must be
    // backed by the repository's one-use authorization and reconciliation path.
    return executeApprovedAction(action, context);
  },
  async retain_prepared(receipt) {
    // Preserve the exact in-memory object. JSON serialization destroys the
    // WeakMap provenance required by commitPrepared().
    retainedReceipts.set(receipt.request_hash, receipt);
  },
});

const enforcement = createRiskForkFrameworkToolAdapter({
  enabled: process.env.RISK_FORK_FRAMEWORK_ENABLED === 'true',
  framework: 'openai-agents', // or langchain / langgraph
  tool_name: 'send_email',
  descriptor_ref: 'descriptor:send-email',
  host_boundary: hostBoundary,
  trusted_plan_source: planSource,
  trusted_executor: executor,
});
```

`buildSavepointBoundOperation()` is deliberately host-specific. For a real
HIGH or IRREVERSIBLE call it must supply the valid capsule, savepoint input,
effective arguments, expected binding, commit policy, expected commit type, and
network policy required by `RiskForkController`. The checked-in offline demo
uses a classification-only controller and is not a substitute for that path.

Do not reuse the same nested object instance in two plan fields. Construct
independent JSON values for `operation` and `effective_arguments`; shared object
identity is rejected before the host boundary.

## OpenAI Agents SDK for JavaScript

The current OpenAI Agents SDK function-tool API uses `tool({ name,
description, parameters, execute })`. The SDK also supports `needsApproval` and
tool guardrails. Risk Fork stays inside `execute`, adjacent to the effect, rather
than relying on an agent-level guardrail alone. `needsApproval: true` is retained
as an additional human pause; it does not replace Risk Fork classification or
clean-commit approval.

```js
import { tool } from '@openai/agents';
import { z } from 'zod';
import { createOpenAIAgentsRiskForkTool }
  from '@agoragentic/risk-fork/frameworks/openai-agents';

const gate = createOpenAIAgentsRiskForkTool({ enforcement });
const sendEmail = tool({
  name: 'send_email',
  description: 'Prepare an email for bounded delivery.',
  parameters: z.object({
    to: z.string().email(),
    subject: z.string().max(200),
    body: z.string().max(20_000),
  }),
  needsApproval: gate.needsApproval,
  execute: gate.execute,
});
```

Official references:

- [OpenAI Agents SDK quickstart](https://developers.openai.com/api/docs/guides/agents/quickstart)
- [OpenAI agent guardrails and approvals](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
- [OpenAI agent definitions](https://developers.openai.com/api/docs/guides/agents/define-agents)

The shim intentionally ignores the SDK run context. Copying a context object
could transfer session state, credentials, or other parent authority into the
fork request.

## LangChain for JavaScript

LangChain's JavaScript tool helper accepts `tool(handler, { name, description,
schema })`. Register the Risk Fork handler, not the original effect callback:

```js
import { tool } from 'langchain';
import { z } from 'zod';
import { createLangChainRiskForkTool }
  from '@agoragentic/risk-fork/frameworks/langchain';

const gate = createLangChainRiskForkTool({ enforcement });
const sendEmail = tool(gate.handler, {
  name: 'send_email',
  description: 'Prepare an email for bounded delivery.',
  schema: z.object({
    to: z.string().email(),
    subject: z.string().max(200),
    body: z.string().max(20_000),
  }),
});
```

The handler intentionally ignores LangChain's `ToolRuntime` (which extends the
runnable configuration); only validated tool arguments enter the plan. See the
official [LangChain JavaScript tools guide](https://docs.langchain.com/oss/javascript/langchain/tools).

## LangGraph for JavaScript

For an explicit side-effect node, pass one dedicated state field into the Risk
Fork node and write the receipt to a different field:

```js
import { createLangGraphRiskForkNode }
  from '@agoragentic/risk-fork/frameworks/langgraph';

const gate = createLangGraphRiskForkNode({
  enforcement,
  input_key: 'effect_input',
  output_key: 'effect_receipt',
});

graph.addNode('risk_fork_send_email', gate.node);
```

The node returns a partial state update and does not copy unrelated graph state
or LangGraph `Runtime`. Register this effect node without a retry policy. For
LangGraph `ToolNode` use the protected LangChain tool handler above. See the
official [LangGraph JavaScript graph
API](https://docs.langchain.com/oss/javascript/langgraph/graph-api).

## Receipt and commit behavior

- `LOW`: the hidden direct executor runs once. If it throws or its returned
  value fails output validation, the framework receives a closed
  `direct_effect_ambiguous` receipt with no result and `retry_allowed: false`.
  Because the wrapper resolves instead of rejecting after effect start,
  framework error-retry middleware does not automatically invoke it again.
- `ELEVATED` with `fork_optional`: the framework adapter refuses direct
  execution. Configure the host boundary so an actual fork is prepared.
- An actually prepared `ELEVATED`, `HIGH`, or `IRREVERSIBLE` call: the framework
  receives only an authority-free receipt. The host's `retain_prepared`
  callback must keep that exact object.
- `denied`: the framework receives a blocked receipt and no executor runs.

Clean commit is deliberately not exposed on the OpenAI, LangChain, or LangGraph
wrapper. Trusted host orchestration may call:

```js
const exactReceipt = retainedReceipts.get(requestHash);
const result = await enforcement.commitPrepared(exactReceipt, qualifiedCommitInput);
```

The adapter injects the hidden `execute_prepared_action` callback and rejects a
caller-supplied `executeAction`. A receipt is one-use at the adapter boundary;
after a commit attempt, retry requires reconciliation rather than another call.
The underlying clean-commit contract still requires its normal approval,
current-policy, one-use authorization/CAS, parent-state, destruction, and
receipt evidence. A JSON clone, framework serialization, fabricated receipt, or
receipt from another adapter cannot authorize commit.

## Offline verification

From the repository root:

```bash
npm --prefix risk-fork test
npm --prefix risk-fork run demo:frameworks
npm --prefix risk-fork run test:package
```

`demo:frameworks` exercises all three adapter surfaces with deterministic
classification. It performs zero model, network, provider, direct-effect, and
clean-commit calls. Passing it proves only that the source contracts compose
offline.

Before any hosted or production claim, independently qualify the Risk Fork
provider, savepoint/fork cleanup, effect fence, descriptor source, operation
planner, direct executor, clean-commit authority, framework-wide interception,
crash/retry behavior, and observability. Installing or importing these files
does not protect an agent whose tool can still call the original effect path.
The current source has no durable invocation ledger: process failure, graph
resume, or a fresh model/user tool call can still reach the executor again and
must remain outside production until the host provides that fence.
