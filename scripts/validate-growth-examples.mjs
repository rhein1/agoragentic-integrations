#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const GROWTH_PREFIX = "examples/agoragentic-growth/";
const JS_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
const VALIDATED_EXTENSIONS = new Set([...JS_EXTENSIONS, ".py"]);

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function repoRelative(filePath, root = ROOT) {
  return toPosix(path.relative(root, filePath));
}

function isGrowthExample(filePath) {
  const rel = toPosix(filePath);
  return rel.startsWith(GROWTH_PREFIX) && VALIDATED_EXTENSIONS.has(path.extname(rel));
}

function walkFiles(dir, root = ROOT, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, root, out);
    } else if (entry.isFile() && isGrowthExample(repoRelative(fullPath, root))) {
      out.push(fullPath);
    }
  }
  return out;
}

function changedGrowthFiles(baseRef, root = ROOT) {
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACMRT", `${baseRef}...HEAD`, "--", GROWTH_PREFIX],
    { cwd: root, encoding: "utf8" },
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => isGrowthExample(file))
    .map((file) => path.join(root, file))
    .filter((file) => fs.existsSync(file));
}

function lineNumberForOffset(source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function resolveRelativeModule(importerPath, specifier) {
  const base = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [base];
  if (!path.extname(base)) {
    candidates.push(
      `${base}.mjs`,
      `${base}.js`,
      `${base}.cjs`,
      `${base}.ts`,
      `${base}.mts`,
      `${base}.cts`,
      `${base}.json`,
      path.join(base, "index.mjs"),
      path.join(base, "index.js"),
      path.join(base, "index.cjs"),
      path.join(base, "index.ts"),
    );
  }
  return candidates.some((candidate) => fs.existsSync(candidate));
}

function checkStaticRelativeImports(filePath, source, root = ROOT) {
  const findings = [];
  if (!JS_EXTENSIONS.has(path.extname(filePath))) return findings;

  const checks = [
    {
      kind: "missing_static_relative_import",
      // Matches static ESM imports, including side-effect imports and import type.
      regex: /^[ \t]*import(?:\s+type)?(?:[\s\S]*?\s+from\s+|\s*)["'](\.{1,2}\/[^"']+)["']/gm,
    },
    {
      kind: "missing_static_relative_require",
      regex: /\brequire\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    },
  ];

  for (const check of checks) {
    for (const match of source.matchAll(check.regex)) {
      const specifier = match[1];
      if (!resolveRelativeModule(filePath, specifier)) {
        findings.push({
          code: check.kind,
          file: repoRelative(filePath, root),
          line: lineNumberForOffset(source, match.index ?? 0),
          message: `Static relative module "${specifier}" does not exist next to the generated example.`,
        });
      }
    }
  }

  return findings;
}

function looksLikeGeneratedX402Buyer(source, relPath) {
  const lowerSource = source.toLowerCase();
  const lowerPath = relPath.toLowerCase();
  return lowerPath.includes("x402")
    && lowerSource.includes("402")
    && lowerSource.includes("payment-required")
    && /\bpay\s*\(/.test(source)
    && /x402fetch|createinlinex402fetch|createfallbackx402fetch|authorizationheader|paymentsignature/i.test(source);
}

function checkX402Safety(filePath, source, root = ROOT) {
  const findings = [];
  const rel = repoRelative(filePath, root);
  if (!JS_EXTENSIONS.has(path.extname(filePath)) || !looksLikeGeneratedX402Buyer(source, rel)) {
    return findings;
  }

  const hasMissingChallengeGuard =
    /without\s+(?:a\s+)?payment-required/i.test(source)
    || /did not include\s+(?:a\s+valid\s+)?payment-required/i.test(source)
    || /invalid\s+payment-required/i.test(source)
    || /missing\s+payment-required/i.test(source)
    || /payment-required\s+(?:header\s+)?(?:missing|challenge\s+missing|is\s+required)/i.test(source);

  if (!hasMissingChallengeGuard) {
    findings.push({
      code: "x402_missing_challenge_not_fail_closed",
      file: rel,
      line: 1,
      message: "Generated x402 buyer example must fail closed when HTTP 402 omits or corrupts payment-required.",
    });
  }

  const hasSecond402Guard =
    /paid request (?:received|was rejected).*?(?:another\s+)?(?:HTTP\s+)?402/i.test(source)
    || /another\s+(?:HTTP\s+)?402 challenge/i.test(source)
    || /refusing to re-authorize payment/i.test(source)
    || /paid_request_rejected/i.test(source)
    || /paid_retry_rejected/i.test(source);

  if (!hasSecond402Guard) {
    findings.push({
      code: "x402_paid_retry_reauthorizes_or_replays",
      file: rel,
      line: 1,
      message: "Generated x402 buyer example must reject a second HTTP 402 after payment instead of replaying or re-authorizing.",
    });
  }

  return findings;
}

export function validateGrowthExampleFile(filePath, options = {}) {
  const root = options.root ?? ROOT;
  const source = fs.readFileSync(filePath, "utf8");
  return [
    ...checkStaticRelativeImports(filePath, source, root),
    ...checkX402Safety(filePath, source, root),
  ];
}

export function validateGrowthExampleFiles(files, options = {}) {
  return files.flatMap((file) => validateGrowthExampleFile(file, options));
}

function parseArgs(argv) {
  const args = {
    all: false,
    base: "origin/main",
    files: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") {
      args.all = true;
    } else if (arg === "--base") {
      args.base = argv[++index];
      if (!args.base) throw new Error("--base requires a git ref");
    } else if (arg === "--file") {
      const file = argv[++index];
      if (!file) throw new Error("--file requires a path");
      args.files.push(file);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function filesForArgs(args, root = ROOT) {
  if (args.files.length > 0) {
    return args.files
      .map((file) => path.resolve(root, file))
      .filter((file) => fs.existsSync(file) && isGrowthExample(repoRelative(file, root)));
  }
  if (args.all) {
    return walkFiles(path.join(root, "examples", "agoragentic-growth"), root);
  }
  return changedGrowthFiles(args.base, root);
}

export function formatFinding(finding) {
  return `${finding.file}:${finding.line} ${finding.code}: ${finding.message}`;
}

export async function main(argv = process.argv.slice(2), root = ROOT) {
  const args = parseArgs(argv);
  const files = filesForArgs(args, root);
  const findings = validateGrowthExampleFiles(files, { root });

  if (findings.length > 0) {
    console.error("Generated growth example validation failed:");
    for (const finding of findings) {
      console.error(`- ${formatFinding(finding)}`);
    }
    process.exitCode = 1;
    return { files, findings };
  }

  console.log(`✅ Generated growth examples validated (${files.length} file${files.length === 1 ? "" : "s"})`);
  return { files, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
