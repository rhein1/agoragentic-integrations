'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { validateAuditReport } = require('../scripts/audit-dev-dependencies.cjs');

function cleanReport() {
	return {
		auditReportVersion: 2,
		vulnerabilities: {},
		metadata: {
			vulnerabilities: {
				info: 0,
				low: 0,
				moderate: 0,
				high: 0,
				critical: 0,
				total: 0,
			},
		},
	};
}

test('accepts a fully clean development audit', () => {
	assert.deepEqual(validateAuditReport(cleanReport()), { clean: true });
});

test('rejects the remediated uuid advisory at moderate severity', () => {
	const report = cleanReport();
	report.vulnerabilities.uuid = {
		severity: 'moderate',
		via: [
			{
				url: 'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
			},
		],
	};
	report.metadata.vulnerabilities.moderate = 1;
	report.metadata.vulnerabilities.total = 1;
	assert.throws(() => validateAuditReport(report), /development audit is not clean: uuid/);
});

test('rejects any newly vulnerable package', () => {
	const report = cleanReport();
	report.vulnerabilities['new-package'] = { severity: 'low', via: [] };
	report.metadata.vulnerabilities.low = 1;
	report.metadata.vulnerabilities.total = 1;
	assert.throws(() => validateAuditReport(report), /development audit is not clean: new-package/);
});

test('rejects inconsistent vulnerability counts', () => {
	const report = cleanReport();
	report.metadata.vulnerabilities.total = 1;
	assert.throws(() => validateAuditReport(report), /unexpected vulnerability counts/);
});

test('rejects unsupported audit reports', () => {
	assert.throws(() => validateAuditReport({}), /unsupported report shape/);
});
