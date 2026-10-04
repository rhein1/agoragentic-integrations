"""Reproduce a derived v2.11.2 ledger fixture; not a scanner qualification.

Explicit read-only network probe, separate from the offline Node test suite.
Downloads two immutable public source files, checks their exact bytes, then runs
the upstream stdlib-only ledger and the isolated reducer against synthetic events.
Writes JSON to stdout only. No skills, scanner SDK, provider or credentials used.
"""

import ast
import hashlib
import json
import urllib.request

COMMIT = "69dcdfb74487d361ba4c811d088cfdea2ff3a9dc"
BASE = f"https://raw.githubusercontent.com/NVIDIA/SkillSpector/{COMMIT}/"
SOURCE_HASHES = {
    "src/skillspector/inspection_ledger.py":
        "sha256:4234c7bf9177108f69c4fabc4d711949268b0ae72757e171657931db0828c024",
    "src/skillspector/state.py":
        "sha256:fde886a73f3003ec0e8bb13de32f296c59405de9808446c3ee8efbf0178654cf",
}
sources = {}
for source_path, expected_hash in SOURCE_HASHES.items():
    with urllib.request.urlopen(BASE + source_path, timeout=20) as response:
        source_bytes = response.read()
    if "sha256:" + hashlib.sha256(source_bytes).hexdigest() != expected_hash:
        raise RuntimeError(f"Pinned source mismatch: {source_path}")
    sources[source_path] = source_bytes.decode("utf-8")

# Python 3.11+ supplies this typing declaration in stdlib. Only that import is
# substituted; the pinned reducer/finalizer implementation is unchanged.
ledger_source = sources["src/skillspector/inspection_ledger.py"].replace(
    "from typing_extensions import TypedDict", "from typing import TypedDict"
)
ledger = {"__name__": "pinned_inspection_ledger"}
exec(compile(ledger_source, "inspection_ledger.py", "exec"), ledger)
state_tree = ast.parse(sources["src/skillspector/state.py"])
selected = [
    node for node in state_tree.body
    if isinstance(node, ast.FunctionDef) and node.name == "merge_inspection_ledger"
]
if len(selected) != 1:
    raise RuntimeError("Pinned reducer declaration mismatch")
reducer_module = ast.Module(body=selected, type_ignores=[])
ast.fix_missing_locations(reducer_module)
reducer = {
    name: ledger[name] for name in (
        "MAX_INSPECTION_LEDGER_EVENTS", "ledger_event", "LedgerOutcome",
        "LedgerRecordType", "LedgerReason",
    )
}
exec(compile(reducer_module, "state.py", "exec"), reducer)

ANALYZERS = [
    "static_patterns_prompt_injection", "static_patterns_data_exfiltration",
    "static_patterns_privilege_escalation", "static_patterns_supply_chain",
    "static_patterns_harmful_content", "static_patterns_excessive_agency",
    "static_patterns_output_handling", "static_patterns_system_prompt_leakage",
    "static_patterns_memory_poisoning", "static_patterns_tool_misuse",
    "static_patterns_rogue_agent", "static_patterns_agent_snooping",
    "static_patterns_anti_refusal", "static_patterns_ssrf",
    "static_patterns_deserialization", "static_yara",
]


def run(count):
    events = [
        ledger["ledger_event"](
            outcome=ledger["LedgerOutcome"].COMPLETED, phase="static",
            analyzer_id=ANALYZERS[index % 16], path="SKILL.md",
            start_line=index + 1, end_line=index + 1,
        ) for index in range(count)
    ]
    merged = reducer["merge_inspection_ledger"]([], events)
    statuses = [
        ledger["analyzer_status_event"](
            analyzer_id=analyzer, status="completed",
            planned_work=[
                {key: event[key] for key in (
                    "work_id", "path", "start_line", "end_line",
                )}
                for event in events if event.get("analyzer_id") == analyzer
            ],
        ) for analyzer in ANALYZERS
    ]
    completeness, _ = ledger["finalize_ledger"]({
        "components": ["SKILL.md"], "findings": [],
        "inspection_ledger": merged, "analyzer_status_events": statuses,
        "effective_finding_ids": [],
    })
    return {
        "requested_events": count, "merged_events": len(merged),
        "overflow_marker": {
            key: merged[-1].get(key) for key in (
                "phase", "outcome", "reason_code", "observed_records", "limit_records",
            )
        } if merged[-1].get("phase") == "ledger_output" else None,
        "analysis_completeness": completeness,
    }


print(json.dumps({
    "description": "Derived pinned reducer/finalizer projection over synthetic events; not a full scan report",
    "commit": COMMIT, "sha256": SOURCE_HASHES,
    "results": [run(10000), run(10001)],
}, indent=2, default=str))
