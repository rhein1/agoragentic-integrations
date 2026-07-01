#!/usr/bin/env node
/* demo — simulates payment authorization and usage receipts; moves no real funds */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.example";
const EXECUTE_PATH = "/v1/marketplace/execute";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

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
  return createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function lowerCaseKeys(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[String(key).toLowerCase()] = value;
  }
  return out;
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

async function maybeImportX402Fetch() {
  const candidates = ["agoragentic/x402-client", "../lib/x402-client.mjs"];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      if (typeof mod.x402Fetch === "function") {
        return { x402Fetch: mod.x402Fetch, source: specifier };
      }
    } catch {
      // Fall back to an inline demo-compatible implementation so the file remains runnable.
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
      throw new Error("x402Fetch requires idempotencyKey");
    }

    let authorization = null;
    let paidChallengeId = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const requestHeaders = {
        accept: "application/json",
        "content-type": "application/json",
        "x-idempotency-key": idempotencyKey,
        ...headers,
      };
      if (authorization) {
        requestHeaders["x-payment-authorization"] = authorization;
      }

      let response;
      try {
        response = await fetchImpl(url, { method, headers: requestHeaders, body });
      } catch (error) {
        error.message = `network error before HTTP response: ${error.message}`;
        throw error;
      }

      if (response.status !== 402) {
        response.x402 = {
          attempts: attempt,
          authorized: Boolean(authorization),
          authorization: authorization || null,
        };
        return response;
      }

      if (typeof pay !== "function") {
        throw new Error("x402Fetch received HTTP 402 but no pay callback was supplied");
      }

      const challenge = await response.json();
      const challengeId = challenge.challenge_id || challenge.id || null;
      if (authorization && paidChallengeId && challengeId === paidChallengeId) {
        throw new Error(`server repeated challenge ${challengeId} after payment authorization`);
      }

      if (!authorization) {
        const payment = await pay({ challenge, url, method, body, idempotencyKey, attempt });
        authorization = payment?.authorization || payment?.paymentAuthorization || payment?.token || null;
        if (!authorization) {
          throw new Error("pay callback must return an authorization token after HTTP 402");
        }
        paidChallengeId = challengeId;
      }
    }

    throw new Error("x402Fetch exhausted retries while waiting for a non-402 response");
  };
}

