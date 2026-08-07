# AnyDoc Semantic Conformance Harness

This harness tests the exact `@firecrawl/anydoc@0.1.7` package against small public-safe files that exercise known document-conversion risks.

It does **not** assert that AnyDoc preserves every source semantic. It asserts that the Agoragentic adapter:

- converts supported files locally;
- fails closed for an image-only PDF instead of silently invoking OCR;
- preserves source/output hashes and exact parser lineage;
- marks the result as non-source-exact;
- discloses format-specific known limitations;
- keeps trap scanning pending;
- keeps Agent OS context attachment blocked;
- grants no spend, wallet, deployment, publication, memory, or trust authority.

## Cases

| Case | Boundary exercised |
|---|---|
| CSV baseline | signature-less format and non-authoritative types |
| XLSX hidden/formatted values | hidden content, percent formatting, formulas, coordinates, merged cells |
| DOCX nested table | text recall versus recoverable table structure |
| PPTX untitled slides | presentation container boundaries and layout |
| Image-only PDF | explicit OCR-required failure |

## Run

```bash
python conformance/generate-fixtures.py
node conformance/run-conformance.mjs
cat conformance/report.json
```

Python fixture dependencies are CI-only and pinned in the workflow. Generated files and reports are not published as marketplace proof by this PR.

## Interpreting the report

A `pass` means the adapter represented the observed parser behavior honestly and maintained the Agoragentic authority boundary.

It does not mean:

- source-exact conversion;
- legal, financial, compliance, or accounting correctness;
- universal prompt-injection safety;
- OCR support;
- production listing readiness;
- certification or endorsement by Firecrawl.

The production capability gate remains `rhein1/agent-marketplace#1269`.
