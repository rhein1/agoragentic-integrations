// demo uses simulated trust checks, payment authorization, and receipts; moves no real funds.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.example";

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  const text = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(text).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function maybeImportX402Fetch() {
  const candidates = ["agoragentic/x402-client", "../lib/x402-client.mjs"];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      if (typeof mod.x402Fetch === "function") {
        return { x402Fetch: mod.x402Fetch, source: specifier };
      }
    } catch {
      // Fall through to the inline demo-compatible helper.
    }
  }
  return { x402Fetch: createInlineX402Fetch(), source: "inline-demo-compat" };
}

function createInlineX402Fetch() {
  return async function x402Fetch(url, options = {}) {
    const {
      fetchImpl = globalThis.fetch,
      pay,
      idempotencyKey,
      method = "POST",
      headers = {},
      body,
    } = options;

    if (typeof fetchImpl !== "function") {
      throw new Error("x402Fetch requires fetchImpl when global fetch is unavailable");
    }
    if (!idempotencyKey) {
      throw new Error("x402Fetch requires an idempotencyKey");
    }

    let authorization = null;
    let paidChallengeId = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestHeaders = {
        accept: "application/json",
        "content-type": "application/json",
        "x-idempotency-key": idempotencyKey,
        ...headers,
      };
      if (authorization) {
        requestHeaders["x-payment-authorization"] = authorization;
      }

      const response = await fetchImpl(url, {
        method,
        headers: requestHeaders,
        body,
      });

      if (response.status !== 402) {
        return response;
      }

      if (typeof pay !== "function") {
        throw new Error("x402Fetch received HTTP 402 but no pay callback was supplied");
      }

      const challenge = await response.json();
      const challengeId = challenge.challenge_id || challenge.id || null;
      if (authorization && challengeId && challengeId === paidChallengeId) {
        throw new Error(`Server repeated challenge ${challengeId} after payment authorization`);
      }

      const payment = await pay({
        challenge,
        url,
        method,
        body,
        idempotencyKey,
      });

      authorization = payment?.authorization || payment?.paymentAuthorization || payment?.token || null;
      paidChallengeId = challengeId;
      if (!authorization) {
        throw new Error("pay callback must return an authorization token");
      }
    }

    throw new Error("x402Fetch exhausted retries while waiting for a non-402 response");
  };
}

function createPmClaudeSkillPackage() {
  const skill = {
    skill_id: "pm-claude.prd-critic.v1",
    source_repository: "https://github.com/mohitagw15856/pm-claude-skills",
    source_path: "skills/product/prd-critic/SKILL.md",
    title: "PM-Claude PRD Critic",
    summary:
      "Turn a product brief into a PM-style risk review with launch blockers, missing metrics, and follow-up questions.",
    prompt_template: [
      "You are a senior product manager reviewing a draft PRD.",
      "Return a concise critique with: summary, blockers, instrumentation gaps, experiments, and launch recommendation.",
      "Product brief: {{product_brief}}",
      "Target user: {{target_user}}",
      "Constraints: {{constraints}}",
    ].join("\n"),
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["product_brief", "target_user"],
      properties: {
        product_brief: { type: "string", minLength: 20 },
        target_user: { type: "string", minLength: 3 },
        constraints: {
          type: "array",
          items: { type: "string" },
          default: [],
        },
      },
    },
    output_schema: {
      type: "object",
      required: ["summary", "blockers", "instrumentation_gaps", "experiments", "launch_recommendation"],
      properties: {
        summary: { type: "string" },
        blockers: { type: "array", items: { type: "string" } },
        instrumentation_gaps: { type: "array", items: { type: "string" } },
        experiments: { type: "array", items: { type: "string" } },
        launch_recommendation: { type: "string" },
      },
    },
  };

  const trustPolicy = {
    mode: "trust-checked",
    checks: [
      {
        id: "source_repository_pinned",
        description: "Capability metadata pins the upstream pm-claude-skills repository and source path.",
      },
      {
        id: "prompt_digest_recorded",
        description: "The packaged prompt template is hashed into the listing and every usage receipt.",
      },
      {
        id: "input_output_schema_locked",
        description: "Marketplace wrapper validates inputs and publishes an explicit output contract.",
      },
      {
        id: "tool_wrapper_scoped",
        description: "Wrapper exposes one execute() tool with no filesystem, network, or shell passthrough beyond marketplace transport.",
      },
      {
        id: "receipt_contains_result_digest",
        description: "Each execution produces a usage receipt with invocation, payment, trust, and result digests.",
      },
    ],
    reviewer_attestation: {
      reviewer: "demo-maintainer",
      reviewed_at: "2026-06-26T00:00:00.000Z",
      notes: "Demo attestation for documentation; replace with project review evidence in production.",
    },
  };

  const packageDigest = sha256({ skill, trustPolicy });

  return {
    capability_id: "agoragentic.pm_claude_prd_critic.v1",
    title: "Trust-checked PM-Claude PRD Critic",
    listing_visibility: "private-demo",
    payment: {
      network: "x402",
      asset: "USDC",
      max_price_usdc: "0.05",
      requires_caller_pay_gate: true,
    },
    execution: {
      transport: "marketplace.execute",
      wrapper_version: "1.0.0",
      timeout_ms: 30000,
    },
    skill,
    trust_policy: trustPolicy,
    digests: {
      capability_digest: packageDigest,
      prompt_template_digest: sha256(skill.prompt_template),
      input_schema_digest: sha256(skill.input_schema),
      output_schema_digest: sha256(skill.output_schema),
      reviewer_attestation_digest: sha256(trustPolicy.reviewer_attestation),
    },
  };
}

