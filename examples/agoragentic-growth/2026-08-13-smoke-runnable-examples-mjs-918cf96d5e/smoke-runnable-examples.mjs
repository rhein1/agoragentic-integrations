import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = path.resolve(new URL("..", import.meta.url).pathname, "..");
const README_NAMES = new Set(["README.md", "readme.md"]);
const SOURCE_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".py"]);
const COMMAND_RE =
  /\b(?:node(?:js)?|python(?:3)?)(?:\s+(?:--[A-Za-z0-9_-]+(?:=\S+)?))*\s+(`?)([^\s`;&|]+)\1/g;

function usage() {
  return [
    "Usage: node scripts/smoke-runnable-examples.mjs [--root PATH]",
    "",
    "Checks documented local example entrypoints without starting them.",
    "It resolves node/python commands in README files below examples/",
    "and reports missing, escaping, duplicated, or empty entrypoint files.",
  ].join("\n");
}

function parseArgs(argv) {
  let root = DEFAULT_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true, root };
    }
    if (argument === "--root") {
      if (!argv[index + 1]) throw new Error("--root requires a path");
      root = path.resolve(argv[++index]);
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
    throw new Error(`unexpected argument: ${argument}`);
  }
  return { help: false, root };
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function walk(directory) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function normalizeToken(token) {
  return token.replace(/^["']|["']$/g, "").replace(/[),.:]+$/, "");
}

function extractCommands(markdown) {
  const commands = [];
  for (const match of markdown.matchAll(COMMAND_RE)) {
    const token = normalizeToken(match[2]);
    if (!token || token.startsWith("-") || token.includes("${")) continue;
    if (token.includes("://")) continue;
    const extension = path.extname(token).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    commands.push(token);
  }
  return commands;
}

function resolveDocumentedPath(root, document, token) {
  const documentDirectory = path.dirname(document);
  const candidate = token.startsWith("examples/")
    ? path.resolve(root, token)
    : path.resolve(documentDirectory, token);
  return {
    candidate,
    relative: path.relative(root, candidate) || ".",
    valid: isInside(root, candidate),
  };
}

function finding(code, document, detail) {
  return { code, document: path.relative(process.cwd(), document), detail };
}

function inspectEntry(root, document, token) {
  const resolved = resolveDocumentedPath(root, document, token);
  if (!resolved.valid) {
    return finding(
      "entrypoint_escapes_root",
      document,
      `${token} resolves outside ${root}`,
    );
  }
  if (!fs.existsSync(resolved.candidate)) {
    return finding(
      "missing_entrypoint",
      document,
      `${token} resolves to ${resolved.relative}, but that file does not exist`,
    );
  }
  let stat;
  try {
    stat = fs.statSync(resolved.candidate);
  } catch (error) {
    return finding(
      "unreadable_entrypoint",
      document,
      `${resolved.relative} could not be inspected: ${error.message}`,
    );
  }
  if (!stat.isFile()) {
    return finding(
      "entrypoint_not_file",
      document,
      `${resolved.relative} is not a regular file`,
    );
  }
  if (stat.size === 0) {
    return finding(
      "empty_entrypoint",
      document,
      `${resolved.relative} is empty`,
    );
  }
  return null;
}

function collectFindings(root) {
  const examples = path.join(root, "examples");
  const documents = walk(examples).filter((file) => README_NAMES.has(path.basename(file)));
  const findings = [];
  const notices = [];
  const entries = new Map();

  for (const document of documents) {
    let markdown;
    try {
      markdown = fs.readFileSync(document, "utf8");
    } catch (error) {
      findings.push(finding("unreadable_document", document, error.message));
      continue;
    }
    for (const token of extractCommands(markdown)) {
      const key = `${document}\0${token}`;
      if (entries.has(key)) {
        findings.push(
          finding(
            "duplicate_entrypoint",
            document,
            `documented more than once: ${token}`,
          ),
        );
        continue;
      }
      entries.set(key, true);
      const result = inspectEntry(root, document, token);
      if (result) findings.push(result);
    }
  }

  if (documents.length === 0) {
    notices.push({
      code: "no_example_documentation",
      document: path.relative(process.cwd(), examples),
      detail: "no README files were found below examples/",
      action: "Add a README with a local node/python example command to enable this check.",
    });
  }
  if (entries.size === 0 && documents.length > 0) {
    findings.push({
      code: "no_documented_entrypoints",
      document: path.relative(process.cwd(), examples),
      detail: "README files contain no supported node/python entrypoint commands",
    });
  }
  return { entries, findings, notices };
}

function formatFinding(item) {
  return `FAIL ${item.code}: ${item.document}: ${item.detail}`;
}

function formatNotice(item) {
  return `WARN ${item.code}: ${item.document}: ${item.detail} Action: ${item.action}`;
}

function run(root) {
  if (!fs.existsSync(root)) {
    console.error(`FAIL root_not_found: ${root}`);
    return 1;
  }
  const result = collectFindings(root);
  const count = result.entries.size;
  console.log(`Checked ${count} documented example entrypoint${count === 1 ? "" : "s"}.`);
  for (const item of result.notices) console.warn(formatNotice(item));
  if (result.findings.length > 0) {
    for (const item of result.findings) console.error(formatFinding(item));
    console.error("Action: correct the README command or add the missing local entrypoint, then rerun.");
    return 1;
  }
  if (result.notices.length > 0) {
    console.log("No documented entrypoints were available; repository check completed without network access.");
  } else {
    console.log("All documented entrypoints resolve to non-empty local files.");
  }
  console.log("AGOS_RUNTIME_OK");
  return 0;
}

function selfTest() {
  const cases = [
    {
      name: "node command",
      input: "Run `node ./demo.mjs`.",
      expected: ["./demo.mjs"],
    },
    {
      name: "python command",
      input: "python3 examples/demo.py",
      expected: ["examples/demo.py"],
    },
    {
      name: "flags",
      input: "node --enable-source-maps ./demo.js",
      expected: ["./demo.js"],
    },
    {
      name: "url ignored",
      input: "node https://example.test/demo.mjs",
      expected: [],
    },
    {
      name: "non-source ignored",
      input: "node ./package.json",
      expected: [],
    },
    {
      name: "shell variable ignored",
      input: "node ${ENTRYPOINT}.mjs",
      expected: [],
    },
  ];
  for (const test of cases) {
    const actual = extractCommands(test.input);
    if (JSON.stringify(actual) !== JSON.stringify(test.expected)) {
      throw new Error(
        `${test.name}: expected ${JSON.stringify(test.expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  console.log("Self-test cases passed: 6");
  console.log("AGOS_RUNTIME_OK");
}

try {
  if (process.argv.includes("--self-test")) {
    selfTest();
  } else {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log(usage());
    else process.exitCode = run(options.root);
  }
} catch (error) {
  console.error(`FAIL invalid_invocation: ${error.message}`);
  process.exitCode = 2;
}
