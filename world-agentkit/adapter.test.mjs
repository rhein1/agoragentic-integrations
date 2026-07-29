import assert from "node:assert/strict";
import { createServer } from "node:http";
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
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return original402;
    },
    createAgentkitClientImpl: (options) => {
      assert.equal(options.signer, signer);
      return { fetch: options.fetch };
    },
  });

  const response = await client.fetch("/api/x402/listings", { method: "GET" });

  assert.equal(response, original402);
  assert.deepEqual(calls, [
    {
      url: "https://agoragentic.com/api/x402/listings",
      init: { method: "GET", redirect: "manual" },
    },
  ]);
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

test("only literal true opens the mutation gate", async () => {
  for (const allowMutation of ["false", 1, {}, []]) {
    const client = await createAgoragenticWorldAgentkitClient({
      signer: {},
      allowMutation,
      createAgentkitClientImpl: () => ({ fetch: async () => new Response(null, { status: 200 }) }),
    });
    await assert.rejects(
      () => client.fetch("/api/x402/example", { method: "POST" }),
      (error) => error.code === "mutation_not_authorized",
    );
  }

  const mutableClient = await createAgoragenticWorldAgentkitClient({
    signer: {},
    allowMutation: true,
    createAgentkitClientImpl: () => ({ fetch: async () => new Response(null, { status: 200 }) }),
  });
  assert.equal((await mutableClient.fetch("/api/x402/example", { method: "POST" })).status, 200);
});

test("blocks a cross-origin redirect before the AgentKit retry path", async (t) => {
  let destinationRequests = 0;
  const destination = createServer((_request, response) => {
    destinationRequests += 1;
    response.writeHead(200).end("unexpected");
  });
  await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => destination.close((error) => (error ? reject(error) : resolve()))));

  const destinationPort = destination.address().port;
  const source = createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${destinationPort}/signed-retry` }).end();
  });
  await new Promise((resolve) => source.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => source.close((error) => (error ? reject(error) : resolve()))));

  const client = await createAgoragenticWorldAgentkitClient({
    signer: {},
    baseUrl: `http://127.0.0.1:${source.address().port}`,
    allowInsecureLoopback: true,
    createAgentkitClientImpl: ({ fetch }) => ({ fetch }),
  });

  await assert.rejects(
    () => client.fetch("/redirect"),
    (error) => error.code === "redirect_blocked",
  );
  assert.equal(destinationRequests, 0);
});
