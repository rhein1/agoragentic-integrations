# AnyDoc Semantic Conformance Harness

This harness tests the lockfile-pinned `@firecrawl/anydoc@0.1.7` package against small public-safe files that exercise known document-conversion risks.

It does **not** assert that AnyDoc preserves every source semantic. It verifies that the adapter:

- runs the installed package in a killable child process with a deadline, V8 heap bound, sanitized environment, and Node permission boundary;
- reports installed parser and native-binding provenance instead of trusting hard-coded metadata;
- hard-splits evidence units and accounts for every covered or omitted character;
- fails closed for an image-only PDF instead of silently invoking OCR;
- independently recomputes fixture, source, parser-output, bounded-output, and evidence-coverage hashes;
- marks the result as non-source-exact and discloses format-specific limitations;
- blocks incomplete output, structure failures, unreviewed assets, and unattested custom parsers;
- keeps trap scanning and Agent OS context attachment pending;
- validates every spend, wallet, deployment, publication, memory, trust, and receipt-boundary flag.

The adapter-level network guard blocks Node built-in and global network APIs. It cannot prove that a native dependency made no raw syscall. CI therefore runs this harness inside a Docker container with `--network none`, finite memory/CPU/PID limits, a read-only source mount, no capabilities, and `no-new-privileges`. The harness independently checks those properties before setting `scope.no_network` to `true`.

## Cases

| Case | Boundary exercised |
|---|---|
| CSV baseline | signature-less format and non-authoritative types |
| Long CSV | hard chunk limits, ordered-prefix coverage, and incomplete-receipt blocker |
| XLSX hidden/formatted values | hidden content, percent formatting, formulas, coordinates, merged cells |
| XLSM alias | advertised macro-format alias normalizes to canonical `xlsx` |
| DOCX nested table | text recall versus recoverable table structure |
| PPTX untitled slides | presentation container boundaries and layout |
| Image-only PDF | explicit OCR-required failure |

The Python generator reopens and verifies the source-side facts before writing `generated/fixture-manifest.json`. The Node harness checks every fixture hash, the full generator dependency inventory, and the hash-locked requirements file against that manifest before invoking AnyDoc.

## Run locally

```bash
python -m pip install --require-hashes -r conformance/requirements.txt
python conformance/generate-fixtures.py
node conformance/run-conformance.mjs
cat conformance/report.json
```

A direct local run is useful for semantics, hashes, and authority checks, but reports `scope.no_network: false` unless it independently observes the required OS sandbox.

CI uses the equivalent of:

```bash
docker run --rm --network none --read-only \
  --memory 768m --memory-swap 768m --cpus 1 --pids-limit 64 \
  --cap-drop ALL --security-opt no-new-privileges \
  -v "$PWD:/work:ro" -v "$REPORT_DIR:/out:rw" -w /work \
  node:24-bookworm-slim \
  node conformance/run-conformance.mjs /out/report.json --require-os-sandbox
```

Python fixture dependencies are conformance-only and fully pinned with hashes in `conformance/requirements.txt`. Generated files and reports are not package inputs or marketplace proof. The uploaded report contains hashes, source-fact labels, limits, and statuses, but no Markdown excerpts or raw document bytes.

## Interpreting the report

A `pass` means the adapter represented the observed parser behavior honestly and maintained the tested authority boundary under the recorded sandbox.

It does not mean:

- source-exact conversion;
- legal, financial, compliance, or accounting correctness;
- universal prompt-injection safety;
- OCR support;
- production listing readiness;
- certification or endorsement by Firecrawl.

The production capability gate remains `rhein1/agent-marketplace#1269`.
