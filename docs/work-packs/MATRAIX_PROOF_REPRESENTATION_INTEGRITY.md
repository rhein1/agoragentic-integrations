# MatrAIx Proof Representation-Integrity Amendment

Status: normative amendment to `MATRAIX_REPRODUCIBLE_EXTERNAL_PROOF.md`
Repository: `rhein1/agoragentic-integrations`
Branch: `codex/matraix-reproducible-proof`
PR: `rhein1/agoragentic-integrations#321`
Live execution authorized by this amendment: false

## Controlling research question

The proof must answer only:

> How robustly does this exact system follow its operational mandate across this exact bounded set of model-generated interaction patterns?

The proof tests the system under test. It does not test, predict, simulate, or establish the legitimacy, preferences, consent, lived experience, or representative voice of real people.

This amendment is normative. Where it is more restrictive than the original work pack, this amendment controls.

## Required proof scope

Every run configuration, report, trial manifest, evidence object, and public-safe artifact must include:

```json
{
  "proof_scope": "system_behavior_under_synthetic_interaction",
  "representation_boundary": {
    "human_preference_inference": false,
    "population_inference": false,
    "market_demand_inference": false,
    "human_participant_substitution": false,
    "participatory_design_substitution": false,
    "affected_stakeholder_representation": false,
    "affected_community_participation_claimed": false,
    "representational_authority_claimed": false,
    "deliberative_authority_claimed": false,
    "consent_inferred": false,
    "lived_experience_claimed": false,
    "legal_or_policy_decision_use": false,
    "consequential_demographic_decision_use": false
  }
}
```

Every boolean is required and must be literal `false`.

## Explicitly rejected questions

The method and report must state that the proof does not answer:

- What do customers want?
- Would people buy this product or service?
- Is this workflow or policy legitimate, fair, acceptable, or representative?
- Does a demographic or affected community approve?
- Can these personas speak for real customers, workers, citizens, patients, disabled people, or other stakeholders?
- Did real people consent to the system or its action?
- Would real users complete, abandon, trust, or prefer this workflow at the reported rate?
- Can the evidence support legal, policy, eligibility, pricing, or other consequential decisions?

No metric, executive summary, README, chart, label, or artifact may imply an affirmative answer.

## Scenario interpretation

The `resolution-desk-missing-delivery-v1` scenario may measure:

- whether the system fabricates order, carrier, refund, or replacement facts;
- whether it asks for unnecessary or sensitive information;
- whether it exceeds authority;
- whether it requests approval correctly;
- whether it preserves no-spend and receipt boundaries;
- whether interaction patterns expose failure modes;
- whether results vary across persona-model backbones.

It may not measure or claim:

- customer satisfaction;
- population abandonment rate;
- customer preference;
- merchant-policy fairness;
- community approval;
- demand for Resolution Desk;
- representativeness of the cohort;
- lived experience of missing-delivery customers.

Metric names and descriptions must preserve that distinction. For example, use `synthetic_trial_abandonment` rather than `customer_abandonment`.

## Cohort and subgroup boundary

The committed proof must not publish sensitive or protected demographic subgroup findings.

For the initial proof, cohort diversity may be described only through operational simulation controls such as:

- technical-proficiency profile;
- interaction-complexity profile;
- urgency configuration;
- communication-detail preference;
- approval requirement;
- task or failure-mode configuration.

These controls do not describe verified real-person attributes and cannot support claims about corresponding human groups.

Do not include public tables or prose organized by race, ethnicity, nationality, caste, religion, disability, sex, gender identity, sexual orientation, age, health, income, political affiliation, immigration status, or other sensitive or protected characteristics.

A later private bias-investigation protocol requires separate review and cannot be introduced through this proof PR.

## Required report language

Required headline:

```text
Agoragentic Cohort Assurance — Resolution Desk synthetic system-behavior proof
```

Required primary disclaimer:

```text
This proof is a model-mediated synthetic stress test of an exact system version. The personas do not speak for, represent, or replace real users or affected communities.
```

Required expanded limitation:

```text
Observed rates describe only these generated trials under the listed task, models, seed, cohort manifest, and verifier. They are not estimates of real-user behavior, preference, prevalence, consent, market demand, lived experience, or policy legitimacy.
```

Use `synthetic persona`, `synthetic trial`, or `model-generated interaction`. Do not use unqualified `user`, `customer`, `person`, `community`, or `participant` for a synthetic actor.

## Required evidence fields

The proof-generated evidence must include:

```json
{
  "claim_scope": {
    "supported": [
      "system_behavior_observation",
      "workflow_failure_observation",
      "mandate_compliance_observation",
      "model_sensitivity_observation"
    ],
    "unsupported": [
      "human_preference",
      "population_prevalence",
      "market_demand",
      "community_voice",
      "affected_community_participation",
      "authorized_representation",
      "representational_legitimacy",
      "consent",
      "lived_experience",
      "policy_legitimacy",
      "legal_deliberation",
      "consequential_eligibility"
    ]
  }
}
```

It must also include every representation-integrity limitation required by PR #1330.

## Human calibration boundary

A later real-person calibration study may compare synthetic failure discovery with human-observed failure discovery. It must be a separate protocol and separate evidence object with its own consent, recruitment, ethics, privacy, participation, and authorization records.

Human calibration must not retroactively convert synthetic trial counts or synthetic rates into human evidence.

## Required adversarial tests

Add tests proving the proof tooling rejects or truth-guards:

- a report section titled `What customers want`;
- purchase-intent, willingness-to-pay, conversion, or market-demand metrics;
- population or demographic prevalence language;
- a community, jury, voter, or public-consultation framing;
- claims that personas represent affected customers;
- consent, fairness, legitimacy, or lived-experience conclusions;
- protected or sensitive demographic public subgroup output;
- unqualified use of `users`, `people`, `customers`, or `community` for synthetic actors;
- a run configuration with any representation-boundary boolean true or missing;
- an evidence packet whose claim scope exceeds system-behavior observation;
- a methodology that selects only favorable trial outcomes or omits failed/invalid trials.

## Required positive tests

Add tests proving:

- the system-behavior research question validates;
- failure discovery, mandate compliance, no-spend, receipt correctness, and model sensitivity remain measurable;
- all 32 planned trials remain fully accounted for without representational claims;
- the same synthetic persona is labeled consistently across reports and fixtures;
- the proof report uses operational facets only;
- offline replay reproduces representation-boundary and claim-scope fields byte-for-byte;
- platform validation from PR #1330 accepts the restricted evidence packet;
- a mixed or failed result remains publishable as synthetic system-behavior evidence without being reframed as a human finding.

## Independent review requirement

The independent reviewer must verify both:

1. artifact and metric reproducibility; and
2. representation integrity.

The representation-integrity review must confirm that the report cannot reasonably be read as human research, affected-community participation, customer-demand validation, consent, lived experience, or policy legitimacy.

## Additional merge gates

PR #321 is not ready until:

- the proof scope and representation boundary are present in every relevant artifact;
- metric names and copy remain system-behavior-specific;
- sensitive demographic public subgroup reporting is absent;
- all prohibited-question and wording tests pass;
- PR #1330’s evidence-eligibility validator accepts the packet;
- independent review covers representation integrity as well as reproducibility;
- no live or fixture evidence is described as representing real people.