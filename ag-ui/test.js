#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Simple regex-based TypeScript stripper to run unit tests in plain node without dependencies
function runTsTest() {
  const tsPath = path.join(__dirname, 'agoragentic_ag_ui.ts');
  let code = fs.readFileSync(tsPath, 'utf8');

  // Strip imports/exports/types/interfaces/annotations
  code = code
    .replace(/export\s+class/g, 'class')
    .replace(/public\s+translateEvent/g, 'translateEvent')
    .replace(/private\s+dryRun/g, 'dryRun')
    .replace(/:\s*AgoragenticEvent/g, '')
    .replace(/:\s*AgUiEvent/g, '')
    .replace(/:\s*boolean/g, '')
    .replace(/:\s*Record<string,\s*any>/g, '')
    .replace(/:\s*string/g, '')
    .replace(/:\s*JsonObject/g, '')
    .replace(/:\s*any/g, '')
    .replace(/constructor\(options:.*?= \{\}\)/g, 'constructor(options = {})')
    .replace(/export\s+interface\s+\w+\s+\{[\s\S]*?\}/g, '')
    .replace(/as\s+T/g, '')
    .replace(/\?\?/g, '||');

  // Add module.exports for the test environment
  code += '\nmodule.exports = { AgoragenticAgUiAdapter };';

  // Evaluate the stripped code
  const tempModule = { exports: {} };
  const fn = new Function('module', 'exports', code);
  fn(tempModule, tempModule.exports);

  const { AgoragenticAgUiAdapter } = tempModule.exports;
  const adapter = new AgoragenticAgUiAdapter();

  // Load the mock events fixture
  const fixturesPath = path.join(__dirname, 'fixtures', 'events.json');
  const events = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));

  const expectedMappings = {
    quote_requested: { event: 'quote/start', uiHint: 'toast' },
    quote_ready: { event: 'quote/result', uiHint: 'card' },
    approval_required: { event: 'human/approval', uiHint: 'modal' },
    execute_started: { event: 'tool/start', uiHint: 'inline' },
    provider_matched: { event: 'state/patch', uiHint: 'inline' },
    receipt_ready: { event: 'result/artifact', uiHint: 'card' }
  };

  events.forEach((evt) => {
    const translated = adapter.translateEvent(evt);
    const expected = expectedMappings[evt.type];
    if (expected) {
      assert.strictEqual(translated.event, expected.event, `Event type mapping failed for ${evt.type}`);
      assert.strictEqual(translated.uiHint, expected.uiHint, `UI hint mapping failed for ${evt.type}`);
    }
  });

  console.log('✅ AG-UI Event Bridge unit tests passed!');
}

try {
  runTsTest();
} catch (error) {
  console.error('❌ AG-UI unit tests failed:', error);
  process.exit(1);
}
