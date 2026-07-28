import assert from "node:assert/strict";
import test from "node:test";

import {
  AgoragenticWorldAgentkitError,
  createAgoragenticWorldAgentkitClient,
} from "./agoragentic_world_agentkit.mjs";


test("requires a signer", async () => {
  await assert.rejects(
    () => createAgoragenticWorldAgentkitClient(),
    (error) => error instanceof AgoragenticWorldAgentkitError && error.code === "missing_signer",
  );
});

test("pins remote calls to agoragentic.com", async () => {
  await assert.rejects(
    () => createAgoragenticWorldAgentkitClient({
      signer: {},
      baseUrl: "https://example.com",
      createAgentkitClientImpl: () => ({ fetch: async () => new Response(null, { status: 402 }) }),
    }),
    (error) => error.code === "invalid_base_url",
  );
});

test("uses the official client contract without adding payment behavior", async () => {
  const calls = [];
  const original402 = new Response(JSON.stringify({ extensions: {} }), {
    status: 402,
    headers: { "content-type": "application/json" },
  });
  const signer = { address: "0x0000000000000000000000000000000000000001" };
  const client = await createAgoragenticWorldAgentkitClient({
    signer,
    fetchImpl: async () => original402,
    createAgentkitClientImpl: (options) => {
      assert.equal(options.signer, signer);
      return {
        async fetch(url, init) {
          calls.push({ url, init });
          return original402;
        },
      };
    },
  });

  const response = await client.fetch("/api/x402/listings", { method: "GET" });

  assert.equal(response, original402);
  assert.deepEqual(calls, [{ url: "https://agoragentic.com/api/x402/listings", init: { method: "GET" } }]);
});

test("rejects absolute and protocol-relative target paths", async () => {
  const client = await createAgoragenticWorldAgentkitClient({
    signer: {},
    createAgentkitClientImpl: () => ({ fetch: async () => new Response(null, { status: 200 }) }),
  });

  await assert.rejects(() => client.fetch("https://example.com/paid"), /origin-relative path/);
  await assert.rejects(() => client.fetch("//example.com/paid"), /origin-relative path/);
});

test("keeps mutation methods behind an explicit local gate", async () => {
  const client = await createAgoragenticWorldAgentkitClient({
    signer: {},
    createAgentkitClientImpl: () => ({ fetch: async () => new Response(null, { status: 200 }) }),
  });

  await assert.rejects(
    () => client.fetch("/api/x402/example", { method: "POST" }),
    (error) => error.code === "mutation_not_authorized",
  );
});