function validateExecuteInput(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("execute() requires an object payload");
  }
  if (typeof payload.product_brief !== "string" || payload.product_brief.trim().length < 20) {
    throw new Error("product_brief must be a string with at least 20 characters");
  }
  if (typeof payload.target_user !== "string" || payload.target_user.trim().length < 3) {
    throw new Error("target_user must be a string with at least 3 characters");
  }
  if (payload.constraints !== undefined) {
    if (!Array.isArray(payload.constraints) || payload.constraints.some((item) => typeof item !== "string")) {
      throw new Error("constraints must be an array of strings when provided");
    }
  }
}

function simulatePmCritique(input) {
  const constraints = Array.isArray(input.constraints) ? input.constraints : [];
  const constraintLine = constraints.length ? constraints.join("; ") : "No explicit constraints supplied.";
  return {
    summary: `PRD review for ${input.target_user}: clarify the value proposition, define the success metric, and tighten launch scope.`,
    blockers: [
      "Primary activation event is not defined in measurable terms.",
      "No rollback threshold is provided for a weak launch cohort.",
      `Constraint review: ${constraintLine}`,
    ],
    instrumentation_gaps: [
      "Missing event for first-success moment after onboarding.",
      "No cohort split by acquisition channel or user intent.",
      "No instrumentation for PRD assumption validation within the first 7 days.",
    ],
    experiments: [
      "Run a narrow beta with one acquisition channel and one success KPI.",
      "Compare assisted onboarding against self-serve flow completion.",
      "Instrument copy variants for the first-run checklist and review completion time.",
    ],
    launch_recommendation: "Hold broad launch until success metric, rollback guardrail, and onboarding instrumentation are explicit.",
  };
}

function createReceipt({ capability, invocationId, idempotencyKey, paymentChallenge, result, input }) {
  return {
    receipt_id: `rcpt_${sha256(`${invocationId}:${idempotencyKey}`).slice(0, 18)}`,
    type: "agoragentic.usage_receipt",
    status: "simulated-settled",
    created_at: nowIso(),
    capability_id: capability.capability_id,
    capability_digest: capability.digests.capability_digest,
    skill_id: capability.skill.skill_id,
    invocation_id: invocationId,
    idempotency_key: idempotencyKey,
    payment: {
      rail: "x402",
      asset: "USDC",
      amount_usdc: "0.05",
      challenge_id: paymentChallenge.challenge_id,
      authorization_mode: "demo-pay-gate",
      note: "Simulated authorization only; no wallet signing or settlement occurs in this demo.",
    },
    trust_checks: capability.trust_policy.checks.map((check) => ({
      id: check.id,
      ok: true,
    })),
    trust_attestation: capability.trust_policy.reviewer_attestation,
    digests: {
      prompt_template_digest: capability.digests.prompt_template_digest,
      input_schema_digest: capability.digests.input_schema_digest,
      output_schema_digest: capability.digests.output_schema_digest,
      reviewer_attestation_digest: capability.digests.reviewer_attestation_digest,
      input_digest: sha256(input),
      result_digest: sha256(result),
    },
    metering: {
      input_chars: JSON.stringify(input).length,
      output_chars: JSON.stringify(result).length,
      billable_unit: "capability_call",
      quantity: 1,
    },
  };
}

