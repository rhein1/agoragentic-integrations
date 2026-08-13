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
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
const IMPORT_RE = /^[ \t]*(?:import|export)[ \t]+(?:(?:[^"'`\r\n;]+)[ \t]+from[ \t]+)?["']([^"']+)["']/gm;
const REFERENCE_DEFINITION_RE = /^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|([^\s]+))/gm;
const REFERENCE_USE_RE = /\[([^\]\r\n]+)\]\[([^\]\r\n]*)\]/g;
const NAV_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\(([^)\s]+)\)/gm;
function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}
function display(root, file) {
  return path.relative(root, file) || ".";
}
function isRelativeImport(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}
function isLocalLink(reference) {
  return Boolean(reference) && !reference.startsWith("#") && !reference.startsWith("/") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(reference);
}
function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." &&
    !path.isAbsolute(relative));
}
function resolveReference(root, baseFile, reference, localPredicate, allowDirectory) {
  const raw = reference.replace(/^<|>$/g, "");
  const clean = raw.split(/[?#]/, 1)[0];
  if (!clean || !localPredicate(clean)) return null;
  const candidate = path.resolve(path.dirname(baseFile), clean);
  if (!insideRoot(root, candidate)) return { target: candidate, escapesRoot: true };
  const choices = [
    candidate,
    ...[".mjs", ".js", ".cjs", ".ts", ".tsx", ".md"].map((ext) => candidate + ext),
    ...["index.mjs", "index.js", "index.md"].map((name) => path.join(candidate, name)),
  ];
  const target = choices.find((item) => {
    if (!fs.existsSync(item)) return false;
    const stat = fs.statSync(item);
    return stat.isFile() || (allowDirectory && stat.isDirectory());
  }) || candidate;
  return { target, escapesRoot: false };
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
      else if (entry.isSymbolicLink()) continue;
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
function checkRelativeReferences(root, file, source, references, code, localPredicate, allowDirectory = false) {
  const findings = [];
  for (const match of references) {
    const resolved = resolveReference(root, file, match[1], localPredicate, allowDirectory);
    if (!resolved) continue;
    if (resolved.escapesRoot) {
      findings.push(finding(
        root,
        file,
        lineNumber(source, match.index),
        "reference_escapes_root",
        `relative reference "${match[1]}" escapes the checked repository root`,
      ));
    } else if (!fs.existsSync(resolved.target) ||
      (!fs.statSync(resolved.target).isFile() && !(allowDirectory && fs.statSync(resolved.target).isDirectory()))) {
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
function maskJavaScriptData(source) {
  const output = source.split("");
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") { output[index] = output[index + 1] = " "; state = "line"; index += 1; }
      else if (char === "/" && next === "*") { output[index] = output[index + 1] = " "; state = "block"; index += 1; }
      else if (char === "'" || char === '"' || char === "`") { state = char; output[index] = " "; }
      continue;
    }
    if (state === "line") {
      if (char === "\n") state = "code";
      else output[index] = " ";
      continue;
    }
    if (state === "block") {
      output[index] = char === "\n" ? "\n" : " ";
      if (char === "*" && next === "/") { output[index + 1] = " "; state = "code"; index += 1; }
      continue;
    }
    output[index] = char === "\n" ? "\n" : " ";
    if (char === "\\") {
      if (index + 1 < source.length) output[index + 1] = source[index + 1] === "\n" ? "\n" : " ";
      index += 1;
    } else if (char === state) state = "code";
  }
  return output.join("");
}
function staticImports(source) {
  const executable = maskJavaScriptData(source);
  return [...source.matchAll(IMPORT_RE)].filter((match) =>
    /^(?:import|export)\b/.test(executable.slice(match.index).trimStart())
  );
}
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}
function maskMarkdownCode(source) {
  const blank = (value) => value.replace(/[^\r\n]/g, " ");
  return source
    .replace(/(^|\n)[ \t]*(```+|~~~+)[^\n]*\n[\s\S]*?\n[ \t]*\2[^\n]*(?=\n|$)/g, blank)
    .replace(/`+[^`\r\n]*`+/g, blank);
}
function markdownReferences(root, file, source) {
  const definitions = new Map();
  const definitionTargets = [];
  for (const match of source.matchAll(REFERENCE_DEFINITION_RE)) {
    definitions.set(normalizeLabel(match[1]), match[2] || match[3]);
    definitionTargets.push({ 1: match[2] || match[3], index: match.index });
  }
  const findings = [];
  for (const match of source.matchAll(REFERENCE_USE_RE)) {
    const label = normalizeLabel(match[2] || match[1]);
    if (!definitions.has(label)) {
      findings.push(finding(
        root, file, lineNumber(source, match.index), "undefined_reference_link",
        `reference-style link "${label}" has no definition`,
      ));
    }
  }
  return { findings, definitionTargets };
}
function checkNavigation(root, file, source) {
  const findings = [];
  const seen = new Map();
  for (const match of source.matchAll(NAV_RE)) {
    const target = match[1];
    if (!isLocalLink(target)) continue;
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
    if ([".cjs", ".js", ".mjs", ".ts", ".tsx"].includes(path.extname(file).toLowerCase())) {
      findings.push(...checkRelativeReferences(
        resolvedRoot, file, source, staticImports(source), "broken_relative_import", isRelativeImport,
      ));
    }
    if ([".md", ".mdx"].includes(path.extname(file).toLowerCase())) {
      const markdown = maskMarkdownCode(source);
      const references = markdownReferences(resolvedRoot, file, markdown);
      findings.push(...references.findings);
      findings.push(...checkRelativeReferences(
        resolvedRoot, file, source, [...markdown.matchAll(LINK_RE)], "broken_relative_link", isLocalLink, true,
      ));
      findings.push(...checkRelativeReferences(
        resolvedRoot, file, source, references.definitionTargets, "broken_relative_link", isLocalLink, true,
      ));
    }
  }
  for (const file of files.filter((item) => path.basename(item).toLowerCase() === "readme.md")) {
    const source = fs.readFileSync(file, "utf8");
    const markdown = maskMarkdownCode(source);
    const references = markdownReferences(resolvedRoot, file, markdown);
    findings.push(...references.findings);
    findings.push(...checkRelativeReferences(
      resolvedRoot, file, source, [...markdown.matchAll(LINK_RE)], "broken_relative_link", isLocalLink, true,
    ));
    findings.push(...checkRelativeReferences(
      resolvedRoot, file, source, references.definitionTargets, "broken_relative_link", isLocalLink, true,
    ));
    findings.push(...checkNavigation(resolvedRoot, file, markdown));
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
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agos-example-hygiene-"));
  const root = path.join(workspace, "repo");
  const examples = path.join(root, "examples");
  fs.mkdirSync(examples, { recursive: true });
  fs.writeFileSync(path.join(examples, "example.mjs"), [
    'import "./helper.mjs";',
    'import "./missing.mjs";',
    "const fixture = `",
    'import value ' + 'from "./fixture-only.mjs";',
    "`;",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(examples, "helper.mjs"), "export const ok = true;\n");
  fs.writeFileSync(path.join(workspace, "outside.md"), "outside\n");
  fs.writeFileSync(path.join(root, "README.md"), [
    "- [Example](./examples/example.mjs)",
    "- [Example again](./examples/example.mjs)",
    "- [Section one](./examples/example.mjs#one)",
    "- [Section two](./examples/example.mjs#two)",
    "[undefined][missing]",
    "[outside]: ../outside.md",
    "[Escaped][outside]",
    "",
  ].join("\n"));
  const findings = checkExampleHygiene(root);
  const codes = new Set(findings.map((item) => item.code));
  const importFindings = findings.filter((item) => item.code === "broken_relative_import");
  const duplicateFindings = findings.filter((item) => item.code === "duplicate_navigation_reference");
  fs.rmSync(workspace, { recursive: true, force: true });
  if (!codes.has("broken_relative_import") ||
      !codes.has("duplicate_navigation_reference") ||
      !codes.has("undefined_reference_link") ||
      !codes.has("reference_escapes_root") ||
      importFindings.length !== 1 || duplicateFindings.length !== 1) {
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
