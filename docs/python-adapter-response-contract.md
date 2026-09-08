# Python Adapter Response Contract

AutoGen, CrewAI, LangChain, smolagents, and Syrin are distributed as standalone
Python adapter files. They therefore embed the small runtime guard locally while
sharing the hermetic vectors in
[`test/fixtures/python-adapter-response-contract.v1.json`](../test/fixtures/python-adapter-response-contract.v1.json).

## Response states

Core Execute, Register, Invoke, Match, and Search tools follow this order:

1. Decode JSON exactly once. A decode failure returns `upstream_invalid_json`
   and the HTTP status without returning raw response bytes.
2. Check the endpoint's accepted status. An HTTP failure returns only the local
   `upstream_http_error` code for 4xx/5xx or `unexpected_http_status` for another
   unaccepted status. It never copies an upstream `error`, `message`, full body,
   or `details` object into agent context, even when the text resembles a safe
   machine code.
3. Validate successful JSON before constructing a framework-specific success:
   Execute accepts HTTP 200 or 202 and requires a non-empty string `status`;
   Register requires a non-empty `api_key` and `agent.id`; Invoke requires a
   non-empty `invocation_id`; Match requires an explicit `providers` list; and
   Search requires either a root list or an explicit `capabilities` list.
4. A structurally invalid successful response returns
   `upstream_invalid_payload`. Empty Match and Search lists remain successful.

Each framework retains its established successful return type: JSON strings for
AutoGen, LangChain, and smolagents; readable text for CrewAI; and dictionaries
for Syrin. Optional Execute fields such as `provider` are not part of the
minimum validity contract; adapters that project the provider name safely
normalize absent, string, null, or object forms without rejecting an otherwise
valid accepted response.

## Wallet paths

Client-side Passport verification trims input and accepts only lowercase `0x`
followed by exactly 40 hexadecimal characters (hexadecimal digits may use either
case). Missing, path-like, query-like, percent-encoded, wrong-length, and
non-hexadecimal values return `invalid_wallet_address` before any HTTP request.
The validated path segment is URL-encoded before use.

This client rule is defense in depth, not a server security boundary. The hosted
`/api/passport/verify/{walletAddress}` route and its OpenAPI schema live in the
private Marketplace repository. Server-side validation and its public API
contract require a separate private change and deployment; this public adapter
work does not claim either one.

## Verification boundary

The contract suite is hermetic and makes no network or provider calls. Passing
it proves source behavior only. It does not prove hosted qualification,
deployment, provider availability, payment behavior, or live traffic adoption.
Likewise, merging the smolagents source does not publish or qualify the optional
Hugging Face Hub artifact; publication and remote runtime verification are a
separate release gate.