function createMockMarketplaceFetch(capability) {
  const receiptsByKey = new Map();
  const challengeByKey = new Map();

  return async function fetchImpl(url, options = {}) {
    const requestHeaders = lowerCaseKeys(options.headers || {});
    const idempotencyKey = requestHeaders["x-idempotency-key"];
    const authorization = requestHeaders["x-payment-authorization"];
    const payload = options.body ? JSON.parse(options.body) : {};

    if (!idempotencyKey) {
      return jsonResponse(400, { error: "missing_idempotency_key" });
    }

    if (url.endsWith("/v1/marketplace/execute") && !authorization) {
      const challenge = {
        challenge_id: `ch_${sha256(idempotencyKey).slice(0, 12)}`,
        amount_usdc: "0.05",
        pay_to: "demo:marketplace:pm-claude",
        asset: "USDC",
        capability_id: capability.capability_id,
        memo: "demo challenge; authorize only through a caller-supplied pay gate",
      };
      challengeByKey.set(idempotencyKey, challenge);
      return jsonResponse(402, challenge);
    }

    if (url.endsWith("/v1/marketplace/execute")) {
      const challenge = challengeByKey.get(idempotencyKey);
      const expectedAuthorization = `demo-auth::${challenge.challenge_id}::${idempotencyKey}`;
      if (authorization !== expectedAuthorization) {
        return jsonResponse(403, { error: "invalid_payment_authorization" });
      }

      if (!receiptsByKey.has(idempotencyKey)) {
        const invocationId = `inv_${sha256(idempotencyKey).slice(0, 16)}`;
        const result = simulatePmCritique(payload.input || {});
        const usageReceipt = createReceipt({
          capability,
          invocationId,
          idempotencyKey,
          paymentChallenge: challenge,
          result,
          input: payload.input || {},
        });
        receiptsByKey.set(idempotencyKey, {
          invocation_id: invocationId,
          capability_id: capability.capability_id,
          result,
          usage_receipt: usageReceipt,
        });
      }

      return jsonResponse(200, receiptsByKey.get(idempotencyKey));
    }

    return jsonResponse(404, { error: "not_found" });
  };
}

function lowerCaseKeys(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[String(key).toLowerCase()] = value;
  }
  return normalized;
}

function jsonResponse(status, value) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return clone(value);
    },
    async text() {
      return JSON.stringify(value, null, 2);
    },
  };
}

function assertUsageReceipt(value, capability) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("execute() succeeded without a usage_receipt");
  }
  if (typeof value.receipt_id !== "string" || value.receipt_id.trim() === "") {
    throw new Error("usage_receipt is missing receipt_id");
  }
  if (value.capability_id !== capability.capability_id) {
    throw new Error("usage_receipt capability_id does not match the requested capability");
  }
  const digests = value.digests;
  if (!digests || typeof digests !== "object" || Array.isArray(digests)) {
    throw new Error("usage_receipt is missing digest evidence");
  }
  for (const field of ["prompt_template_digest", "input_digest", "result_digest"]) {
    if (typeof digests[field] !== "string" || digests[field].trim() === "") {
      throw new Error(`usage_receipt is missing ${field}`);
    }
  }
  return value;
}

export async function createPmClaudeMarketplaceCapability(options = {}) {
  const capability = createPmClaudeSkillPackage();
  const x402Module = await maybeImportX402Fetch();
  const x402Fetch = options.x402Fetch || x402Module.x402Fetch;
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl || createMockMarketplaceFetch(capability);

  async function execute(input, runtime = {}) {
    validateExecuteInput(input);
    const pay = runtime.pay || options.pay;
    if (typeof pay !== "function") {
      throw new Error("execute() requires a caller-supplied pay callback; the demo never auto-pays");
    }

    const idempotencyKey = runtime.idempotencyKey || randomUUID();
    const requestBody = {
      capability_id: capability.capability_id,
      skill_id: capability.skill.skill_id,
      trust_mode: capability.trust_policy.mode,
      input,
    };

    const response = await x402Fetch(`${baseUrl}/v1/marketplace/execute`, {
      method: "POST",
      fetchImpl,
      pay,
      idempotencyKey,
      body: JSON.stringify(requestBody),
      headers: {
        "x-capability-digest": capability.digests.capability_digest,
      },
    });

    if (!response.ok) {
      throw new Error(`execute() failed with HTTP ${response.status}`);
    }

    const payload = await response.json();
    const usageReceipt = assertUsageReceipt(payload.usage_receipt, capability);
    return {
      invocation_id: payload.invocation_id,
      capability_id: payload.capability_id,
      output: payload.result,
      usage_receipt: usageReceipt,
      wrapper: {
        x402_fetch_source: x402Module.source,
        idempotency_key: idempotencyKey,
      },
    };
  }

  return {
    capability,
    execute,
    execute_tool: {
      name: "execute",
      description:
        "Run the packaged PM-Claude skill through the marketplace execute() route and return a usage receipt.",
      input_schema: capability.skill.input_schema,
      output_schema: capability.skill.output_schema,
    },
  };
}

export async function runDemo() {
  const capability = await createPmClaudeMarketplaceCapability();
  let payCalls = 0;
  const demoInput = {
    product_brief:
      "We want a PRD review skill that can be sold through the marketplace while preserving trust checks and a receipt per invocation.",
    target_user: "B2B marketplace maintainers",
    constraints: ["No filesystem writes", "Receipt must include prompt digest", "Buyer must explicitly authorize payment"],
  };

  const execution = await capability.execute(demoInput, {
    idempotencyKey: "demo-pm-claude-skill-doc",
    async pay({ challenge, idempotencyKey }) {
      payCalls += 1;
      return {
        authorization: `demo-auth::${challenge.challenge_id}::${idempotencyKey}`,
      };
    },
  });

  return {
    capability,
    execution,
    demo_input: demoInput,
    pay_calls: payCalls,
  };
}

