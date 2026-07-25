'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
	validateAuditReport,
} = require('../scripts/audit-dev-dependencies.cjs');

const allowedPackages = [
	'@eslint/config-array',
	'@eslint/eslintrc',
	'@n8n/eslint-plugin-community-nodes',
	'@n8n/node-cli',
	'@oclif/core',
	'brace-expansion',
	'ejs',
	'eslint',
	'filelist',
	'jake',
	'minimatch',
];

function allowedReport() {
	const vulnerabilities = Object.fromEntries(
		allowedPackages.map((name) => [
			name,
			{
				severity: 'high',
				via:
					name === 'brace-expansion'
						? [
								{
									url: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
									severity: 'high',
								},
							]
						: ['brace-expansion'],
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

test('rejects a new advisory even when it affects an allowed package', () => {
	const report = allowedReport();
	report.vulnerabilities['brace-expansion'].via.push({
		url: 'https://github.com/advisories/GHSA-unexpected',
		severity: 'high',
	});
	assert.throws(
		() => validateAuditReport(report),
		/unexpected advisory set/,
	);
});

test('rejects changes to the affected package graph', () => {
	const report = allowedReport();
	report.vulnerabilities['new-package'] = {
		severity: 'high',
		via: ['brace-expansion'],
	};
	report.metadata.vulnerabilities.high += 1;
	report.metadata.vulnerabilities.total += 1;
	assert.throws(
		() => validateAuditReport(report),
		/unexpected audit package set/,
	);
});
