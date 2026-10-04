# SkillSpector + Agoragentic

**Status: Beta**

SkillSpector is a local security scanner for agent skills. Use it as an
admission scan before a skill is listed, installed into a governed agent
workspace, or attached to an Agent OS harness/export packet.

This adapter is a local scan contract only. It does not publish skills, create
trust badges, mutate seller reputation, call hosted providers, or move funds.
Risk Fork integration is source-only and default-off; this evidence packet does
not enable, rearm, invoke, or activate Risk Fork.

## Source and install pin

| Field | Evidence |
|-------|----------|
| Upstream | `https://github.com/NVIDIA/SkillSpector` |
| Reviewed version | `2.11.2` |
| Reviewed tag commit | `69dcdfb74487d361ba4c811d088cfdea2ff3a9dc` |
| Reviewed wheel SHA-256 | `9e0eb261d63e7ae92f94177a44aeb8fef5e0ceeaa4d09135780baf94cbc420ec` |
| License | Apache-2.0 |

Install the reviewed release wheel with pip's URL hash check:

```bash
python -m pip install \
  "https://github.com/NVIDIA/SkillSpector/releases/download/v2.11.2/skillspector-2.11.2-py3-none-any.whl#sha256=9e0eb261d63e7ae92f94177a44aeb8fef5e0ceeaa4d09135780baf94cbc420ec"
```

The release tag resolves to the reviewed source revision above. The URL hash
binds installation to the exact reviewed wheel. The wheel hash alone does not
bind its interpreter or dependency closure; an admission host must separately
hash the resolved Python runtime and installed dependency set as
`scanner.runtime_closure_hash`. Do not substitute an unpinned latest release.

Use the Risk Fork helpers for canonical provenance digests:

- `hashSkillSpectorRuntimeClosure()` accepts the Python implementation, exact
  Python version, platform tag, and every resolved distribution as a sorted
  `{name, version, artifact_hash}` set. It requires the reviewed SkillSpector
  version and wheel hash to be present. Distribution names use PEP 503
  normalization (`[-_.]+` becomes `-`, then lowercase) before sorting and
  duplicate detection.
- `hashSkillSpectorRulesManifest()` accepts every installed
  `skillspector/nodes/analyzers/static_*.py` and `skillspector/yara_rules/*`
  file as a sorted `{path, hash}` set tied to the reviewed wheel hash.
- `hashSkillSpectorComponentManifest()` normalizes and hashes the exact component
  inventory independently enumerated from the candidate package.

All three helpers use Risk Fork canonical JSON hashing. The host supplies the
resulting hashes to the adapter and recomputes them in the branded verifier.
Candidate skill files, metadata, configuration, baselines, and suppressions
cannot select or alter these manifests.

## Local scan

```bash
skillspector scan <path> --no-llm --format json --output report.json --fail-on-incomplete
```

`--no-llm` disables SkillSpector's LLM analysis; it is not network isolation.
The scanner process still requires separately enforced network controls and
separate network-enforcement evidence. The admission contract records the
reviewed invocation, package/source hashes, scanner binding, report hashes,
coverage, and bounded result fields so those controls cannot be inferred from
the command line alone.

The JSON report is untrusted data. Treat it as data-only input, discard raw
report text and private skill content from admission evidence, and retain only
the normalized hash-bound fields in
[`skillspector.admission.example.json`](./skillspector.admission.example.json).
If the v2.11.2 output cap omits unique findings, the adapter records
`skillspector_output_truncated` and returns an incomplete result. The v2.11.2
JSON shape has no separate occurrence-truncation marker, so the adapter also
records the emitted occurrence count and conservatively treats a report that
reaches the reviewed 10,000-record ceiling as incomplete.

Baselines and suppressions are owner-controlled policy inputs. They must not be
provided by the candidate skill or accepted from the report as an admission
override. The reviewed contract requires them to be disabled, rejects candidate
baseline/suppression fields, and does not treat a suppressed result as clear.

## Agoragentic mapping

```text
Candidate skill
  -> local SkillSpector scan
  -> normalized hash-bound admission evidence packet
  -> existing Agent OS scorecard/canary evidence fields
  -> human or policy decision before listing/install
```

SkillSpector risk output composes with the existing Agoragentic scorecard and
canary evidence model. It does not create a parallel trust vocabulary or
publish `verified` status from SkillSpector alone.

## Admission evidence fields

| Field | Meaning |
|-------|---------|
| `subject` | Opaque package/source references plus hashes binding the prepared bytes |
| `binding` | Descriptor request, operation, and effective configuration hashes |
| `scanner` | SkillSpector version, immutable source revision, wheel hash, runtime/dependency closure hash, and owner-controlled canonical rules hash |
| `invocation` | Closed reviewed static/no-LLM command settings, including baseline/suppression flags |
| `network_enforcement` | Separate deny-all or explicitly unknown network-control evidence |
| `report` | Opaque report reference, raw report hash, normalized projection hash, and validity window |
| `coverage` | Completeness, exact host-matched component-manifest hash, component/inspection counts, and bounded limitations |
| `result` | Normalized score, severity, recommendation, counts, outcome, and bounded reason codes |
| `authority_flags` | Explicit advisory-only and no-trust/no-execution/no-commit/no-spend/no-settlement flags |
| `evidence_hash` | Canonical hash of the complete evidence object, excluding the hash field itself |

No raw report text, source files, snippets, credentials, candidate baselines, or
candidate suppressions belong in this packet.

When Risk Fork admission is enabled, the clean host must construct a branded
`createTrustedSkillSpectorAdmissionVerifier()` callback. That callback must
independently hash the actual source package, reconstructed package, raw report,
the canonical component manifest, canonical owner rules, scanner
runtime/dependency closure, and deny-all network control receipt. Use
`hashSkillSpectorComponentManifest()` for the closed report/host inventory
projection. The callback returns those expected bindings to the host boundary;
it must not copy values from the supplied evidence packet.

## Safety boundary

- Scan locally; do not upload private skill source unless the owner explicitly
  approves an export.
- Keep scanner runtime network isolation and its evidence separate from
  `--no-llm`.
- Treat results as advisory admission evidence until a human or policy gate
  accepts them.
- Keep the runtime trust vocabulary stable: `verified`, `reachable`, `failed`.
- Do not use this adapter to bypass sandbox verification, canary evidence, or
  owner approval.
- Keep Risk Fork source-only/default-off; this adapter grants no activation,
  execution, trust, spend, settlement, or production authority.