export function renderMarkdownDoc({ capability, execution, demo_input, pay_calls }) {
  const packaged = capability.capability || capability;
  const manifest = {
    capability_id: packaged.capability_id,
    title: packaged.title,
    payment: packaged.payment,
    execution: packaged.execution,
    skill: {
      skill_id: packaged.skill.skill_id,
      title: packaged.skill.title,
      source_repository: packaged.skill.source_repository,
      source_path: packaged.skill.source_path,
      input_schema: packaged.skill.input_schema,
      output_schema: packaged.skill.output_schema,
    },
    trust_policy: packaged.trust_policy,
    digests: packaged.digests,
  };

  return [
    "# PM-Claude skill packaged as a trust-checked marketplace capability",
    "",
    "This example is executable documentation: the same file defines the capability package, the execute() wrapper, a simulated x402 payment gate, and the usage receipt returned to the caller.",
    "",
    "## Capability manifest",
    "",
    "```json",
    JSON.stringify(manifest, null, 2),
    "```",
    "",
    "## execute() tool wrapper",
    "",
    "The wrapper enforces three boundaries:",
    "",
    "1. Inputs must satisfy the PM-Claude skill schema.",
    "2. Payment authorization only happens after an HTTP 402 challenge and only through a caller-supplied pay callback.",
    "3. The response is not considered complete unless it includes a usage receipt with trust and result digests.",
    "",
    "Runtime metadata:",
    "",
    "```json",
    JSON.stringify(execution.wrapper, null, 2),
    "```",
    "",
    "## Example buyer request",
    "",
    "```json",
    JSON.stringify(demo_input, null, 2),
    "```",
    "",
    "## Example execution result",
    "",
    "```json",
    JSON.stringify(execution.output, null, 2),
    "```",
    "",
    "## Usage receipt",
    "",
    "```json",
    JSON.stringify(execution.usage_receipt, null, 2),
    "```",
    "",
    "## Why this shape is marketplace-ready",
    "",
    "- Upstream PM-Claude provenance is pinned in capability metadata.",
    "- Trust review evidence is hashed and repeated in the receipt.",
    "- The buyer controls payment through an explicit pay gate.",
    "- The idempotency key is always sent so retries reuse the same authorization path.",
    `- Demo pay callback invocations: ${pay_calls}. The wrapper only authorizes on HTTP 402.`,
    "",
    "## Run it",
    "",
    "```bash",
    "node pm_claude_skill_marketplace_capability_doc.mjs",
    "node pm_claude_skill_marketplace_capability_doc.mjs --self-test",
    "```",
  ].join("\n");
}

export async function selfTest() {
  const demo = await runDemo();
  assert.equal(demo.pay_calls, 1, "payment should be authorized exactly once after a 402 challenge");
  assert.equal(demo.execution.wrapper.idempotency_key, "demo-pm-claude-skill-doc");
  assert.equal(demo.execution.usage_receipt.capability_id, demo.capability.capability.capability_id);
  assert.equal(
    demo.execution.usage_receipt.digests.prompt_template_digest,
    demo.capability.capability.digests.prompt_template_digest,
  );
  assert.equal(demo.execution.usage_receipt.payment.authorization_mode, "demo-pay-gate");
  assert.equal(demo.execution.output.blockers.length >= 2, true);

  const missingReceiptCapability = await createPmClaudeMarketplaceCapability({
    fetchImpl: async () =>
      jsonResponse(200, {
        invocation_id: "inv_missing_receipt",
        capability_id: "agoragentic.pm_claude_prd_critic.v1",
        result: simulatePmCritique({
          product_brief:
            "This deliberately receipt-free response should fail before callers can treat it as complete.",
          target_user: "validators",
        }),
      }),
  });
  await assert.rejects(
    () =>
      missingReceiptCapability.execute(
        {
          product_brief:
            "This deliberately receipt-free response should fail before callers can treat it as complete.",
          target_user: "validators",
        },
        {
          idempotencyKey: "demo-missing-receipt",
          async pay() {
            return { authorization: "unused-demo-authorization" };
          },
        },
      ),
    /usage_receipt/,
  );
  return "self-test passed";
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--self-test")) {
    console.log(await selfTest());
    return;
  }

  const demo = await runDemo();
  console.log(renderMarkdownDoc(demo));
}

const isEntrypoint = (() => {
  if (!process.argv[1]) {
    return false;
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
})();

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
