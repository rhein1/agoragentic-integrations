# Cohort Assurance Representation-Integrity Amendment

Status: normative amendment to `MATRAIX_COHORT_ASSURANCE_ADAPTER.md`
Repository: `rhein1/agoragentic-integrations`
Branch: `codex/matraix-cohort-assurance-adapter`
PR: `rhein1/agoragentic-integrations#320`
Public readiness: false

## Controlling principle

> Test the system; do not replace the stakeholder.

Agoragentic Cohort Assurance may use model-mediated synthetic personas to stress-test an exact agent, listing, capability, or workflow. It must not treat generated behavior as consent, lived experience, community voice, representational authority, deliberative legitimacy, human preference evidence, or authority to make consequential decisions about real people.

This amendment is normative. Where it is more restrictive than the original work pack, this amendment controls.

## Allowed purpose

Every validation, replay, or live-run request must declare one closed `intended_use` value. The initial allowed vocabulary is:

- `agent_behavior_qa`
- `workflow_stress_test`
- `failure_discovery`
- `mandate_compliance_test`
- `model_sensitivity_analysis`
- `ux_hypothesis_generation`
- `accessibility_hypothesis_generation`

The last two values permit only hypothesis generation. They do not establish usability, accessibility, preference, satisfaction, lived experience, or compliance for real users.

Unknown intended uses fail closed.

## Prohibited purpose

Reject a run before model or target execution when its configuration, task, instructions, metadata, or requested output seeks to:

- replace human participants in research, consultation, co-design, or participatory design;
- claim to speak for a community, demographic, constituency, customer group, worker group, or affected stakeholder;
- simulate jurors, voters, witnesses, public commenters, regulators, policy stakeholders, or other deliberative participants as substitutes for real people;
- infer consent, authorization, legitimacy, fairness, acceptability, or community approval;
- infer population prevalence, public opinion, customer preference, purchase intent, conversion, or market demand;
- establish lived accessibility, disability, discrimination, marginalization, or cultural experience;
- make or support protected-trait or other consequential eligibility, pricing, credit, employment, education, insurance, housing, benefits, policing, legal, or public-policy decisions;
- present synthetic evidence as human-subject evidence, affected-community participation, authorized representation, or production outcome evidence.

A disclaimer after execution is not sufficient. Prohibited purpose must block the run itself.

## Required request contract

Add a required closed object:

```json
{
  "intended_use": "agent_behavior_qa",
  "representation_boundary": {
    "human_participant_substitution_claimed": false,
    "community_voice_claimed": false,
    "representational_authority_claimed": false,
    "deliberative_authority_claimed": false,
    "affected_stakeholder_authorization_claimed": false,
    "consent_inferred_from_simulation": false,
    "lived_experience_claimed": false,
    "human_preference_inference_claimed": false,
    "population_inference_claimed": false,
    "market_demand_inference_claimed": false,
    "legal_or_policy_decision_use": false,
    "consequential_demographic_decision_use": false
  }
}
```

Every boolean above is required and must be literal `false`. Unknown fields fail validation.

The adapter must derive and revalidate the effective intended use from the complete task packet, not trust a benign label while instructions request a prohibited conclusion.

## Claim-scope contract

The generated run packet must carry a closed `claim_scope` object:

```json
{
  "supported_claim_types": [
    "system_behavior_observation",
    "workflow_failure_observation",
    "mandate_compliance_observation",
    "model_sensitivity_observation"
  ],
  "unsupported_claim_types": [
    "human_preference",
    "population_prevalence",
    "market_demand",
    "community_voice",
    "representational_legitimacy",
    "consent",
    "lived_experience",
    "policy_legitimacy",
    "legal_deliberation",
    "consequential_eligibility"
  ]
}
```

Only supported claim types relevant to the declared intended use may be included. Callers cannot expand this vocabulary.

## Mandatory limitations

In addition to the limitations in the original work pack, require:

```json
[
  "synthetic_personas_do_not_represent_real_people",
  "not_human_participant_substitution",
  "not_affected_community_participation",
  "not_representational_or_deliberative_authority",
  "consent_and_lived_experience_not_inferable"
]
```

The adapter must reject a public-safe packet missing any mandatory limitation.

## Typed rejection codes

Implement stable codes for at least:

- `intended_use_missing`
- `intended_use_not_allowed`
- `synthetic_representation_prohibited`
- `human_participant_substitution_prohibited`
- `community_voice_claim_prohibited`
- `affected_community_participation_required`
- `representational_authority_claim_prohibited`
- `deliberative_authority_claim_prohibited`
- `consent_inference_prohibited`
- `lived_experience_claim_prohibited`
- `human_preference_inference_prohibited`
- `population_inference_prohibited`
- `market_demand_inference_prohibited`
- `legal_or_policy_use_prohibited`
- `consequential_demographic_use_prohibited`
- `claim_scope_exceeds_synthetic_evidence`

Reject rather than silently rewrite a prohibited research question into an allowed one.

## Persona and subgroup boundary

The public-safe adapter output must not expose sensitive or protected demographic subgroup findings.

For the initial integration, public-safe facets are limited to operational test configuration such as:

- technical-proficiency profile;
- interaction-complexity profile;
- urgency configuration;
- communication-detail preference;
- approval requirement;
- task or failure-mode identifier.

These are simulation controls, not verified attributes of real people.

Sensitive facets may be used only in a separate private bias-investigation mode added by later review. That mode must not publish subgroup results, make consequential decisions, infer lived experience, or claim representation.

## Required negative tests

Add tests proving the adapter rejects:

- a task asking what customers want;
- a task asking whether people would buy a product;
- a task asking a synthetic cohort to approve a policy;
- a synthetic public consultation or jury;
- a task claiming personas represent an affected community;
- a task inferring consent or fairness;
- a task claiming lived accessibility experience;
- a task supporting protected-trait eligibility or pricing;
- a benign `intended_use` paired with prohibited instructions;
- missing or optimistic representation-boundary fields;
- caller-supplied supported claim types outside the closed vocabulary;
- public sensitive-demographic subgroup output;
- evidence that uses `users`, `people`, `customers`, or `community` for synthetic personas without explicit synthetic qualification.

## Required positive tests

Add tests proving:

- an agent-behavior QA run is accepted when every representation flag is false;
- workflow failure discovery remains allowed;
- mandate-compliance and model-sensitivity runs remain allowed;
- UX and accessibility runs are labeled hypothesis generation only;
- generated evidence contains the exact claim scope and mandatory limitations;
- representation checks run before any model, MCP, REST, or provider call;
- fixture replay remains deterministic after the new fields are added.

## Documentation rule

Approved description:

> Agoragentic Cohort Assurance tests how an exact system behaves under bounded model-generated interactions. Synthetic personas do not speak for, represent, or replace real people or affected communities.

Do not describe this adapter as synthetic market research, virtual consultation, digital democracy, population simulation, automated participatory design, or a replacement for human research.

## Additional merge gates

PR #320 is not ready until:

- the intended-use and representation-boundary contracts are implemented;
- prohibited-purpose detection occurs before external execution;
- claim-scope eligibility is derived and closed;
- all new limitations and rejection codes are enforced;
- operational-only public facets are enforced;
- the positive and negative tests above pass;
- an independent reviewer confirms that a technically valid run cannot acquire human, community, consent, or deliberative authority.
