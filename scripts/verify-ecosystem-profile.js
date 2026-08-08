#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const defaultRoot = path.resolve(__dirname, '..');
const receiptEquivalencePatterns = [
  /\blocal receipts?\s+(?:is|are)\s+(?!not\b|never\b)(?:(?:an?\s+)?settlement receipts?|(?:the\s+)?same as\s+(?:an?\s+)?settlement receipts?|(?:identical|equivalent) to\s+(?:an?\s+)?settlement receipts?)\b/i,
  /\blocal receipts?\s+(?:equals?|constitutes?|serves? as|acts? as|counts? as|functions? as)\s+(?:an?\s+)?settlement receipts?\b/i,
  /\blocal receipts?\s+can be treated as\s+(?:an?\s+)?settlement receipts?\b/i,
  /\blocal receipts?\s*(?:=|:)\s*(?:an?\s+)?settlement receipts?\b/i,
  /\bsettlement receipts?\s+(?:is|are|equals?|constitutes?)\s+(?!not\b|never\b)(?:an?\s+)?local receipts?\b/i,
  /\blocal receipts?\s+(?:and|or)\s+settlement receipts?\s+(?:are\s+)?(?:equivalent|interchangeable|the same)\b/i,
];

function readJson(file, errors, root) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`${path.relative(root, file)} must contain valid JSON: ${error.message}`);
    return null;
  }
}

