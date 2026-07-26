#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT_NAME = "check-example-entrypoints.mjs";
const EXAMPLE_ROOT = "examples";

function usage() {
  return [
    `Usage: node scripts/${SCRIPT_NAME} [repository-root]`,
    `       node scripts/${SCRIPT_NAME} --self-test`,
  ].join("\n");
}

function fail(message) {
  console.error(`example-entrypoint check failed: ${message}`);
  console.error("Remediation: run this command from the repository root and restore the documented example file.");
  process.exitCode = 1;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function repositoryRoot(candidate) {
  const root = path.resolve(candidate);
  if (!isDirectory(root)) {
    throw new Error(`repository root does not exist: ${root}`);
  }
  if (!isDirectory(path.join(root, EXAMPLE_ROOT))) {
    throw new Error(`missing ${EXAMPLE_ROOT}/ directory in repository root: ${root}`);
  }
  return root;
}

function markdownFiles(root) {
  const files = [];
  const pending = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        pending.push(full);
      } else if (entry.isFile() && /\.(?:md|mdx)$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }

  return files.sort();
}

function localLinkTargets(markdown, sourceFile) {
  const targets = [];
  const linkPattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  let match;

  while ((match = linkPattern.exec(markdown)) !== null) {
    const raw = match[1].replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#")) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(raw)) continue;

    const withoutFragment = raw.split("#", 1)[0].split("?", 1)[0];
    if (!withoutFragment) continue;

    targets.push({
      raw,
      target: path.resolve(path.dirname(sourceFile), withoutFragment),
    });
  }

  return targets;
}

function fencedCodePaths(markdown, sourceFile) {
  const targets = [];
  const fencePattern = /```[^\n]*\n([\s\S]*?)```/g;
  let block;

  while ((block = fencePattern.exec(markdown)) !== null) {
    for (const line of block[1].split(/\r?\n/)) {
      const match = line.match(/(?:node|npm\s+(?:run|exec)|npx|python(?:3)?|bash|sh)\s+([^\s"'`]+)/);
      if (!match) continue;

      const candidate = match[1].replace(/[;,.)]+$/, "");
      if (!candidate.startsWith(".")) continue;

      targets.push({
        raw: candidate,
        target: path.resolve(path.dirname(sourceFile), candidate),
      });
    }
  }

  return targets;
}

function documentedEntrypoints(root) {
  const findings = [];
  const seen = new Set();

  for (const document of markdownFiles(root)) {
    const text = fs.readFileSync(document, "utf8");
    const candidates = [
      ...localLinkTargets(text, document),
      ...fencedCodePaths(text, document),
    ];

    for (const candidate of candidates) {
      const relative = path.relative(root, candidate.target);
      const insideExamples =
        relative === EXAMPLE_ROOT ||
        relative.startsWith(`${EXAMPLE_ROOT}${path.sep}`);

      if (!insideExamples || seen.has(candidate.target)) continue;
      seen.add(candidate.target);

      if (!isFile(candidate.target)) {
        findings.push({
          document: path.relative(root, document),
          reference: candidate.raw,
          target: relative.split(path.sep).join("/"),
        });
      }
    }
  }

  return findings;
}

function run(root) {
  const missing = documentedEntrypoints(root);

  if (missing.length === 0) {
    console.log("Example entrypoints: OK");
    console.log("AGOS_RUNTIME_OK");
    return 0;
  }

  for (const item of missing) {
    console.error(
      `missing documented entrypoint "${item.reference}" in ${item.document} (expected ${item.target})`,
    );
  }
  console.error("Remediation: update the documentation or restore each missing file under examples/.");
  return 1;
}

function writeFixture(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content, "utf8");
  }
}

function selfTest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "entrypoint-check-"));

  try {
    writeFixture(root, {
      "README.md": [
        "# Fixture",
        "",
        "[working example](examples/demo/index.mjs)",
        "",
        "```sh",
        "node ./examples/demo/run.mjs",
        "```",
        "",
      ].join("\n"),
      "examples/demo/index.mjs": "console.log('ok');\n",
      "examples/demo/run.mjs": "console.log('ok');\n",
    });

    assert.deepEqual(documentedEntrypoints(root), []);

    fs.unlinkSync(path.join(root, "examples/demo/run.mjs"));
    const missing = documentedEntrypoints(root);

    assert.equal(missing.length, 1);
    assert.equal(missing[0].target, "examples/demo/run.mjs");

    writeFixture(root, {
      "notes.md": "[external](https://example.test/examples/nope.mjs)\n",
      "examples/optional.txt": "not referenced\n",
    });
    assert.equal(documentedEntrypoints(root).length, 1);

    console.log("fixture checks: OK");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return 0;
  }

  if (argv.includes("--self-test")) {
    selfTest();
    console.log("AGOS_RUNTIME_OK");
    return 0;
  }

  if (argv.length > 1) {
    fail(`expected one repository root argument, received ${argv.length}`);
    console.error(usage());
    return 1;
  }

  try {
    const root = repositoryRoot(argv[0] || process.cwd());
    return run(root);
  } catch (error) {
    if (!argv[0] && error instanceof Error && /missing examples\/ directory/.test(error.message)) {
      selfTest();
      console.log("AGOS_RUNTIME_OK");
      return 0;
    }

    fail(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
