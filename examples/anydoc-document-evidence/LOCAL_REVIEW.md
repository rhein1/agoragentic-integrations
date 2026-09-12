# Local document evidence review

This is a human inspection step over the existing AnyDoc adapter, not a replacement parser, hosted upload service, new receipt format, or automatic ECF importer.

After `npm ci` in this directory:

```sh
node review.mjs document ./example.docx ./example.review.html
```

The document mode calls the unchanged pinned adapter, rereads the explicitly selected file within the existing 50 MiB ceiling, verifies its source hash, and writes a new private report. The adapter's default 10 MiB input cap still applies. The second read detects ordinary changes between parsing and review; it is not an immutable filesystem snapshot.

To inspect an existing packet without running a parser:

```sh
node cli.mjs ./example.docx --out ./example.evidence.json
node review.mjs packet ./example.evidence.json ./example.review.html
```

Packet mode does not independently possess the source bytes and labels the source hash as an unverified packet claim. JSON input is limited to 16 MiB and output HTML to 32 MiB. Existing output paths are never overwritten. A write failure may leave a partial new private file; inspect/delete that exact file explicitly rather than retrying into it. Parent-directory ownership remains the caller's responsibility. This is not protection from a privileged hostile filesystem writer.

## What is checked

The review profile checks supported packet identity; forced-false authority and pending handoff flags; source identity; output digest; bounded ordered evidence-unit coverage; unit and aggregate hashes; receipt identity and hash/count/coverage/completeness binding; and inconsistent completeness claims. This is a focused consumer profile, not exhaustive validation of every field in the full adapter schema. Cryptographic consistency is not signature verification, parser authentication, source-exact extraction, semantic correctness, or a completed commercial outcome.

Every document-derived character is HTML-escaped. Markdown is displayed literally, without executing links, images, scripts, styles, or embedded HTML. The report has a restrictive CSP, no script, no form, and no remote assets. It contains private extracted text and must not be treated as public-safe merely because source bytes are absent.

The existing `source_char_range` values are offsets in the extracted JavaScript/UTF-16 Markdown string, not verified page/cell/source-document coordinates. The UI states that distinction explicitly. The original evidence JSON remains the producer artifact for later authorized review; the HTML does not rewrite it.

## Remaining gates

Trap scanning, semantic review, principal policy, and owner-scoped context attachment remain outstanding. The report offers no approval button or automatic Memory write. Hosted route/schema reconciliation, restricted upload transport, paid OCR, pricing, listing publication, x402, and production activation remain separate work. No claim that the Document Evidence Compiler is fully launched follows from this patch.

## Validation

```sh
node --test review.test.mjs
node --test review-adapter.test.mjs
npm run check
npm run test:adversarial
npm run verify:packed
```

Nine provider-free tests passed locally on Linux / Node 22.16.0. A synthetic report rendered using installed Chromium 144.0.7559.96 and Playwright 1.57.0 without horizontal overflow at widths 1100 and 375. File-URL navigation was denied by that browser's administrator policy, so the visual check used explicitly loaded synthetic HTML through `set_content`; it does not prove file-URL behavior in a user's browser. Browser policy was not changed.

The real pinned-AnyDoc CSV producer-to-review test is part of the normal and packaged test commands. Native parser installation/execution, full conformance, and package checks were not available in the source-subset implementation environment. Exact-head CI and independent review must provide that evidence before merge. Do not substitute a synthetic packet test for producer/consumer conformance.