function stringLeaves(value, currentPath = '$') {
  if (typeof value === 'string') return [{ path: currentPath, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => stringLeaves(item, `${currentPath}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .flatMap(([key, item]) => stringLeaves(item, `${currentPath}.${key}`));
  }
  return [];
}

function hasAffirmativeReceiptEquivalence(text) {
  return receiptEquivalencePatterns.some((pattern) => pattern.test(String(text || '')));
}

function findProhibitedClaims(ecosystem) {
  const claims = [];
  for (const leaf of stringLeaves(ecosystem)) {
    if (/\bcertified\b/i.test(leaf.value)) {
      claims.push(`${leaf.path} contains an unscoped certified claim`);
    }
    if (/\bSOC 2 certified\b/i.test(leaf.value)) {
      claims.push(`${leaf.path} contains an unsupported SOC 2 certification claim`);
    }
    if (/\bguaranteed safe\b/i.test(leaf.value)) {
      claims.push(`${leaf.path} contains a guaranteed-safety claim`);
    }
    if (hasAffirmativeReceiptEquivalence(leaf.value)) {
      claims.push(`${leaf.path} equates a local receipt with a settlement receipt`);
    }
  }
  return [...new Set(claims)];
}

function findUnsupportedHarnessBrandClaims(text) {
  const claims = [];
  const value = String(text || '');
  if (/\bverifiable local receipts?\b/i.test(value)) {
    claims.push('claims that a local receipt is verifiable without naming a verification mechanism');
  }
  if (/intent\s*→\s*policy\s*→\s*approval\s*→\s*tool\s*→\s*receipt/i.test(value)) {
    claims.push('presents Harness Core as executing the tool instead of stopping at the host boundary');
  }
  return claims;
}

function verifyEcosystemProfile({ root = defaultRoot, quiet = false } = {}) {
  const errors = [];
  const ecosystemPath = path.join(root, 'ecosystem.json');
  const ecosystemSchemaPath = path.join(root, 'ecosystem.schema.json');
  const integrationsPath = path.join(root, 'integrations.json');
  const ecosystem = readJson(ecosystemPath, errors, root);
  const integrations = readJson(integrationsPath, errors, root);
  readJson(ecosystemSchemaPath, errors, root);

  if (ecosystem && integrations) {
    if (ecosystem.$schema !== './ecosystem.schema.json') {
      errors.push('ecosystem.json $schema must point to the included ./ecosystem.schema.json');
    }

    if (ecosystem.schema !== 'agoragentic.ecosystem-profile.v1') {
      errors.push(`ecosystem.json schema must be agoragentic.ecosystem-profile.v1; got ${JSON.stringify(ecosystem.schema)}`);
    }

    if (typeof ecosystem.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ecosystem.updated_at)) {
      errors.push('ecosystem.json updated_at must be an ISO date (YYYY-MM-DD)');
    }

    const manifestCount = Array.isArray(integrations.integrations) ? integrations.integrations.length : null;
    if (!Number.isInteger(manifestCount)) {
      errors.push('integrations.json integrations must be an array');
    } else if (ecosystem.inventory?.integration_count !== manifestCount) {
      errors.push(`ecosystem.json inventory.integration_count must equal integrations.json count (${manifestCount})`);
    }

    if (ecosystem.inventory?.integration_manifest !== './integrations.json') {
      errors.push('ecosystem.json inventory.integration_manifest must point to ./integrations.json');
    }

    const productIds = new Set();
    for (const product of ecosystem.products || []) {
      if (!product?.id) {
        errors.push('every ecosystem product needs an id');
        continue;
      }
      if (productIds.has(product.id)) errors.push(`ecosystem.json has duplicate product id: ${product.id}`);
      productIds.add(product.id);
    }

    for (const required of [
      'harness-core',
      'micro-ecf',
      'ecf-core',
      'fable5-codex',
      'triptych-os',
      'router-marketplace',
      'interchange',
    ]) {
      if (!productIds.has(required)) errors.push(`ecosystem.json missing required product: ${required}`);
    }

    const funnelIds = new Set();
    for (const funnel of ecosystem.funnels || []) {
      if (!funnel?.id || !funnel?.entrypoint) {
        errors.push('every ecosystem funnel needs id and entrypoint');
        continue;
      }
      if (funnelIds.has(funnel.id)) errors.push(`ecosystem.json has duplicate funnel id: ${funnel.id}`);
      funnelIds.add(funnel.id);
    }

    for (const required of ['build', 'context', 'operate', 'buy-sell', 'connect-market']) {
      if (!funnelIds.has(required)) errors.push(`ecosystem.json missing required funnel: ${required}`);
    }

    const buySell = (ecosystem.funnels || []).find((entry) => entry.id === 'buy-sell');
    if (buySell?.entrypoint !== 'https://agoragentic.com/start/browse/') {
      errors.push('buy-sell funnel must use the deployed /start/browse/ front door');
    }

    const marketplace = (ecosystem.products || []).find((entry) => entry.id === 'router-marketplace');
    if (marketplace?.url !== 'https://agoragentic.com/start/browse/') {
      errors.push('router-marketplace must use the deployed /start/browse/ front door');
    }

    const publicUrls = [
      ...(ecosystem.funnels || []).flatMap((entry) => [entry.entrypoint, entry.next]),
      ...(ecosystem.products || []).flatMap((entry) => [entry.repository, entry.url, entry.machine_catalog]),
    ].filter(Boolean);
    if (publicUrls.includes('https://agoragentic.com/marketplace/')) {
      errors.push('ecosystem.json must not point to the /marketplace/ homepage fallback');
    }

    const microEcf = (ecosystem.products || []).find((entry) => entry.id === 'micro-ecf');
    if (microEcf?.install !== 'npx agoragentic-micro-ecf@latest plan --dir .') {
      errors.push('Micro ECF must expose plan as its first install action');
    }
    if (microEcf?.install_after_explicit_approval !== 'npx agoragentic-micro-ecf@latest install --dir . --yes') {
      errors.push('Micro ECF must separate install --yes behind explicit approval');
    }

    for (const key of ['capabilities', 'public_proof', 'health', 'openapi', 'agents', 'mcp', 'x402']) {
      const url = ecosystem.live_truth?.[key];
      if (typeof url !== 'string' || !url.startsWith('https://')) {
        errors.push(`ecosystem.json live_truth.${key} must be an https URL`);
      }
    }

    errors.push(...findProhibitedClaims(ecosystem).map((claim) => `ecosystem.json prohibited claim: ${claim}`));

    const brandSystem = fs.readFileSync(path.join(root, 'docs', 'BRAND_SYSTEM.md'), 'utf8');
    const normalizedBrandSystem = brandSystem.toLowerCase();
    if (!brandSystem.includes('First-screen README contract')) {
      errors.push('docs/BRAND_SYSTEM.md must define the first-screen README contract');
    }
    if (!brandSystem.includes('Within the public OSS repository portfolio')) {
      errors.push('docs/BRAND_SYSTEM.md must scope the flagship priority to the public OSS repository portfolio');
    }
    if (!brandSystem.includes('Do not bake mutable counts')) {
      errors.push('docs/BRAND_SYSTEM.md must prohibit mutable counts in images');
    }
    if (!normalizedBrandSystem.includes('no local receipt is presented as settlement')) {
      errors.push('docs/BRAND_SYSTEM.md must preserve the local-receipt boundary');
    }
    if (!brandSystem.includes('intent → policy → approval → host boundary → local receipt')) {
      errors.push('docs/BRAND_SYSTEM.md must describe Harness Core as stopping at the host boundary');
    }
    if (!brandSystem.includes('inspectable, schema-checkable local receipt')) {
      errors.push('docs/BRAND_SYSTEM.md must scope local-receipt proof to inspection and schema checking');
    }
    errors.push(...findUnsupportedHarnessBrandClaims(brandSystem)
      .map((claim) => `docs/BRAND_SYSTEM.md unsupported Harness Core claim: ${claim}`));

    const harnessReadmePath = path.join(root, 'harness-core', 'README.md');
    const harnessHeroPath = path.join(root, 'harness-core', 'assets', 'harness-core-product-hero.svg');
    const harnessReadme = fs.readFileSync(harnessReadmePath, 'utf8');
    const harnessHero = fs.readFileSync(harnessHeroPath, 'utf8');

    for (const required of [
      'Put a policy gate and local proof around a proposed agent action.',
      'Host execution is outside the generic `run` path',
      'Local receipts are not settlement receipts',
      'Claude Code `PreToolUse`',
      'status: "stub"',
      'before_policy',
      'after_receipt',
      'Agent OS preview',
    ]) {
      if (!harnessReadme.includes(required)) {
        errors.push(`harness-core/README.md is missing flagship contract text: ${required}`);
      }
    }

    if (!harnessHero.includes('<title id="title">Agoragentic Harness Core</title>')) {
      errors.push('Harness Core hero must include an accessible title');
    }
    if (!harnessHero.includes('<desc id="desc">')) {
      errors.push('Harness Core hero must include an accessible description');
    }
    if (!harnessHero.includes('HOST BOUNDARY') || !harnessHero.includes('CONFIGURATION RECEIPT')) {
      errors.push('Harness Core hero must show the host boundary and configuration-receipt contract');
    }
    if (/\bwhat ran\b|\bnext safe action\b|>TOOL EXECUTION</i.test(harnessHero)) {
      errors.push('Harness Core hero must not claim execution/result fields that the local receipt does not emit');
    }
    if (/\b\d+\s+(?:services|listings|calls|agents)\b/i.test(harnessHero)) {
      errors.push('Harness Core hero must not bake mutable public counts into the image');
    }
  }

  if (!quiet) {
    for (const message of errors) console.error(`❌ ${message}`);
    if (!errors.length) console.log('✅ ecosystem profile verification passed');
  }

  return { ok: errors.length === 0, errors };
}

if (require.main === module) {
  const result = verifyEcosystemProfile();
  if (!result.ok) process.exitCode = 1;
}

module.exports = {
  findProhibitedClaims,
  findUnsupportedHarnessBrandClaims,
  hasAffirmativeReceiptEquivalence,
  verifyEcosystemProfile,
};
