# Contributing Conformance Fixtures and Adapters

Conformance contributions must remain offline, deterministic, license-compatible, bounded, and reviewable.

## Required evidence

1. Name the upstream protocol and exact public version or immutable revision.
2. Link the source and record its license compatibility.
3. Explain the field-to-language-neutral mapping without embedding credentials, signatures, payment payloads, prompts, tool output, or private owner data.
4. Add at least one positive vector and adversarial negative vectors for every supported state transition.
5. Add tests showing unsupported versions and unknown states fail closed.
6. Update the manifest, schemas, documentation, and reusable workflow paths together.

## Review boundary

- Parsing is not signature verification.
- Merchant-declared fulfillment is not independently verified delivery.
- Settlement is not outcome validation.
- A receipt hash is not a signature or provenance proof.
- A passing vector is not certification, endorsement, legal compliance, or universal production compatibility.

Do not add a protocol adapter based on private or mutable documentation. Do not add live credentials, network canaries, funded tests, or provider calls. External adopters should pin the suite commit and submit only public-safe bounded reports after their own privacy review.
