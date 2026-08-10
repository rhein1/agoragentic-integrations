import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([".md", ".markdown"]);
const CODE_EXTENSIONS = new Set([".js", ".mjs"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build"]);
const REFERENCE_DEFINITION_RE = /^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm;
const REFERENCE_USAGE_RE = /(?<!!)\[([A-Za-z0-9][A-Za-z0-9 .:_-]*)\]\[([A-Za-z0-9 .:_-]*)\]/g;
const DOCUMENTED_COMMAND_RE = /\bnode\s+((?:\.{0,2}[/\\])?examples[/\\][^\s`'"<>]+\.(?:mjs|js))/g;

function walk(root) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  visit(root);
  return files.sort();
}

function finding(code, file, detail) {
  return { code, file, detail };
}

function relativeTarget(markdownFile, rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1);
  }
  if (!target || target.startsWith("#") || target.startsWith("/")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("//")) return null;
  target = target.split("#", 1)[0].split("?", 1)[0];
  if (!target) return null;
  try {
    target = decodeURIComponent(target);
  } catch {
    return { invalidEncoding: true };
  }
  return path.resolve(path.dirname(markdownFile), target);
}

function checkLinks(root) {
  const findings = [];
  for (const file of walk(root)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    const source = fs.readFileSync(file, "utf8");
    const references = new Map();
    const markdownLines = [];
    let inFence = false;
    for (const line of source.split("\n")) {
      if (/^\s*```/.test(line)) inFence = !inFence;
      if (!inFence) markdownLines.push(line);
    }
    const markdownSource = markdownLines.join("\n");
    let definition;
    while ((definition = REFERENCE_DEFINITION_RE.exec(markdownSource))) {
      references.set(definition[1].trim().toLowerCase(),
        definition[2] ?? definition[3]);
    }
    const inspectTarget = (rawTarget, detail = rawTarget) => {
      const target = relativeTarget(file, rawTarget);
      if (!target) return;
      if (target.invalidEncoding) {
        findings.push(finding("invalid_link_encoding", file, detail));
      } else if (!target.startsWith(path.resolve(root) + path.sep) &&
          target !== path.resolve(root)) {
        findings.push(finding("link_escapes_root", file, detail));
      } else if (!fs.existsSync(target)) {
        findings.push(finding("missing_relative_link", file, detail));
      }
    };
    const pattern = /!?\[[^\]]*]\(\s*([^) \t]+|<[^>]+>)/g;
    let match;
    while ((match = pattern.exec(markdownSource))) {
      inspectTarget(match[1]);
    }
    while ((match = REFERENCE_USAGE_RE.exec(markdownSource))) {
      const label = (match[2] || match[1]).trim().toLowerCase();
      const target = references.get(label);
      if (target === undefined) {
        findings.push(finding("missing_reference_definition", file, label));
      } else {
        inspectTarget(target, target);
      }
    }
  }
  return findings;
}

function checkJavaScriptSyntax(root) {
  const findings = [];
  const examplesRoot = path.join(root, "examples");
  if (!fs.existsSync(examplesRoot)) return findings;
  for (const file of walk(examplesRoot)) {
    if (!CODE_EXTENSIONS.has(path.extname(file))) continue;
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    if (result.status !== 0) {
      const detail = (result.stderr || "node --check failed").split("\n").at(-2) ||
        "node --check failed";
      findings.push(finding("invalid_javascript_syntax", file, detail.trim()));
    }
  }
  return findings;
}

