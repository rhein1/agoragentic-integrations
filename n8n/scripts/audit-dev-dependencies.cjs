'use strict';

const { spawnSync } = require('node:child_process');

function validateAuditReport(report) {
	if (report?.auditReportVersion !== 2 || !report.vulnerabilities) {
		throw new Error('npm audit returned an unsupported report shape');
	}

	const names = Object.keys(report.vulnerabilities).sort();
	const counts = report.metadata?.vulnerabilities;
	const severities = ['info', 'low', 'moderate', 'high', 'critical'];
	const counted = counts && severities.every((severity) => Number.isInteger(counts[severity]));
	const total = counted
		? severities.reduce((sum, severity) => sum + counts[severity], 0)
		: Number.NaN;
	if (!counted || counts.total !== total || total !== names.length) {
		throw new Error(`unexpected vulnerability counts: ${JSON.stringify(counts ?? null)}`);
	}
	if (names.length) throw new Error(`development audit is not clean: ${names.join(',')}`);
	return { clean: true };
}

function main() {
	const npmCli = process.env.npm_execpath;
	const command = npmCli ? process.execPath : 'npm';
	const args = npmCli
		? [npmCli, 'audit', '--json', '--audit-level=low']
		: ['audit', '--json', '--audit-level=low'];
	const result = spawnSync(command, args, {
		encoding: 'utf8',
	});
	if (result.error) throw result.error;
	if (![0, 1].includes(result.status)) {
		throw new Error(`npm audit failed with status ${result.status}: ${result.stderr.trim()}`);
	}

	let report;
	try {
		report = JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(`npm audit did not return JSON: ${error.message}`);
	}

	validateAuditReport(report);
	console.log('Development dependency audit is clean.');
}

if (require.main === module) {
	try {
		main();
	} catch (error) {
		console.error(`Development dependency audit rejected: ${error.message}`);
		process.exitCode = 1;
	}
}

module.exports = { validateAuditReport };
