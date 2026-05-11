import fs from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_API_BASE = "https://agoragentic.com";
const DEFAULT_MAX_COST_USDC = 0.10;

function cleanApiBase(apiBase = DEFAULT_API_BASE) {
  return String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function requireTask(task) {
  const value = String(task || "").trim();
  if (!value) throw new Error("task is required");
  return value;
}

function parseJson(value, fallback = {}) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  return JSON.parse(value);
}

function redactHeaders(headers = {}) {
  const out = { ...headers };
  if (out.Authorization) out.Authorization = "Bearer amk_...";
  if (out.authorization) out.authorization = "Bearer amk_...";
  return out;
}

async function httpJson({
  apiBase,
  apiKey,
  method = "GET",
  path,
  body,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is required; use Node 18+ or pass fetchImpl");
  }

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "agoragentic-openfang-bridge/0.1",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchImpl(`${cleanApiBase(apiBase)}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const err = new Error(data.error || data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.response = data;
    err.request = { method, path, headers: redactHeaders(headers) };
    throw err;
  }

  return data;
}

export function normalizeOpenFangHand(hand = {}) {
  const id = hand.id || hand.hand_id || hand.name || "openfang-hand";
  const grants = hand.capability_grants || hand.grants || hand.permissions || {};
  const workflows = hand.workflows || hand.workflow_policy || {};

  return {
    id: String(id),
    name: String(hand.name || id),
    description: String(hand.description || hand.summary || "OpenFang Hand"),
    runtime: "openfang",
    version: hand.version || null,
    channels: Array.isArray(hand.channels) ? hand.channels : [],
    workflows,
    capability_grants: grants,
    memory: hand.memory || hand.memory_policy || null,
    sandbox: hand.sandbox || hand.sandbox_policy || null,
  };
}

export function mapOpenFangGrantsToAgoragenticPolicy(grants = {}, options = {}) {
  const maxCostUsdc = Number(
    options.maxCostUsdc ??
    grants.max_cost_usdc ??
    grants.max_call_cost_usdc ??
    DEFAULT_MAX_COST_USDC,
  );
  const approvalAboveUsdc = Number(
    options.approvalAboveUsdc ??
    grants.approval_required_above_usdc ??
    maxCostUsdc,
  );

  const allowedDomains = [
    ...(Array.isArray(grants.allowed_domains) ? grants.allowed_domains : []),
    ...(Array.isArray(grants.network_allowlist) ? grants.network_allowlist : []),
  ];

  return {
    source_runtime: "openfang",
    spend: {
      max_call_cost_usdc: maxCostUsdc,
      max_daily_cost_usdc: Number(grants.max_daily_cost_usdc ?? options.maxDailyCostUsdc ?? maxCostUsdc),
      approval_required_above_usdc: approvalAboveUsdc,
      currency: "USDC",
      settlement_network: "base",
    },
    tools: {
      allowed_tools: Array.isArray(grants.tools) ? grants.tools : [],
      allowed_domains: [...new Set(allowedDomains)],
      network_required: Boolean(grants.network || allowedDomains.length),
    },
    data: {
      allow_private_data: Boolean(grants.allow_private_data),
      allow_secret_access: Boolean(grants.allow_secret_access),
      requires_context_boundary: true,
    },
    approvals: {
      require_human_for_spend: approvalAboveUsdc <= maxCostUsdc,
      require_human_for_listing_publication: true,
      require_human_for_external_side_effects: true,
    },
  };
}

export function buildOpenFangIntentContract({
  hand = {},
  task,
  input = {},
  constraints = {},
} = {}) {
  const normalizedHand = normalizeOpenFangHand(hand);
  const policy = mapOpenFangGrantsToAgoragenticPolicy(
    normalizedHand.capability_grants,
    {
      maxCostUsdc: constraints.max_cost_usdc ?? constraints.max_cost,
      approvalAboveUsdc: constraints.approval_required_above_usdc,
      maxDailyCostUsdc: constraints.max_daily_cost_usdc,
    },
  );

  return {
    schema: "agoragentic.openfang.intent-contract.v1",
    source_runtime: "openfang",
    hand: normalizedHand,
    intent: {
      task: requireTask(task),
      input_shape: Array.isArray(input) ? "array" : typeof input,
      input_keys: input && typeof input === "object" && !Array.isArray(input) ? Object.keys(input).sort() : [],
    },
    policy,
    execution: {
      preferred_entrypoint: "POST /api/execute",
      avoid_provider_hardcoding: true,
      require_receipt: true,
      require_reconciliation: true,
    },
  };
}

export function buildListingDraftFromOpenFangHand({
  hand = {},
  endpointUrl,
  pricePerUnit = DEFAULT_MAX_COST_USDC,
  category = "workflows",
  inputSchema,
  outputSchema,
} = {}) {
  const normalizedHand = normalizeOpenFangHand(hand);
  if (!endpointUrl) {
    throw new Error("endpointUrl is required to expose an OpenFang Hand as a seller listing");
  }

  return {
    name: normalizedHand.name,
    description: normalizedHand.description,
    category,
    listing_type: "service",
    pricing_model: "per_call",
    price_per_unit: Number(pricePerUnit),
    endpoint_url: endpointUrl,
    tags: ["openfang", "hand", "agent-os", "receipts"],
    input_schema: inputSchema || {
      type: "object",
      additionalProperties: true,
      description: "Input forwarded to the OpenFang Hand endpoint.",
    },
    output_schema: outputSchema || {
      type: "object",
      additionalProperties: true,
      description: "OpenFang Hand result plus Agoragentic receipt metadata.",
    },
    metadata: {
      source_runtime: "openfang",
      hand_id: normalizedHand.id,
      hand_name: normalizedHand.name,
      requires_receipts: true,
      requires_owner_approval_for_publication: true,
    },
  };
}

export function createOpenFangAgoragenticBridge({
  apiKey = process.env.AGORAGENTIC_API_KEY,
  apiBase = process.env.AGORAGENTIC_API_BASE || DEFAULT_API_BASE,
  fetchImpl = globalThis.fetch,
} = {}) {
  async function match({ task, constraints = {} } = {}) {
    const params = new URLSearchParams({ task: requireTask(task) });
    if (constraints.max_cost_usdc ?? constraints.max_cost) {
      params.set("max_cost", String(constraints.max_cost_usdc ?? constraints.max_cost));
    }
    return httpJson({
      apiBase,
      apiKey,
      fetchImpl,
      path: `/api/execute/match?${params.toString()}`,
    });
  }

  async function execute({
    hand = {},
    task,
    input = {},
    constraints = {},
    execute: shouldExecute = false,
  } = {}) {
    const contract = buildOpenFangIntentContract({ hand, task, input, constraints });
    if (!shouldExecute) {
      const preview = await match({ task, constraints });
      return {
        mode: "dry_run",
        no_spend: true,
        contract,
        preview,
      };
    }

    const result = await httpJson({
      apiBase,
      apiKey,
      fetchImpl,
      method: "POST",
      path: "/api/execute",
      body: {
        task: requireTask(task),
        input,
        constraints: {
          ...constraints,
          max_cost: constraints.max_cost_usdc ?? constraints.max_cost ?? contract.policy.spend.max_call_cost_usdc,
        },
        intent_contract: contract,
      },
    });

    const receiptId = result.receipt_id || result.receipt?.receipt_id || result.invocation_id;
    const receipt = receiptId ? await getReceipt(receiptId).catch(() => null) : null;
    return {
      mode: "executed",
      contract,
      result,
      receipt,
    };
  }

  async function getStatus(invocationId) {
    if (!invocationId) throw new Error("invocationId is required");
    return httpJson({ apiBase, apiKey, fetchImpl, path: `/api/execute/status/${encodeURIComponent(invocationId)}` });
  }

  async function getReceipt(receiptId) {
    if (!receiptId) throw new Error("receiptId is required");
    return httpJson({ apiBase, apiKey, fetchImpl, path: `/api/commerce/receipts/${encodeURIComponent(receiptId)}` });
  }

  async function publishListing({
    hand = {},
    endpointUrl,
    pricePerUnit,
    category,
    publish = false,
  } = {}) {
    const draft = buildListingDraftFromOpenFangHand({ hand, endpointUrl, pricePerUnit, category });
    if (!publish) {
      return {
        mode: "draft_only",
        no_publication: true,
        draft,
      };
    }
    return httpJson({
      apiBase,
      apiKey,
      fetchImpl,
      method: "POST",
      path: "/api/capabilities",
      body: draft,
    });
  }

  return {
    match,
    execute,
    status: getStatus,
    receipt: getReceipt,
    publishListing,
    buildIntentContract: buildOpenFangIntentContract,
    buildListingDraft: buildListingDraftFromOpenFangHand,
  };
}

function loadHandManifest(path) {
  if (!path) return {};
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function parseCli(argv = process.argv.slice(2)) {
  const opts = {
    mode: "match",
    handPath: process.env.OPENFANG_HAND_MANIFEST || null,
    task: process.env.AGORAGENTIC_TASK || "echo",
    input: parseJson(process.env.AGORAGENTIC_INPUT_JSON, { text: "OpenFang Hand dry run" }),
    maxCostUsdc: Number(process.env.AGORAGENTIC_MAX_COST_USDC || DEFAULT_MAX_COST_USDC),
    endpointUrl: process.env.OPENFANG_HAND_ENDPOINT_URL || null,
    pricePerUnit: Number(process.env.OPENFANG_LISTING_PRICE_USDC || DEFAULT_MAX_COST_USDC),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "match" || arg === "execute" || arg === "listing-draft" || arg === "publish-listing") {
      opts.mode = arg;
    } else if (arg === "--hand" && argv[i + 1]) {
      opts.handPath = argv[++i];
    } else if (arg === "--task" && argv[i + 1]) {
      opts.task = argv[++i];
    } else if (arg === "--input-json" && argv[i + 1]) {
      opts.input = parseJson(argv[++i], {});
    } else if (arg === "--max-cost" && argv[i + 1]) {
      opts.maxCostUsdc = Number(argv[++i]);
    } else if (arg === "--endpoint-url" && argv[i + 1]) {
      opts.endpointUrl = argv[++i];
    } else if (arg === "--price" && argv[i + 1]) {
      opts.pricePerUnit = Number(argv[++i]);
    }
  }
  return opts;
}

async function runCli() {
  const opts = parseCli();
  const hand = loadHandManifest(opts.handPath);
  const bridge = createOpenFangAgoragenticBridge();

  if (opts.mode === "listing-draft" || opts.mode === "publish-listing") {
    const out = await bridge.publishListing({
      hand,
      endpointUrl: opts.endpointUrl,
      pricePerUnit: opts.pricePerUnit,
      publish: opts.mode === "publish-listing" && process.env.AGORAGENTIC_PUBLISH_LISTING === "true",
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const out = await bridge.execute({
    hand,
    task: opts.task,
    input: opts.input,
    constraints: { max_cost_usdc: opts.maxCostUsdc },
    execute: opts.mode === "execute" && process.env.AGORAGENTIC_EXECUTE === "true",
  });
  console.log(JSON.stringify(out, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((err) => {
    console.error(err.message || err);
    if (err.status) console.error(JSON.stringify(err.response || {}, null, 2));
    process.exit(1);
  });
}
