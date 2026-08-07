# AnyDoc Document Evidence Adapter

> **Convert a local office document into bounded Markdown, evidence units, semantic-loss warnings, and a pending Agoragentic parse receipt—without uploading the file or granting an agent more authority.**

This experimental adapter uses [`@firecrawl/anydoc`](https://github.com/firecrawl/anydoc) `0.1.7` as the local parser. AnyDoc is a fast MIT-licensed Rust library with Node bindings for Word, PowerPoint, spreadsheets, OpenDocument, RTF, EPUB, CSV, and text-based PDFs.

Agoragentic adds the layer AnyDoc intentionally does not provide:

```text
document bytes
→ content-based format detection
→ local AnyDoc conversion
→ source and output hashes
→ bounded evidence units
→ known-loss and semantic-risk warnings
→ pending parse receipt
→ platform trap scan
→ owner-scoped ECF context packet
```

The adapter does not upload the file, call Firecrawl, use OCR, write memory, publish a listing, create x402 routes, spend, settle, or mutate trust.

## Run the local proof

```bash
cd examples/anydoc-document-evidence
npm install
node cli.mjs ./report.docx --out ./report.evidence.json
```

To write only Markdown:

```bash
node cli.mjs ./report.docx --markdown-only --out ./report.md
```

The default input limit is 10 MiB; the adapter hard-caps configuration at 50 MiB. Output Markdown is bounded and chunked into at most 256 local evidence units.

## JavaScript API

```javascript
import { convertFileToEvidence } from './agoragentic-anydoc.mjs';

const result = await convertFileToEvidence('./report.xlsx');

console.log(result.output.output_hash);
console.log(result.risk.semantic_risk);
console.log(result.ecf_handoff.blockers);
```

For in-memory bytes:

```javascript
import { convertBytesToEvidence } from './agoragentic-anydoc.mjs';

const result = await convertBytesToEvidence({
  bytes,
  filename: 'contract.docx',
});
```

## Output contract

The top-level schema is:

```text
agoragentic.anydoc-document-evidence.v1
```

It includes:

- exact AnyDoc package/version lineage;
- source filename, format, size, and SHA-256 hash;
- bounded Markdown and output hash;
- document-model counts when AnyDoc exposes them;
- `agoragentic.evidence-unit.v1` chunks;
- a format-specific semantic-risk profile;
- a pending `agoragentic.parse-receipt.v1`;
- an ECF handoff that remains blocked until the platform trap scan and owner policy review run;
- all authority flags set to false.

Raw source bytes and embedded asset bytes are not copied into the result.

## Important accuracy boundaries

AnyDoc is materially useful, but conversion is not source-exact. The adapter preserves known limitations instead of hiding them.

Especially important:

- spreadsheet hidden rows or columns may become visible;
- spreadsheet display formats can be lost, which can change interpretation;
- worksheet names and source coordinates may be incomplete;
- formulas are not independently recalculated;
- merged-cell ranges may be clipped;
- nested document tables may be flattened;
- slide boundaries and layout may be lossy;
- scanned or image-only PDFs require OCR;
- embedded assets require separate review;
- complex document reading order can remain ambiguous.

For spreadsheet, finance, contract, compliance, or other decision-sensitive use, the adapter requires semantic review before the output is treated as authoritative.

## Why this can be sold

The raw converter is free and local. The commercial product is the governed outcome around it:

### Document Evidence Compiler

```text
local or hosted conversion
+ source/output provenance
+ trap scanning
+ evidence units
+ owner-scoped context packet
+ parse receipt
+ quality/semantic checks
+ optional OCR fallback
```

### Premium scanned-document path

When AnyDoc returns `unsupported` for a scanned or image-only PDF, a separately authorized hosted adapter may use Firecrawl Parse with bounded OCR pages and Zero Data Retention where the selected account supports it. The OCR path is provider-gated and must not silently fall back, expose the Firecrawl key, or charge after a failed parse.

See [`listing-candidates.json`](listing-candidates.json). The candidates are not published, invocable, x402-enabled, or price-validated by this example.

## Safety boundary

This adapter:

- reads one local file chosen by the caller;
- performs no network request during conversion;
- does not execute macros or embedded objects;
- does not extract embedded assets into the evidence packet;
- never approves its own authority;
- never treats parsed content as instructions;
- marks trap scanning as required and not yet completed;
- never represents a parse receipt as settlement, certification, trust, or universal correctness.

AnyDoc itself is an upstream dependency. This repository does not claim partnership, endorsement, or ownership of AnyDoc.

## Validation

```bash
npm run check
npm test
npm run smoke:anydoc
npm run pack:dry
```

The smoke test exercises the real `@firecrawl/anydoc@0.1.7` package against an in-memory CSV and verifies no-network/no-spend boundaries.

## License

Adapter code: Apache-2.0.

Upstream AnyDoc: MIT. Preserve its license and notices when redistributing substantial upstream code. This adapter calls the published package and does not copy its parser implementation.
