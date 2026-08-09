import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([".md", ".markdown"]);
const CODE_EXTENSIONS = new Set([".js", ".mjs"]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build"]);

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
    const pattern = /!?\[[^\]]*]\(\s*([^) \t]+|<[^>]+>)/g;
    let match;
    while ((match = pattern.exec(source))) {
      const target = relativeTarget(file, match[1]);
      if (!target) continue;
      if (target.invalidEncoding) {
        findings.push(finding("invalid_link_encoding", file, match[1]));
        continue;
      }
      if (!target.startsWith(path.resolve(root) + path.sep) &&
          target !== path.resolve(root)) {
        findings.push(finding("link_escapes_root", file, match[1]));
      } else if (!fs.existsSync(target)) {
        findings.push(finding("missing_relative_link", file, match[1]));
      }
    }
  }
  return findings;
}

function looksLikeEntrypoint(source, file) {
  const name = path.basename(file).toLowerCase();
  return /(?:example|demo|diagnostic|smoke|entry|index)/.test(name) ||
    /\bprocess\.argv\b/.test(source) ||
    /\bfunction\s+main\s*\(/.test(source) ||
    /\bconst\s+main\s*=/.test(source);
}

function hasMainFunction(source) {
  return /\b(?:async\s+)?function\s+main\s*\(\s*\)/.test(source) ||
    /\bconst\s+main\s*=\s*(?:async\s*)?\(\s*\)\s*=>/.test(source) ||
    /\bconst\s+main\s*=\s*(?:async\s*)?function\b/.test(source);
}

function hasWindowsSafeGuard(source) {
  const argv = /process\.argv\s*\[\s*1\s*]/;
  const moduleUrl = /import\.meta\.url/;
  const fileUrl = /fileURLToPath\s*\(\s*import\.meta\.url\s*\)/;
  return argv.test(source) && moduleUrl.test(source) &&
    (fileUrl.test(source) || /pathToFileURL/.test(source));
}

function checkEntrypoints(root) {
  const findings = [];
  const examplesRoot = path.join(root, "examples");
  if (!fs.existsSync(examplesRoot)) return findings;
  for (const file of walk(examplesRoot)) {
    if (!CODE_EXTENSIONS.has(path.extname(file))) continue;
    const source = fs.readFileSync(file, "utf8");
    if (!looksLikeEntrypoint(source, file)) continue;
    if (!hasMainFunction(source)) {
      findings.push(finding("entrypoint_missing_main", file,
        "detected as an entrypoint but no main() function was found"));
      continue;
    }
    if (!hasWindowsSafeGuard(source)) {
      findings.push(finding("entrypoint_missing_main_guard", file,
        "main() is not protected by a fileURLToPath(import.meta.url) guard"));
    }
  }
  return findings;
}

function relativeName(root, file) {
  return path.relative(root, file) || ".";
}

function check(root) {
  return [...checkLinks(root), ...checkEntrypoints(root)];
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
      name: "valid links and guarded entrypoint",
      files: {
        "README.md": "[run](examples/demo.entry.mjs)\n",
        "examples/demo.entry.mjs":
          "import { fileURLToPath } from 'node:url';\n" +
          "function main() { return 0; }\n" +
          "if (process.argv[1] === fileURLToPath(import.meta.url)) main();\n",
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
      name: "entrypoint needs a guard",
      files: {
        "examples/demo.mjs": "function main() { return 0; }\nmain();\n",
      },
      expected: ["entrypoint_missing_main_guard"],
    },
    {
      name: "entrypoint needs main",
      files: {
        "examples/smoke.mjs":
          "if (process.argv[1] === import.meta.url) console.log('x');\n",
      },
      expected: ["entrypoint_missing_main"],
    },
    {
      name: "encoded local link resolves",
      files: {
        "README.md": "[guide](docs/my%20guide.md)\n",
        "docs/my guide.md": "# Guide\n",
      },
      expected: [],
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
