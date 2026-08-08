# AnyDoc Document Evidence Adapter

> **Convert a local office document into bounded Markdown, coverage-accounted evidence units, semantic-loss warnings, and an Agoragentic parse receipt without uploading the file or granting an agent more authority.**

This experimental adapter uses [`@firecrawl/anydoc`](https://github.com/firecrawl/anydoc) `0.1.7` as the local parser. AnyDoc is a fast MIT-licensed Rust library with Node bindings for Word, PowerPoint, spreadsheets, OpenDocument, RTF, EPUB, CSV, and text-based PDFs.

Agoragentic adds the layer AnyDoc intentionally does not provide:

```text
document bytes
→ content-based format detection
→ killable, resource-bounded AnyDoc child process
→ source and output hashes
→ hard-bounded evidence units with explicit coverage
→ known-loss and semantic-risk warnings
→ pending or completeness-blocked parse receipt
→ platform trap scan
→ owner-scoped ECF context packet
```

The adapter does not upload the file, call Firecrawl, use OCR, write memory, publish a listing, create x402 routes, spend, settle, or mutate trust. The pinned parser runs in a killable child process with a deadline, a V8 heap cap, bounded input/output/traversal, a read-only filesystem allowlist, a sanitized environment, and Node network APIs disabled before parser import. A successful result reports that network use was not observed within that Node API guard; it does not claim OS-level proof that native code made no network syscall.

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

The default input limit is 10 MiB; the adapter hard-caps configuration at 50 MiB. The parser defaults to a 30-second deadline and a 256 MiB V8 heap cap. Output Markdown is bounded and hard-split into units no larger than the configured chunk size, with at most 256 local evidence units. When a limit omits Markdown or structure, the exact covered/omitted character counts and completeness blockers are returned and the receipt is `incomplete`.

Explicit format aliases accepted by the CLI and API include `docm -> docx`, `pptm -> pptx`, `xlsm -> xlsx`, and `xlsb -> xlsx`, plus the corresponding presentation aliases in the package constants.

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

- runtime-verified AnyDoc package/version lineage for the production parser path;
- source filename, format, size, and SHA-256 hash;
- bounded Markdown, output hash, and explicit evidence coverage;
- document-model counts when AnyDoc exposes them;
- `agoragentic.evidence-unit.v1` chunks;
- a format-specific semantic-risk profile;
- a pending `agoragentic.parse-receipt.v1`, or an `incomplete` receipt when output, evidence, structure, or parser provenance is incomplete;
- an ECF handoff that remains blocked until the platform trap scan and owner policy review run;
- all authority flags set to false.

Raw source bytes and embedded asset bytes are not copied into the result.

Arbitrary in-process `anydocLoader` functions are rejected. A local custom parser module exists only as an explicit test hook; it still runs in the child boundary, reports `custom_parser_module` with no claimed version, reports network/OCR use as `unknown`, and blocks receipt completeness.

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
- disables Node network APIs before loading parser code and fails the parse if one is attempted;
- does not execute macros or embedded objects;
- does not extract embedded assets into the evidence packet;
- never approves its own authority;
- never treats parsed content as instructions;
- marks trap scanning as required and not yet completed;
- never represents a parse receipt as settlement, certification, trust, or universal correctness.

AnyDoc itself is an upstream dependency. This repository does not claim partnership, endorsement, or ownership of AnyDoc.

The portable boundary does not claim an OS-level network namespace around native machine code. It combines a pinned, runtime-version-checked AnyDoc native dependency with a sanitized child process and a Node API network deny guard; `parser.network.status` remains `not_observed` with `verified_absent: false`, and `parser.boundary.native_syscall_isolation` remains `false`, so downstream policy can distinguish that boundary from a container or VM network sandbox.

## Validation

```bash
npm run check
npm run test:adversarial
npm run smoke:anydoc
npm run pack:dry
```

The adversarial suite exercises hard splitting, exact coverage accounting, alias normalization, custom provenance, structure failures/truncation, blocked network attempts, and timeout termination. The smoke test exercises the real `@firecrawl/anydoc@0.1.7` package against an in-memory CSV and verifies runtime package lineage, process isolation, complete evidence coverage, and no-spend boundaries. CI also installs the generated tarball and reruns its packaged `check`, `test`, and `smoke:anydoc` scripts.

## License

Adapter code: Apache-2.0.

Upstream AnyDoc: MIT. Preserve its license and notices when redistributing substantial upstream code. This adapter calls the published package and does not copy its parser implementation.
