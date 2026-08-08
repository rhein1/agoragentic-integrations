'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { validateAuditReport } = require('../scripts/audit-dev-dependencies.cjs');

const allowedPackages = [
	'@n8n/ai-utilities',
	'@n8n/api-types',
	'@n8n/backend-common',
	'@n8n/backend-network',
	'@n8n/decorators',
	'@n8n/utils',
	'n8n-workflow',
	'nanoid',
];

function allowedReport() {
	const vulnerabilities = Object.fromEntries(
		allowedPackages.map((name) => [
			name,
			{
				severity: 'high',
				via:
					name === 'nanoid'
						? [
								{
									url: 'https://github.com/advisories/GHSA-28wg-ghj8-5hjv',
									severity: 'high',
								},
								{
									url: 'https://github.com/advisories/GHSA-2v37-7h3g-55p8',
									severity: 'high',
								},
							]
						: ['nanoid'],
			},
		]),
	);
	return {
		auditReportVersion: 2,
		vulnerabilities,
		metadata: {
			vulnerabilities: {
				info: 0,
				low: 0,
				moderate: 0,
				high: allowedPackages.length,
				critical: 0,
				total: allowedPackages.length,
			},
		},
	};
}

test('accepts only the documented development advisory graph', () => {
	const report = allowedReport();
	report.vulnerabilities.uuid = {
		severity: 'moderate',
		via: [
			{
				url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
			},
		],
	};
	report.metadata.vulnerabilities.moderate = 1;
	report.metadata.vulnerabilities.total += 1;
	const verdict = validateAuditReport(report);
	assert.equal(verdict.clean, false);
	assert.deepEqual(verdict.allowed, [...allowedPackages].sort());
});

test('accepts a fully clean development audit', () => {
	const report = allowedReport();
	report.vulnerabilities = {};
	report.metadata.vulnerabilities.high = 0;
	report.metadata.vulnerabilities.total = 0;
	assert.deepEqual(validateAuditReport(report), { clean: true, allowed: [] });
});

test('accepts remediation-driven shrinkage of the documented advisory graph', () => {
	const report = allowedReport();
	for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
		if (name !== 'nanoid') vulnerability.severity = 'moderate';
	}
	report.metadata.vulnerabilities.high = 1;
	report.metadata.vulnerabilities.moderate = allowedPackages.length - 1;
	assert.deepEqual(validateAuditReport(report), {
		clean: false,
		allowed: ['nanoid'],
	});
});

test('rejects a new advisory even when it affects an allowed package', () => {
	const report = allowedReport();
	report.vulnerabilities.nanoid.via.push({
		url: 'https://github.com/advisories/GHSA-unexpected',
		severity: 'high',
	});
	assert.throws(() => validateAuditReport(report), /unexpected advisory set/);
});

test('rejects an incomplete advisory set', () => {
	const report = allowedReport();
	report.vulnerabilities.nanoid.via.pop();
	assert.throws(() => validateAuditReport(report), /unexpected advisory set/);
});

test('rejects changes to the affected package graph', () => {
	const report = allowedReport();
	report.vulnerabilities['new-package'] = {
		severity: 'high',
		via: ['nanoid'],
	};
	report.metadata.vulnerabilities.high += 1;
	report.metadata.vulnerabilities.total += 1;
	assert.throws(() => validateAuditReport(report), /unexpected audit package set/);
});

test('rejects replacing an allowed affected package', () => {
	const report = allowedReport();
	delete report.vulnerabilities['@n8n/api-types'];
	report.vulnerabilities['replacement-package'] = {
		severity: 'high',
		via: ['nanoid'],
	};
	assert.throws(() => validateAuditReport(report), /unexpected audit package set/);
});

test('rejects inconsistent high-severity counts', () => {
	const report = allowedReport();
	report.metadata.vulnerabilities.high -= 1;
	assert.throws(() => validateAuditReport(report), /unexpected vulnerability counts/);
});
