import test from "node:test";
import assert from "node:assert/strict";
import {
  buildListingDraftFromOpenFangHand,
  buildOpenFangIntentContract,
  createOpenFangAgoragenticBridge,
  mapOpenFangGrantsToAgoragenticPolicy,
} from "./agoragentic_openfang.mjs";

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(data);
    },
  };
}

const hand = {
  id: "researcher.hand",
  name: "Researcher Hand",
  description: "Researches a topic and returns a cited brief.",
  capability_grants: {
    max_call_cost_usdc: 0.15,
    max_daily_cost_usdc: 1.5,
    approval_required_above_usdc: 0.15,
    tools: ["web_search", "citation_check"],
    allowed_domains: ["agoragentic.com"],
    network_allowlist: ["example.com"],
    network: true,
  },
};

test("maps OpenFang grants to bounded Agoragentic policy", () => {
  const policy = mapOpenFangGrantsToAgoragenticPolicy(hand.capability_grants);

  assert.equal(policy.source_runtime, "openfang");
  assert.equal(policy.spend.max_call_cost_usdc, 0.15);
  assert.equal(policy.spend.max_daily_cost_usdc, 1.5);
  assert.equal(policy.spend.settlement_network, "base");
  assert.deepEqual(policy.tools.allowed_tools, ["web_search", "citation_check"]);
  assert.deepEqual(policy.tools.allowed_domains.sort(), ["agoragentic.com", "example.com"]);
  assert.equal(policy.data.allow_private_data, false);
  assert.equal(policy.approvals.require_human_for_listing_publication, true);
});

test("builds an intent contract without provider hardcoding", () => {
  const contract = buildOpenFangIntentContract({
    hand,
    task: "summarize this source",
    input: { text: "hello" },
    constraints: { max_cost_usdc: 0.12 },
  });

  assert.equal(contract.schema, "agoragentic.openfang.intent-contract.v1");
  assert.equal(contract.source_runtime, "openfang");
  assert.equal(contract.hand.id, "researcher.hand");
  assert.equal(contract.intent.task, "summarize this source");
  assert.equal(contract.policy.spend.max_call_cost_usdc, 0.12);
  assert.equal(contract.execution.preferred_entrypoint, "POST /api/execute");
  assert.equal(contract.execution.avoid_provider_hardcoding, true);
  assert.equal(contract.execution.require_receipt, true);
});

test("runtime daily budget override tightens manifest daily cap", () => {
  const contract = buildOpenFangIntentContract({
    hand,
    task: "summarize this source",
    input: { text: "hello" },
    constraints: { max_daily_cost_usdc: 0.25 },
  });

  assert.equal(contract.policy.spend.max_daily_cost_usdc, 0.25);
});

test("dry-run execute calls match only and never spends", async () => {
  const calls = [];
  const bridge = createOpenFangAgoragenticBridge({
    apiKey: "amk_test",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || "GET" });
      return jsonResponse({ matches: [{ id: "cap_test" }] });
    },
  });

  const result = await bridge.execute({
    hand,
    task: "summarize this source",
    input: { text: "hello" },
    execute: false,
  });

  assert.equal(result.mode, "dry_run");
  assert.equal(result.no_spend, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/api\/execute\/match\?/);
});

test("dry-run match preserves zero max cost for free-only previews", async () => {
  const calls = [];
  const bridge = createOpenFangAgoragenticBridge({
    apiKey: "amk_test",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || "GET" });
      return jsonResponse({ matches: [] });
    },
  });

  await bridge.execute({
    hand,
    task: "free-only preview",
    input: {},
    constraints: { max_cost_usdc: 0 },
    execute: false,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /max_cost=0/);
});

test("listing draft does not publish unless explicitly requested", async () => {
  const calls = [];
  const bridge = createOpenFangAgoragenticBridge({
    apiKey: "amk_test",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method || "GET" });
      return jsonResponse({ ok: true });
    },
  });

  const result = await bridge.publishListing({
    hand,
    endpointUrl: "https://example.com/openfang/researcher",
    pricePerUnit: 0.25,
    publish: false,
  });

  assert.equal(result.mode, "draft_only");
  assert.equal(result.no_publication, true);
  assert.equal(calls.length, 0);
  assert.equal(result.draft.metadata.source_runtime, "openfang");
  assert.equal(result.draft.price_per_unit, 0.25);
});

test("listing draft requires an endpoint URL", () => {
  assert.throws(
    () => buildListingDraftFromOpenFangHand({ hand }),
    /endpointUrl is required/,
  );
});
