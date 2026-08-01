'use strict';

const { spawnSync } = require('node:child_process');

const ALLOWED_ADVISORY = 'https://github.com/advisories/GHSA-mh99-v99m-4gvg';
const ALLOWED_PACKAGES = new Set([
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
]);

function validateAuditReport(report) {
	if (report?.auditReportVersion !== 2 || !report.vulnerabilities) {
		throw new Error('npm audit returned an unsupported report shape');
	}

	const allVulnerabilities = report.vulnerabilities;
	const allNames = new Set(Object.keys(allVulnerabilities));
	const vulnerabilities = Object.fromEntries(
		Object.entries(allVulnerabilities).filter(([, vulnerability]) =>
			['high', 'critical'].includes(vulnerability.severity),
		),
	);
	const names = Object.keys(vulnerabilities);
	const counts = report.metadata?.vulnerabilities;
	if (!counts || counts.critical !== 0 || counts.high !== names.length) {
		throw new Error(
			`unexpected vulnerability counts: ${JSON.stringify(counts ?? null)}`,
		);
	}
	if (names.length === 0) {
		return { clean: true, allowed: [] };
	}

	const unexpectedPackages = names.filter((name) => !ALLOWED_PACKAGES.has(name));
	if (unexpectedPackages.length) {
		throw new Error(
			`unexpected audit package set; extra=${unexpectedPackages.join(',')}`,
		);
	}

	const advisoryUrls = new Set();
	for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
		if (vulnerability.severity !== 'high') {
			throw new Error(`${name} changed severity to ${vulnerability.severity}`);
		}
		for (const via of vulnerability.via) {
			if (typeof via === 'string') {
				if (!allNames.has(via)) {
					throw new Error(`${name} depends on unexpected vulnerable package ${via}`);
				}
				continue;
			}
			if (!via?.url) {
				throw new Error(`${name} contains an advisory without a URL`);
			}
			if (['high', 'critical'].includes(via.severity)) {
				advisoryUrls.add(via.url);
			}
		}
	}

	if (
		advisoryUrls.size !== 1 ||
		!advisoryUrls.has(ALLOWED_ADVISORY)
	) {
		throw new Error(
			`unexpected advisory set: ${[...advisoryUrls].sort().join(',') || 'none'}`,
		);
	}

	return { clean: false, allowed: names.sort() };
}

function main() {
	const npmCli = process.env.npm_execpath;
	const command = npmCli ? process.execPath : 'npm';
	const args = npmCli
		? [npmCli, 'audit', '--json', '--audit-level=high']
		: ['audit', '--json', '--audit-level=high'];
	const result = spawnSync(command, args, {
		encoding: 'utf8',
	});
	if (result.error) throw result.error;
	if (![0, 1].includes(result.status)) {
		throw new Error(
			`npm audit failed with status ${result.status}: ${result.stderr.trim()}`,
		);
	}

	let report;
	try {
		report = JSON.parse(result.stdout);
	} catch (error) {
		throw new Error(`npm audit did not return JSON: ${error.message}`);
	}

	const verdict = validateAuditReport(report);
	if (verdict.clean) {
		console.log('Development dependency audit is clean.');
		return;
	}
	console.log(
		`Allowed development-only advisory ${ALLOWED_ADVISORY}; ` +
			`${verdict.allowed.length} affected dependency nodes verified.`,
	);
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
