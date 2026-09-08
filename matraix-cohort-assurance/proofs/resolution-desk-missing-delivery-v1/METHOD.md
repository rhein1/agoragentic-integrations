# Offline replay method

Research question: How robustly does this exact system follow its operational
mandate across this exact bounded set of model-generated interaction patterns?
No live answer to that question exists in this fixture checkpoint.

The local dataset revision `local-operational-fixture/1` contains 16 synthetic
personas with operational complexity and urgency controls only. Selection sorts
their canonical SHA-256 hashes with seed 321, without replacement, and repeats
the same cohort for two explicitly fictional backbone identities. No external
dataset or real-person attribute is used. The fixtures are not claimed to be
MatrAIx-generated personas. Actual model IDs, revisions, inference configuration,
and an exact production target are still pending separate run preparation.

The task is `resolution-desk-missing-delivery-v1`, version 1. The exact subject is
the local `resolution-desk-contract-fixture/1` record format. No subject is called.
All records bind canonical config, cohort, task, subject, and model manifests.
The evaluator checks every planned persona/backbone pair exactly once, enforces
closed record fields, and derives counts and metrics from sanitized fixture
observations. There is no caller-supplied pass score or free-text report field.

Functional, mandate, approval, unsupported-claim, and privacy rates exclude
invalid/unverifiable observations and retain explicit denominators. Abandonment
uses every started fixture record. Zero-denominator values are null. Percentiles
use nearest rank; medians use the standard middle-value rule. No confidence
interval or population inference is computed. Fixture differences between the
two fictional backbones test arithmetic only; model sensitivity is not measured.

Every replayed attempted invocation needs a literal-zero preflight with exact
subject binding and all-false authority. HTTP 402, nonzero/ambiguous prices,
target/route drift, unknown effect fields, duplicate invocation/receipt IDs,
and missing or invalid authority stop replay. Missing receipts remain visible
as unverifiable/invalid records. Receipt verification means fixture consistency,
not a signature, platform observation, payment, or external authenticity.

Use the README commands from the exact PR commit being reviewed. Verify the
unsigned SHA-256 manifest, rerun into a fresh output filename, and compare bytes.
Replay requires Python 3.11+, Node.js 20+, and the checked-in source adapter.
Schema validation additionally requires the pinned jsonschema test dependency.
No credentials, network, model, dataset download, or spend is needed for replay.

The offline evidence packet is pinned to the schema and semantic-validator contract
from Marketplace commit `71799e0099ce30cd4e76e19e209e87122afce7b1`.
Because a repository-scoped Actions token cannot read the private platform repository,
CI validates the complete byte-hash-pinned schema snapshot, fixture accounting,
and canonical identity. These checks do not establish full platform semantic
eligibility. Use the documented `--platform-root` option to invoke the actual
platform validator from a clean checkout at that exact commit.

Independent live reproduction is not yet runnable. Before implementing or running
it, choose exact model revisions
from two materially distinct backbones, pin target code/version and dataset
license/provenance, and separately obtain owner authorization with an explicit
provider-cost cap. Use operator-supplied environment credentials and a fresh
output directory. No credentials or private artifacts should be sent to this
repository. The existing adapter's `run` remains fail-closed.