function createPmClaudeListingManifest() {
  const skill = {
    repository: "https://github.com/mohitagw15856/pm-claude-skills",
    repository_slug: "mohitagw15856/pm-claude-skills",
    source_path: "skills/product/prd-critic/SKILL.md",
    skill_id: "pm-claude.prd-critic.v1",
    title: "PM-Claude PRD Critic",
    summary: "Review a draft PRD and return blockers, instrumentation gaps, experiments, and launch guidance.",
    prompt_template: [
      "You are a senior product manager reviewing a draft PRD.",
      "Return JSON with summary, blockers, instrumentation_gaps, experiments, and launch_recommendation.",
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
      additionalProperties: false,
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

  const tool = {
    name: "execute_pm_claude_prd_critic",
    description: "Local execute() wrapper for the pm-claude PRD Critic skill sold through the marketplace.",
    input_schema: clone(skill.input_schema),
    output_schema: {
      type: "object",
      additionalProperties: false,
      required: ["invocation_id", "capability_id", "output", "usage_receipt", "wrapper"],
      properties: {
        invocation_id: { type: "string" },
        capability_id: { type: "string" },
        output: clone(skill.output_schema),
        usage_receipt: { type: "object" },
        wrapper: {
          type: "object",
          required: ["x402_fetch_source", "idempotency_key"],
          properties: {
            x402_fetch_source: { type: "string" },
            idempotency_key: { type: "string" },
          },
        },
      },
    },
  };

  const manifest = {
    manifest_version: "1.0",
    listing_id: "agoragentic.pm-claude.prd-critic.execute.v1",
    capability_id: "agoragentic.pm-claude.prd-critic.execute.v1",
    title: "PM-Claude PRD Critic execute() wrapper",
    summary: "Minimal seller manifest and local execute() wrapper for packaging a pm-claude skill as a trust-checked marketplace capability.",
    visibility: "draft",
    seller: {
      id: "mohitagw15856/pm-claude-skills",
      display_name: "pm-claude-skills",
      repository: skill.repository,
    },
    payment: {
      rail: "x402",
      asset: "USDC",
      max_price_usdc: "0.05",
      requires_caller_pay_gate: true,
      idempotency_required: true,
    },
    execution: {
      transport: "marketplace.execute",
      path: EXECUTE_PATH,
      wrapper_runtime: "node>=18",
      wrapper_file: "examples/pm_claude_skills_execute_manifest.mjs",
      timeout_ms: 30000,
    },
    mcp: {
      server_name: "pm-claude-skills",
      protocol: "mcp",
      tools: [
        {
          name: tool.name,
          description: tool.description,
        },
      ],
    },
    skill,
    tool,
    trust_policy: {
      mode: "trust-checked",
      checks: [
        {
          id: "source_repository_pinned",
          description: "Manifest pins the upstream pm-claude-skills repository and skill path.",
        },
        {
          id: "schema_locked",
          description: "Wrapper validates inputs against the packaged skill schema and publishes an explicit output contract.",
        },
        {
          id: "payment_gate_required",
          description: "Wrapper never auto-pays; caller must supply a pay callback and authorization only happens after HTTP 402.",
        },
        {
          id: "idempotency_forwarded",
          description: "Every execute() request forwards a stable idempotency key so retries reuse the same authorization path.",
        },
        {
          id: "receipt_digest_bound",
          description: "Usage receipt binds capability, prompt, request, and result digests together.",
        },
      ],
    },
  };

  manifest.digests = {
    manifest_digest: sha256({ ...manifest, digests: undefined }),
    prompt_template_digest: sha256(skill.prompt_template),
    input_schema_digest: sha256(skill.input_schema),
    output_schema_digest: sha256(skill.output_schema),
  };

  return manifest;
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
  const constraintSummary = constraints.length ? constraints.join("; ") : "No explicit constraints supplied.";
  return {
    summary: `PRD review for ${input.target_user}: clarify the success metric, launch guardrails, and scope boundaries before rollout.`,
    blockers: [
      "Primary activation event is not defined in measurable terms.",
      "No rollback threshold is specified for an underperforming launch cohort.",
      `Constraint review: ${constraintSummary}`,
    ],
    instrumentation_gaps: [
      "Missing event for first-success moment after onboarding.",
      "No cohort split by acquisition channel or user intent.",
      "No validation event for the PRD's highest-risk assumption within the first 7 days.",
    ],
    experiments: [
      "Run a narrow beta with one acquisition channel and one success KPI.",
      "Compare assisted onboarding against self-serve completion time.",
      "Instrument copy variants for the first-run checklist and review completion time.",
    ],
    launch_recommendation: "Hold broad launch until the success metric, rollback guardrail, and onboarding instrumentation are explicit.",
  };
}

function createUsageReceipt({ manifest, invocationId, idempotencyKey, challenge, input, result }) {
  return {
    receipt_id: `rcpt_${sha256(`${invocationId}:${idempotencyKey}`).slice(0, 18)}`,
    type: "agoragentic.usage_receipt",
    status: "simulated-settled",
    created_at: nowIso(),
    capability_id: manifest.capability_id,
    manifest_digest: manifest.digests.manifest_digest,
    skill_id: manifest.skill.skill_id,
    invocation_id: invocationId,
    idempotency_key: idempotencyKey,
    payment: {
      rail: "x402",
      asset: "USDC",
      amount_usdc: manifest.payment.max_price_usdc,
      challenge_id: challenge.challenge_id,
      authorization_mode: "demo-pay-gate",
      note: "Simulated authorization only; no wallet signing or settlement occurs in this demo.",
    },
    trust_checks: manifest.trust_policy.checks.map((check) => ({ id: check.id, ok: true })),
    digests: {
      prompt_template_digest: manifest.digests.prompt_template_digest,
      input_schema_digest: manifest.digests.input_schema_digest,
      output_schema_digest: manifest.digests.output_schema_digest,
      input_digest: sha256(input),
      result_digest: sha256(result),
    },
    metering: {
      billable_unit: "capability_call",
      quantity: 1,
      input_chars: JSON.stringify(input).length,
      output_chars: JSON.stringify(result).length,
    },
  };
}

function createMockMarketplaceFetch(manifest) {
  const challengeByKey = new Map();
  const responseByKey = new Map();

  return async function fetchImpl(url, options = {}) {
    const headers = lowerCaseKeys(options.headers);
    const idempotencyKey = headers["x-idempotency-key"];
    const authorization = headers["x-payment-authorization"];
    const body = options.body ? JSON.parse(options.body) : {};

    if (!url.endsWith(EXECUTE_PATH)) {
      return jsonResponse(404, { error: "not_found" });
    }
    if (!idempotencyKey) {
      return jsonResponse(400, { error: "missing_idempotency_key" });
    }

    if (!authorization) {
      const challenge = {
        challenge_id: `ch_${sha256(idempotencyKey).slice(0, 12)}`,
        capability_id: manifest.capability_id,
        amount_usdc: manifest.payment.max_price_usdc,
        asset: manifest.payment.asset,
        pay_to: "demo:marketplace:pm-claude-skills",
        memo: "demo challenge; authorize only through a caller-supplied pay gate",
      };
      challengeByKey.set(idempotencyKey, challenge);
      return jsonResponse(402, challenge);
    }

    const challenge = challengeByKey.get(idempotencyKey);
    if (!challenge) {
      return jsonResponse(409, { error: "missing_prior_challenge" });
    }

    const expectedAuthorization = `demo-auth::${challenge.challenge_id}::${idempotencyKey}`;
    if (authorization !== expectedAuthorization) {
      return jsonResponse(403, { error: "invalid_payment_authorization" });
    }

    if (!responseByKey.has(idempotencyKey)) {
      const input = body.input || {};
      const invocationId = `inv_${sha256(idempotencyKey).slice(0, 16)}`;
      const result = simulatePmCritique(input);
      const usageReceipt = createUsageReceipt({
        manifest,
        invocationId,
        idempotencyKey,
        challenge,
        input,
        result,
      });
      responseByKey.set(idempotencyKey, {
        invocation_id: invocationId,
        capability_id: manifest.capability_id,
        result,
        usage_receipt: usageReceipt,
      });
    }

    return jsonResponse(200, responseByKey.get(idempotencyKey));
  };
}

export async function createPmClaudeExecuteWrapper(options = {}) {
  const manifest = options.manifest || createPmClaudeListingManifest();
  const x402Module = await maybeImportX402Fetch();
  const x402Fetch = options.x402Fetch || x402Module.x402Fetch;
  const fetchImpl = options.fetchImpl || createMockMarketplaceFetch(manifest);
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

  async function execute(input, runtime = {}) {
    validateExecuteInput(input);
    const pay = runtime.pay || options.pay;
    if (typeof pay !== "function") {
      throw new Error("execute() requires a caller-supplied pay callback; the wrapper never auto-pays");
    }

    const idempotencyKey = runtime.idempotencyKey || randomUUID();
    const response = await x402Fetch(`${baseUrl}${EXECUTE_PATH}`, {
      method: "POST",
      fetchImpl,
      pay,
      idempotencyKey,
      headers: {
        "x-capability-digest": manifest.digests.manifest_digest,
      },
      body: JSON.stringify({
        capability_id: manifest.capability_id,
        skill_id: manifest.skill.skill_id,
        trust_mode: manifest.trust_policy.mode,
        input,
      }),
    });

    if (!response.ok) {
      throw new Error(`execute() failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    return {
      invocation_id: payload.invocation_id,
      capability_id: payload.capability_id,
      output: payload.result,
      usage_receipt: payload.usage_receipt,
      wrapper: {
        x402_fetch_source: x402Module.source,
        idempotency_key: idempotencyKey,
      },
    };
  }

  return {
    manifest,
    tool: manifest.tool,
    execute,
  };
}

export async function runDemo() {
  const wrapper = await createPmClaudeExecuteWrapper();
  let payCalls = 0;
  const input = {
    product_brief: "We want to package a PM-Claude skill as a governed marketplace capability with trust checks and a usage receipt per invocation.",
    target_user: "Marketplace maintainers",
    constraints: [
      "No filesystem writes",
      "Receipt must include prompt digest",
      "Buyer must explicitly authorize payment",
    ],
  };

  const execution = await wrapper.execute(input, {
    idempotencyKey: "demo-pm-claude-prd-critic",
    async pay({ challenge, idempotencyKey }) {
      payCalls += 1;
      return {
        authorization: `demo-auth::${challenge.challenge_id}::${idempotencyKey}`,
      };
    },
  });

  return {
    manifest: wrapper.manifest,
    tool: wrapper.tool,
    input,
    execution,
    pay_calls: payCalls,
  };
}

export async function selfTest() {
  const demo = await runDemo();
  assert.equal(demo.pay_calls, 1, "payment should be authorized exactly once after a 402 challenge");
  assert.equal(demo.execution.wrapper.idempotency_key, "demo-pm-claude-prd-critic");
  assert.equal(demo.execution.capability_id, demo.manifest.capability_id);
  assert.equal(
    demo.execution.usage_receipt.digests.prompt_template_digest,
    demo.manifest.digests.prompt_template_digest,
  );
  assert.equal(demo.execution.usage_receipt.payment.authorization_mode, "demo-pay-gate");
  assert.equal(Array.isArray(demo.execution.output.blockers), true);
  assert.equal(demo.execution.output.blockers.length >= 2, true);
  return "self-test passed";
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--self-test")) {
    console.log(await selfTest());
    return;
  }

  const demo = await runDemo();
  console.log(
    JSON.stringify(
      {
        manifest: demo.manifest,
        tool: demo.tool,
        demo_input: demo.input,
        demo_execution: demo.execution,
        pay_calls: demo.pay_calls,
      },
      null,
      2,
    ),
  );
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
