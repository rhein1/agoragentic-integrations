# Proposed standalone Risk Fork repository

Recommendation: give Risk Fork its own public Apache-2.0 repository, with
`rhein1/risk-fork` as a proposed name. This is a migration plan, not confirmation
that the repository exists. Creating, publishing, or transferring a repository
is a separate owner decision. Keep `@agoragentic/risk-fork` and the author/NOTICE
attribution stable. Open source availability is not production activation.

## Public boundary

Move only reviewed public core history and source: provider-neutral contracts,
controller, classifier, taint/clean-commit boundaries, framework adapters,
PostgreSQL authority/handle adapters, schemas/migrations, public runbooks,
reference examples, tests, and credential-free qualification artifacts. Review
the local demo and managed-service scaffold as explicit separate tranches rather
than silently expanding the core package's distribution.

Preserve Apache-2.0 LICENSE, NOTICE, AUTHORS, CITATION, and relevant third-party
notices. Do not copy private Marketplace source, Full ECF, host control-plane
material, private operator evidence, customer data, environment files, keys,
database files, generated dependency trees, tarballs, or deployment configuration.
Do not publish the private/unpublished hosted-MCP package or copy private host
wiring as a side effect of this source migration.

## Migration gates

1. Choose the repository name and reviewed path/history boundary. Produce and
   inspect a history-preserving filtered export in a new local directory;
   never rewrite the shared integrations repository. Scan every exported
   historical blob for secrets/private material before publication.
2. Add standalone contribution/security docs and CI: supported Node versions,
   local containment tests, package consumer/offline install, static/dependency
   scans, and real disposable PostgreSQL race/role/TLS suites. Use exact source
   commits for release provenance and leave provider qualification default-off.
3. Update package repository/homepage/issues and docs/discovery links to the
   actual new location. Maintain a compatibility pointer in integrations so
   existing developers do not lose install and onboarding paths.
4. Reconcile sibling dependencies before moving paths. The hosted-MCP builder
   currently hashes repository-relative core inputs and copies reviewed assets.
   It needs a reviewed exact-commit source acquisition or exact package/digest
   contract; a URL replacement is not enough. Preserve an explicit compatibility
   source mirror until standalone reproducibility and digest lineage are proven.
5. Validate the entire exported history and packed artifact independently. Only
   then create/push the approved repository and update the integration pointer.
   Do not manufacture replacement tags, rewrite upstream history, publish a
   package, or release a deployment as a side effect of the split.

## Developer distribution

Source checkout and the future verified npm package are separate distribution
lanes. Framework authors install the library and enforce interception on their
host; the model does not choose whether to bypass protection. Hosting, provider
credentials, budgets, and operational support can be commercial services while
the reviewed core remains Apache-2.0. No paid offering, package publication, or
universal agent enrollment is implied by this plan.

The current installation and status remain in [README.md](./README.md).
The new [stateless host runbook](./STATELESS_HOST_RUNBOOK.md) documents source
wiring. Production work remains tracked in the existing integrations issues
until a separately reviewed migration explicitly moves those records.