function checkDocumentedCommands(root) {
  const findings = [];
  const examplesRoot = path.join(root, "examples") + path.sep;
  for (const file of walk(root)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    if (file !== path.join(root, "README.md") && !file.startsWith(examplesRoot)) continue;
    const source = fs.readFileSync(file, "utf8");
    let match;
    while ((match = DOCUMENTED_COMMAND_RE.exec(source))) {
      const raw = match[1].replace(/\\/g, "/");
      const fromRoot = path.resolve(root, raw.replace(/^\.\//, ""));
      const fromGuide = path.resolve(path.dirname(file), raw);
      const withinRoot = (candidate) => candidate.startsWith(path.resolve(root) + path.sep);
      if ((!withinRoot(fromRoot) || !fs.existsSync(fromRoot)) &&
          (!withinRoot(fromGuide) || !fs.existsSync(fromGuide))) {
        findings.push(finding("missing_documented_entrypoint", file, raw));
      }
    }
  }
  return findings;
}

function relativeName(root, file) {
  return path.relative(root, file) || ".";
}

function check(root) {
  return [...checkLinks(root), ...checkDocumentedCommands(root), ...checkJavaScriptSyntax(root)];
}

function printFindings(root, findings) {
  if (findings.length === 0) {
    console.log("AGOS_CHECK_OK");
    return;
  }
  console.error(`AGOS_CHECK_FAILED: ${findings.length} finding(s)`);
  for (const item of findings) {
    console.error(`- ${item.code}: ${relativeName(root, item.file)}: ${item.detail}`);
  }
}

function writeFixture(root, files) {
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");
  }
}

function runSelfTest() {
  const cases = [
    {
      name: "valid links and JavaScript",
      files: {
        "README.md": "[run](examples/demo.entry.mjs)\n",
        "examples/demo.entry.mjs":
          "export function main() { return 0; }\n",
      },
      expected: [],
    },
    {
      name: "missing markdown target",
      files: { "README.md": "[missing](docs/nope.md)\n" },
      expected: ["missing_relative_link"],
    },
    {
      name: "external links are ignored",
      files: { "README.md": "[web](https://example.test/x) [mail](mailto:a@b.test)\n" },
      expected: [],
    },
    {
      name: "invalid JavaScript is rejected",
      files: {
        "examples/demo.mjs": "const = ;\n",
      },
      expected: ["invalid_javascript_syntax"],
    },
    {
      name: "undefined and collapsed references are rejected",
      files: {
        "README.md": "[missing][nope] [collapsed][]\n",
      },
      expected: ["missing_reference_definition", "missing_reference_definition"],
    },
    {
      name: "encoded local link resolves",
      files: {
        "README.md": "[guide](docs/my%20guide.md)\n",
        "docs/my guide.md": "# Guide\n",
      },
      expected: [],
    },
    {
      name: "missing documented command target",
      files: { "README.md": "```sh\nnode examples/missing.mjs\n```\n" },
      expected: ["missing_documented_entrypoint"],
    },
  ];

  for (const testCase of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agos-hygiene-"));
    try {
      writeFixture(root, testCase.files);
      const actual = check(root).map((item) => item.code);
      const expected = [...testCase.expected];
      if (actual.length !== expected.length ||
          actual.some((code, index) => code !== expected[index])) {
        throw new Error(
          `${testCase.name}: expected ${expected.join(",") || "no findings"}, ` +
          `got ${actual.join(",") || "no findings"}`,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(`SELF_TEST_CASES_OK: ${cases.length}`);
}

function usage() {
  console.log("Usage: node scripts/check-example-entrypoints.mjs [--self-test] [root]");
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    usage();
    return;
  }
  if (args.includes("--self-test")) {
    runSelfTest();
    console.log("AGOS_RUNTIME_OK");
    return;
  }
  const rootArg = args.find((arg) => !arg.startsWith("-")) || ".";
  const root = path.resolve(rootArg);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`AGOS_CHECK_FAILED: repository root is not a directory: ${root}`);
    process.exitCode = 1;
    return;
  }
  const findings = check(root);
  printFindings(root, findings);
  if (findings.length) {
    process.exitCode = 1;
    return;
  }
  console.log("AGOS_RUNTIME_OK");
}

const entrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === entrypoint) {
  main();
}
