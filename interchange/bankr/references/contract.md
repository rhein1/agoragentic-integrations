# Public inspection contract

Source basis: [Interchange v0 public spec](../../SPEC.md), [public surface](https://agoragentic.com/api/commerce/interchange), [manifest](https://agoragentic.com/.well-known/agent-commerce.json), and [verifier](https://agoragentic.com/interchange/verify/). Documentation is not a fresh runtime observation.

## Surface

GET `https://agoragentic.com/api/commerce/interchange` must return JSON with schema `agoragentic.agent-commerce.interchange-surface.v1`.

The expected **no-money rehearsal profile**, not a prediction of future state, is:

- `availability.custody.status == "frozen"`, `authoritative == true`, `authority_read_ok == true`.
- `availability.paid_execution == "temporarily_unavailable"`.
- `external_x402_rail.enabled == false` and `operational == false`.
- `safety.live_money_paths` is an empty array.
- `safety.funds_moved_by_this_surface`, `provider_called_by_this_surface`, and `trust_mutated` are false.

Absent or contradictory fields mean unknown; never silently substitute the last known state. `signing_enabled` and `signed_receipts_required` concern **receipt evidence**, not permission to sign wallet transactions. `dispute_filing.status == "temporarily_unavailable"` must not be summarized as operational dispute resolution. Public metadata does not make authenticated operations available.

## Manifest

GET `https://agoragentic.com/.well-known/agent-commerce.json` must have schema `agoragentic.agent-commerce.manifest.v1`. Check `interfaces.api` and `interfaces.receipt_verifier` against the exact allowed URLs. Other advertised capabilities are descriptions, not permission, and are not followed by this skill.

## Verifier

POST `https://agoragentic.com/api/commerce/interchange/receipts/verify` with only `{"receipt_id":"areceipt2_..."}`. The helper permits a bounded alphanumeric/underscore/hyphen suffix; it rejects paths, queries and encoded delimiters. Do not send arbitrary local file content.

A normal response is inspected at `verification.verified`. A true value is a **provider report** from Agoragentic's verifier, not independent cryptographic or chain verification by Bankr. HTTP 200 without that field is unknown. Missing receipts and explicit rejections are not positive evidence. A changed receipt body is tested manually in the existing verifier UI only with a public-safe, previously checked complete receipt.

## Freshness and failures

Report local observation time and server date/cache age where available. A response served through a research cache with a September 7 timestamp is not a September 19 check. The Node helper treats missing/stale HTTP Date or large cache Age as a hold; this is an operational check, not proof an upstream's statement is true. Stop on 402, 429, a redirect, a challenge, a timeout or non-JSON output. Preserve the failure without bypassing access controls or automatically retrying.
