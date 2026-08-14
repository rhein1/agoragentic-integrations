#!/usr/bin/env node

// Historical one-click submission automation was removed because it could
// publish stale live-MCP and credential-bearing configuration. External
// forks, pull requests, listings, and outreach require a fresh owner review
// and an explicitly authorized, evidence-bound submission workflow.

const code = 'EXTERNAL_SUBMISSION_DISABLED';
const message = `${code}: this legacy submission helper performs no network or GitHub writes.`;

process.stderr.write(`${message}\n`);
process.exitCode = 1;
