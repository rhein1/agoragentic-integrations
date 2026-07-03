import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateGrowthExampleFile } from "../scripts/validate-growth-examples.mjs";

function makeFixture(source, name = "x402_execute_fixture.mjs") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "growth-validator-"));
  const dir = path.join(root, "examples", "agoragentic-growth", "fixture");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, source, "utf8");
  return { root, file };
}

function findingCodes(source, name) {
  const fixture = makeFixture(source, name);
  return validateGrowthExampleFile(fixture.file, { root: fixture.root }).map((finding) => finding.code);
}

test("accepts guarded x402 paid retry examples", () => {
  const codes = findingCodes(`
    export async function x402Fetch(url, { fetchImpl, pay }) {
      const first = await fetchImpl(url);
      if (first.status !== 402) return first;
      const paymentRequired = first.headers.get("payment-required");
      if (!paymentRequired) {
        throw new Error("Received HTTP 402 without payment-required header");
      }
      const payment = await pay(paymentRequired, { challenge: JSON.parse(paymentRequired) });
      const paid = await fetchImpl(url, { headers: { authorization: payment.authorizationHeader } });
      if (paid.status === 402) {
        throw new Error("Paid request received another HTTP 402 challenge; refusing to re-authorize payment");
      }
      return paid;
    }
  `);

  assert.deepEqual(codes, []);
});

test("rejects static relative imports that point at missing generated siblings", () => {
  const codes = findingCodes(`
    import { helper } from "./missing-sibling.mjs";
    export function demo() {
      return helper();
    }
  `);

  assert.deepEqual(codes, ["missing_static_relative_import"]);
});

test("does not reject optional fallback import specifier strings", () => {
  const codes = findingCodes(`
    export async function loadOptionalClient() {
      const candidates = ["../lib/x402-client.mjs"];
      for (const specifier of candidates) {
        try {
          const mod = await import(specifier);
          if (mod.x402Fetch) return mod.x402Fetch;
        } catch {}
      }
      return null;
    }
  `);

  assert.deepEqual(codes, []);
});

test("rejects paid x402 flows that do not fail closed on missing payment-required", () => {
  const codes = findingCodes(`
    export async function x402Fetch(url, { fetchImpl, pay }) {
      const first = await fetchImpl(url);
      if (first.status !== 402) return first;
      const paymentRequired = first.headers.get("payment-required");
      const payment = await pay(paymentRequired, {});
      const paid = await fetchImpl(url, { headers: { "payment-signature": payment.paymentSignature } });
      if (paid.status === 402) {
        throw new Error("Paid request received another HTTP 402 challenge; refusing to re-authorize payment");
      }
      return paid;
    }
  `);

  assert(codes.includes("x402_missing_challenge_not_fail_closed"));
});

test("rejects paid x402 flows that allow a second 402 after authorization", () => {
  const codes = findingCodes(`
    export async function x402Fetch(url, { fetchImpl, pay }) {
      const first = await fetchImpl(url);
      if (first.status !== 402) return first;
      const paymentRequired = first.headers.get("payment-required");
      if (!paymentRequired) {
        throw new Error("Received HTTP 402 without payment-required header");
      }
      const payment = await pay(paymentRequired, {});
      return fetchImpl(url, { headers: { authorization: payment.authorizationHeader } });
    }
  `);

  assert(codes.includes("x402_paid_retry_reauthorizes_or_replays"));
});
