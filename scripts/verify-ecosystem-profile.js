#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ecosystemPath = path.join(root, 'ecosystem.json');
const integrationsPath = path.join(root, 'integrations.json');

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${path.relative(root, file)} must contain valid JSON: ${error.message}`);
    return null;
  }
}

const ecosystem = readJson(ecosystemPath);
const integrations = readJson(integrationsPath);

if (!ecosystem || !integrations) {
  process.exitCode = 1;
} else {
  if (ecosystem.schema !== 'agoragentic.ecosystem-profile.v1') {
    fail(`ecosystem.json schema must be agoragentic.ecosystem-profile.v1; got ${JSON.stringify(ecosystem.schema)}`);
  }

  if (typeof ecosystem.updated_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ecosystem.updated_at)) {
    fail('ecosystem.json updated_at must be an ISO date (YYYY-MM-DD)');
  }

  const manifestCount = Array.isArray(integrations.integrations) ? integrations.integrations.length : null;
  if (!Number.isInteger(manifestCount)) {
    fail('integrations.json integrations must be an array');
  } else if (ecosystem.inventory?.integration_count !== manifestCount) {
    fail(`ecosystem.json inventory.integration_count must equal integrations.json count (${manifestCount})`);
  }

  if (ecosystem.inventory?.integration_manifest !== './integrations.json') {
    fail('ecosystem.json inventory.integration_manifest must point to ./integrations.json');
  }

  const productIds = new Set();
  for (const product of ecosystem.products || []) {
    if (!product?.id) {
      fail('every ecosystem product needs an id');
      continue;
    }
    if (productIds.has(product.id)) fail(`ecosystem.json has duplicate product id: ${product.id}`);
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
    if (!productIds.has(required)) fail(`ecosystem.json missing required product: ${required}`);
  }

  const funnelIds = new Set();
  for (const funnel of ecosystem.funnels || []) {
    if (!funnel?.id || !funnel?.entrypoint) {
      fail('every ecosystem funnel needs id and entrypoint');
      continue;
    }
    if (funnelIds.has(funnel.id)) fail(`ecosystem.json has duplicate funnel id: ${funnel.id}`);
    funnelIds.add(funnel.id);
  }

  for (const required of ['build', 'context', 'operate', 'buy-sell', 'connect-market']) {
    if (!funnelIds.has(required)) fail(`ecosystem.json missing required funnel: ${required}`);
  }

  for (const key of ['capabilities', 'public_proof', 'health', 'openapi', 'agents', 'mcp', 'x402']) {
    const url = ecosystem.live_truth?.[key];
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      fail(`ecosystem.json live_truth.${key} must be an https URL`);
    }
  }

  const serialized = JSON.stringify(ecosystem);
  for (const banned of [
    /certified/i,
    /SOC 2 certified/i,
    /guaranteed safe/i,
    /local receipt[^.]{0,80}settlement receipt/i,
  ]) {
    if (banned.test(serialized)) fail(`ecosystem.json contains prohibited public claim: ${banned}`);
  }

  const brandSystem = fs.readFileSync(path.join(root, 'docs', 'BRAND_SYSTEM.md'), 'utf8');
  if (!brandSystem.includes('First-screen README contract')) {
    fail('docs/BRAND_SYSTEM.md must define the first-screen README contract');
  }
  if (!brandSystem.includes('Do not bake mutable counts')) {
    fail('docs/BRAND_SYSTEM.md must prohibit mutable counts in images');
  }
  if (!brandSystem.includes('local receipt is not')) {
    fail('docs/BRAND_SYSTEM.md must preserve the local-receipt boundary');
  }
}

if (!process.exitCode) console.log('✅ ecosystem profile verification passed');
