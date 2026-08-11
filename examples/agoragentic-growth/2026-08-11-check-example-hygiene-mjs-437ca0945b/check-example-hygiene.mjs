#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([
  ".cjs", ".js", ".mjs", ".md", ".mdx", ".ts", ".tsx", ".txt",
]);
const ENTRYPOINT_NAMES = new Set([
  "example.mjs", "example.js", "index.mjs", "index.js", "main.mjs",
  "main.js", "demo.mjs", "demo.js", "run.mjs", "run.js",
]);
const LINK_RE = /\[[^\]]*\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g;
const IMPORT_RE = /\b(?:import|export)\s+(?:[^"'`]*?\sfrom\s+)?["'`]([^"'`]+)["'`]/g;
const NAV_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\(([^)#\s]+)(?:#[^)\s]*)?\)/gm;

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function display(root, file) {
  return path.relative(root, file) || ".";
}

function isRelative(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function resolveReference(baseFile, reference) {
  const clean = reference.split(/[?#]/, 1)[0];
  if (!clean || !isRelative(clean)) return null;
  const candidate = path.resolve(path.dirname(baseFile), clean);
  const choices = [
    candidate,
    ...[".mjs", ".js", ".cjs", ".ts", ".tsx", ".md"].map((ext) => candidate + ext),
    ...["index.mjs", "index.js", "index.md"].map((name) => path.join(candidate, name)),
  ];
  return choices.find((item) => fs.existsSync(item) && fs.statSync(item).isFile()) || candidate;
}

function finding(root, file, line, code, message) {
  return { file: display(root, file), line, code, message };
}

function collectFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  visit(root);
  return files;
}

function entrypointFiles(root, files) {
  return files.filter((file) => {
    const name = path.basename(file).toLowerCase();
    return ENTRYPOINT_NAMES.has(name) ||
      /(^|[-_.])(example|demo|entrypoint|quickstart|smoke|run)[-_.]/i.test(name);
  });
}

function checkRelativeReferences(root, file, source, references, code) {
  const findings = [];
  for (const match of references) {
    const target = resolveReference(file, match[1]);
    if (!target) continue;
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      findings.push(finding(
        root,
        file,
        lineNumber(source, match.index),
        code,
        `relative reference "${match[1]}" does not resolve from ${display(root, file)}`,
      ));
    }
  }
  return findings;
}

function checkNavigation(root, file, source) {
  const findings = [];
  const seen = new Map();
  for (const match of source.matchAll(NAV_RE)) {
    const target = match[1];
    if (!isRelative(target)) continue;
    const line = lineNumber(source, match.index);
    const prior = seen.get(target);
    if (prior) {
      findings.push(finding(
        root,
        file,
        line,
        "duplicate_navigation_reference",
        `navigation reference "${target}" repeats line ${prior}; remove or rename one entry`,
      ));
    } else {
      seen.set(target, line);
    }
  }
  return findings;
}

export function checkExampleHygiene(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const files = options.files || collectFiles(resolvedRoot);
  const findings = [];
  for (const file of entrypointFiles(resolvedRoot, files)) {
    const source = fs.readFileSync(file, "utf8");
    findings.push(...checkRelativeReferences(
      resolvedRoot,
      file,
      source,
      [...source.matchAll(IMPORT_RE)],
      "broken_relative_import",
    ));
    findings.push(...checkRelativeReferences(
      resolvedRoot,
      file,
      source,
      [...source.matchAll(LINK_RE)],
      "broken_relative_link",
    ));
  }
  for (const file of files.filter((item) => path.basename(item).toLowerCase() === "readme.md")) {
    const source = fs.readFileSync(file, "utf8");
    findings.push(...checkRelativeReferences(
      resolvedRoot,
      file,
      source,
      [...source.matchAll(LINK_RE)],
      "broken_relative_link",
    ));
    findings.push(...checkNavigation(resolvedRoot, file, source));
  }
  return findings.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || a.code.localeCompare(b.code)
  );
}

function printFindings(findings) {
  for (const item of findings) {
    console.error(`${item.file}:${item.line}: ${item.code}: ${item.message}`);
  }
  if (findings.length) {
    console.error(`Found ${findings.length} example hygiene issue(s).`);
  }
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agos-example-hygiene-"));
  const examples = path.join(root, "examples");
  fs.mkdirSync(examples, { recursive: true });
  fs.writeFileSync(path.join(examples, "example.mjs"), [
    'import "./helper.mjs";',
    'import "./missing.mjs";',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(examples, "helper.mjs"), "export const ok = true;\n");
  fs.writeFileSync(path.join(root, "README.md"), [
    "- [Example](./examples/example.mjs)",
    "- [Example again](./examples/example.mjs)",
    "",
  ].join("\n"));
  const findings = checkExampleHygiene(root);
  const codes = new Set(findings.map((item) => item.code));
  fs.rmSync(root, { recursive: true, force: true });
  if (!codes.has("broken_relative_import") ||
      !codes.has("duplicate_navigation_reference")) {
    throw new Error("self-test did not detect expected hygiene findings");
  }
  console.log("AGOS_RUNTIME_OK");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test") || args.length === 0) {
    selfTest();
    return;
  }
  const root = path.resolve(args[0]);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Not a directory: ${root}`);
    process.exitCode = 2;
    return;
  }
  const findings = checkExampleHygiene(root);
  printFindings(findings);
  if (!findings.length) console.log("Example hygiene OK");
  process.exitCode = findings.length ? 1 : 0;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]);
if (invoked === path.resolve(fileURLToPath(import.meta.url))) main();
