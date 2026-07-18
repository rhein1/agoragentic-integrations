import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const PARSER_TIMEOUT_MS = 10_000;
const TEST_FILE_PATTERN = /(?:^|\/)(?:test|tests)\/|(?:\.test|\.spec)\.[^.]+$/i;
const SKIP_DIRECTORIES = new Set([".git", "coverage", "dist", "node_modules"]);

const SECRET_PATTERNS = [
  { code: "pem_private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { code: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { code: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { code: "openai_api_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { code: "agoragentic_api_key", pattern: /\bamk_[A-Za-z0-9_-]{20,}\b/g },
  {
    code: "wallet_private_key",
    pattern: /(?:private[_-]?key|wallet[_-]?key)\s*[:=]\s*["'](?:0x)?[0-9a-fA-F]{64}["']/gi,
  },
];

const PLACEHOLDER_MARKERS = [
  "dummy",
  "example",
  "fake",
  "placeholder",
  "redacted",
  "test",
  "your",
  "xxxxx",
];

function makeCheck(id, state, summary, evidence = undefined) {
  const check = { id, state, summary };
  if (evidence !== undefined) check.evidence = evidence;
  return check;
}

function normalizeRelative(value) {
  return String(value || "").replaceAll("\\", "/");
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveRepoPath(root, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "" || path.isAbsolute(relativePath)) {
    return { ok: false, reason: "path_must_be_repo_relative" };
  }

  const absolute = path.resolve(root, relativePath);
  if (!isWithin(root, absolute)) return { ok: false, reason: "path_escapes_repository" };
  if (!fs.existsSync(absolute)) return { ok: false, reason: "path_does_not_exist", absolute };

  const real = fs.realpathSync(absolute);
  if (!isWithin(root, real)) return { ok: false, reason: "symlink_escapes_repository", absolute, real };
  return { ok: true, absolute, real };
}

function readBoundedText(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { ok: false, reason: "path_is_not_a_file" };
  if (stat.size > MAX_TEXT_BYTES) return { ok: false, reason: "file_exceeds_2_mib", size_bytes: stat.size };
  return { ok: true, text: fs.readFileSync(filePath, "utf8"), size_bytes: stat.size };
}

function commandFailure(result) {
  const output = `${result.stderr || ""}\n${result.stdout || ""}`.trim();
  return redactSensitiveText(output.split(/\r?\n/).slice(0, 12).join("\n")) || `parser exited ${result.status}`;
}

function redactSensitiveText(value) {
  let redacted = String(value || "");
  redacted = redacted.replace(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    "[REDACTED:pem_private_key]",
  );
  for (const rule of SECRET_PATTERNS) {
    rule.pattern.lastIndex = 0;
    redacted = redacted.replace(rule.pattern, `[REDACTED:${rule.code}]`);
  }
  return redacted;
}

function syntaxCheck(relativePath, absolutePath, source, options = {}) {
  const extension = path.extname(relativePath).toLowerCase();
  const env = sanitizeWorkerEnv(options.env);

  if ([".md", ".txt", ".rst"].includes(extension)) {
    return makeCheck("primary_syntax", "not_applicable", "Primary artifact is documentation, not executable source.");
  }

  if ([".js", ".mjs", ".cjs"].includes(extension)) {
    const result = spawnSync(process.execPath, ["--check", absolutePath], {
      encoding: "utf8",
      env,
      timeout: PARSER_TIMEOUT_MS,
    });
    return result.status === 0
      ? makeCheck("primary_syntax", "pass", `Node parsed ${extension.slice(1)} syntax without executing the adapter.`)
      : makeCheck("primary_syntax", "fail", "Node syntax parsing failed.", { parser: "node --check", detail: commandFailure(result) });
  }

  if (extension === ".ts") {
    try {
      const transformed = stripTypeScriptTypes(source, { mode: "transform", sourceMap: false });
      const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
        encoding: "utf8",
        env,
        input: transformed,
        timeout: PARSER_TIMEOUT_MS,
      });
      return result.status === 0
        ? makeCheck("primary_syntax", "pass", "Node stripped TypeScript types and parsed the module without executing it.")
        : makeCheck("primary_syntax", "fail", "TypeScript syntax parsing failed after type stripping.", {
            parser: "node:module.stripTypeScriptTypes + node --check",
            detail: commandFailure(result),
          });
    } catch (error) {
      return makeCheck("primary_syntax", "fail", "TypeScript type stripping failed.", {
        parser: "node:module.stripTypeScriptTypes",
        detail: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  if (extension === ".py") {
    const python = options.pythonCommand || "python";
    const parser = [
      "import ast, sys",
      "source = sys.stdin.read()",
      "ast.parse(source, filename=sys.argv[1])",
    ].join("; ");
    const result = spawnSync(python, ["-I", "-c", parser, normalizeRelative(relativePath)], {
      encoding: "utf8",
      env,
      input: source,
      timeout: PARSER_TIMEOUT_MS,
    });
    if (result.error?.code === "ENOENT") {
      return makeCheck("primary_syntax", "fail", "Python parser is unavailable.", { parser: python });
    }
    return result.status === 0
      ? makeCheck("primary_syntax", "pass", "Python ast.parse accepted the source without importing the adapter.")
      : makeCheck("primary_syntax", "fail", "Python syntax parsing failed.", {
          parser: `${python} ast.parse`,
          detail: commandFailure(result),
        });
  }

  if (extension === ".json") {
    try {
      JSON.parse(source);
      return makeCheck("primary_syntax", "pass", "JSON.parse accepted the primary artifact.");
    } catch (error) {
      return makeCheck("primary_syntax", "fail", "JSON parsing failed.", {
        parser: "JSON.parse",
        detail: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  return makeCheck("primary_syntax", "not_applicable", `No offline parser is configured for ${extension || "this artifact"}.`);
}

function secretFindings(files) {
  const findings = [];
  for (const file of files) {
    for (const rule of SECRET_PATTERNS) {
      rule.pattern.lastIndex = 0;
      for (const match of file.text.matchAll(rule.pattern)) {
        const matched = match[0].toLowerCase();
        if (PLACEHOLDER_MARKERS.some((marker) => matched.includes(marker))) continue;
        findings.push({ code: rule.code, path: normalizeRelative(file.path) });
      }
    }
  }
  return findings;
}

function findColocatedTests(root, primaryRelativePath) {
  const topLevel = normalizeRelative(primaryRelativePath).split("/")[0];
  if (!topLevel) return [];
  const start = path.join(root, topLevel);
  if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) return [];

  const found = [];
  const stack = [start];
  let visited = 0;
  while (stack.length > 0 && visited < 5_000) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      visited += 1;
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(path.join(current, entry.name));
        continue;
      }
      const absolute = path.join(current, entry.name);
      const relative = normalizeRelative(path.relative(root, absolute));
      if (TEST_FILE_PATTERN.test(relative)) found.push(relative);
    }
  }
  return found.sort();
}

function canonicalFlowCheck(integration, files) {
  if (integration.status === "deprecated") {
    return makeCheck("execute_first_signal", "not_applicable", "Deprecated entries are not required to advertise the current execute-first flow.");
  }
  const content = files.map((file) => file.text).join("\n").toLowerCase();
  const present = content.includes("agoragentic_execute")
    || content.includes("/api/execute")
    || content.includes("execute(task")
    || content.includes("execute(");
  return present
    ? makeCheck("execute_first_signal", "pass", "Primary artifact or docs include an execute-first integration signal.")
    : makeCheck("execute_first_signal", "advisory", "No execute-first signal was found in the primary artifact or docs.");
}

export function sanitizeWorkerEnv(source = process.env) {
  const allowed = new Set([
    "CI",
    "COMSPEC",
    "GITHUB_ACTIONS",
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ]);
  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  }
  env.AGORAGENTIC_CONFORMANCE_OFFLINE = "1";
  env.NODE_NO_WARNINGS = "1";
  env.NO_PROXY = "*";
  env.no_proxy = "*";
  return env;
}

export async function validateIntegration(rootInput, integration, options = {}) {
  const started = Date.now();
  const root = fs.realpathSync(path.resolve(rootInput));
  const checks = [];
  const requiredFields = ["id", "name", "language", "status", "path", "docs"];
  const missingFields = requiredFields.filter((field) => typeof integration?.[field] !== "string" || integration[field].trim() === "");
  checks.push(missingFields.length === 0
    ? makeCheck("manifest_fields", "pass", "Required manifest fields are present.")
    : makeCheck("manifest_fields", "fail", "Required manifest fields are missing.", { fields: missingFields }));

  const primary = resolveRepoPath(root, integration?.path);
  checks.push(primary.ok
    ? makeCheck("primary_path", "pass", "Primary path exists and remains inside the repository.", { path: normalizeRelative(integration.path) })
    : makeCheck("primary_path", "fail", "Primary path is unavailable or unsafe.", {
        path: normalizeRelative(integration?.path),
        reason: primary.reason,
      }));

  const docs = resolveRepoPath(root, integration?.docs);
  checks.push(docs.ok
    ? makeCheck("docs_path", "pass", "Documentation path exists and remains inside the repository.", { path: normalizeRelative(integration.docs) })
    : makeCheck("docs_path", "fail", "Documentation path is unavailable or unsafe.", {
        path: normalizeRelative(integration?.docs),
        reason: docs.reason,
      }));

  const files = [];
  let primaryText = null;
  if (primary.ok) {
    const read = readBoundedText(primary.real);
    if (read.ok) {
      primaryText = read.text;
      files.push({ path: integration.path, text: read.text });
      checks.push(syntaxCheck(integration.path, primary.real, read.text, options));
    } else {
      checks.push(makeCheck("primary_syntax", "fail", "Primary artifact could not be read as bounded text.", {
        reason: read.reason,
        size_bytes: read.size_bytes,
      }));
    }
  } else {
    checks.push(makeCheck("primary_syntax", "fail", "Primary syntax cannot be checked because the path is invalid."));
  }

  if (docs.ok && docs.real !== primary.real) {
    const read = readBoundedText(docs.real);
    if (read.ok) files.push({ path: integration.docs, text: read.text });
    else checks.push(makeCheck("docs_read", "fail", "Documentation could not be read as bounded text.", { reason: read.reason }));
  }

  const secrets = secretFindings(files);
  checks.push(secrets.length === 0
    ? makeCheck("credential_literals", "pass", "No credential-shaped literal was found in the primary artifact or docs.")
    : makeCheck("credential_literals", "fail", "Credential-shaped literals were found; values are intentionally omitted.", {
        findings: secrets,
      }));

  checks.push(canonicalFlowCheck(integration || {}, files));

  const colocatedTests = primary.ok ? findColocatedTests(root, integration.path) : [];
  checks.push(colocatedTests.length > 0
    ? makeCheck("colocated_tests", "pass", `Found ${colocatedTests.length} colocated test file(s).`, { paths: colocatedTests })
    : makeCheck("colocated_tests", "advisory", "No colocated test file was detected; this run proves static and syntax contracts only."));

  const failed = checks.filter((check) => check.state === "fail").length;
  const warnings = checks.filter((check) => check.state === "advisory").length;
  return {
    id: integration?.id || "unknown",
    name: integration?.name || "Unknown integration",
    language: integration?.language || "unknown",
    declared_status: integration?.status || "unknown",
    primary_path: normalizeRelative(integration?.path),
    docs_path: normalizeRelative(integration?.docs),
    result: failed === 0 ? "pass" : "fail",
    checks,
    summary: {
      failed,
      warnings,
      passed: checks.filter((check) => check.state === "pass").length,
      not_applicable: checks.filter((check) => check.state === "not_applicable").length,
    },
    evidence_boundary: {
      adapter_code_executed: false,
      network_calls_performed: false,
      paid_calls_performed: false,
      production_mutation_performed: false,
      proof_level: primaryText === null ? "manifest_only" : "offline_static_and_syntax",
    },
    duration_ms: Date.now() - started,
  };
}
