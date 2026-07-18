#!/usr/bin/env node

import { spawnSync, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sanitizeWorkerEnv } from "./adapter-conformance-lib.mjs";

const WORKER_PATH = fileURLToPath(new URL("./adapter-conformance-worker.mjs", import.meta.url));
const DEFAULT_TIMEOUT_MS = 20_000;

function usage() {
  return `Adapter Conformance Agent

Usage:
  node scripts/adapter-conformance-agent.mjs [options]

Options:
  --adapter <id[,id...]>  Test only named integration IDs; repeatable.
  --jobs <count>          Forked worker concurrency (default: up to 4).
  --timeout-ms <ms>       Per-integration worker timeout (default: 20000).
  --report <path>         Atomically write the JSON report.
  --json                  Print the complete report instead of the text summary.
  --root <path>           Repository root (primarily for hermetic tests).
  --manifest <path>       Manifest path relative to root (default: integrations.json).
  --help                  Show this help.

Boundary: offline static and syntax evidence only. Adapter code is never imported
or executed, and the agent performs no network, wallet, paid, or production action.`;
}

export function parseArgs(argv) {
  const args = {
    adapters: [],
    help: false,
    jobs: Math.max(1, Math.min(4, os.availableParallelism?.() || os.cpus().length || 1)),
    json: false,
    manifest: "integrations.json",
    report: null,
    root: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };
    if (arg === "--adapter") args.adapters.push(...next().split(",").map((value) => value.trim()).filter(Boolean));
    else if (arg === "--jobs") args.jobs = Number.parseInt(next(), 10);
    else if (arg === "--timeout-ms") args.timeoutMs = Number.parseInt(next(), 10);
    else if (arg === "--report") args.report = next();
    else if (arg === "--root") args.root = next();
    else if (arg === "--manifest") args.manifest = next();
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(args.jobs) || args.jobs < 1 || args.jobs > 16) {
    throw new Error("--jobs must be an integer from 1 to 16");
  }
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1_000 || args.timeoutMs > 120_000) {
    throw new Error("--timeout-ms must be an integer from 1000 to 120000");
  }
  return args;
}

function resolveManifest(root, manifest) {
  const absolute = path.resolve(root, manifest);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Manifest must remain inside the repository root");
  }
  return absolute;
}

function sourceCommit(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    env: sanitizeWorkerEnv(),
    timeout: 5_000,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function workerFailure(integration, summary, evidence = undefined) {
  return {
    id: integration.id,
    name: integration.name,
    language: integration.language,
    declared_status: integration.status,
    primary_path: integration.path,
    docs_path: integration.docs,
    result: "fail",
    checks: [{ id: "forked_worker", state: "fail", summary, ...(evidence ? { evidence } : {}) }],
    summary: { failed: 1, warnings: 0, passed: 0, not_applicable: 0 },
    evidence_boundary: {
      adapter_code_executed: false,
      network_calls_performed: false,
      paid_calls_performed: false,
      production_mutation_performed: false,
      proof_level: "worker_infrastructure_failure",
    },
    duration_ms: 0,
  };
}

function runForkedWorker(root, integration, options) {
  return new Promise((resolve) => {
    const child = fork(WORKER_PATH, [], {
      env: sanitizeWorkerEnv(),
      execArgv: ["--no-warnings"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let settled = false;
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 16_384) stderr += chunk.toString("utf8");
    });
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      child.kill();
      finish(workerFailure(integration, `Forked worker exceeded ${options.timeoutMs} ms.`, { code: "worker_timeout" }));
    }, options.timeoutMs);

    child.once("message", (message) => {
      if (message?.ok && message.result) finish(message.result);
      else finish(workerFailure(integration, "Forked worker returned an error.", {
        code: "worker_error",
        detail: message?.error || "unknown_worker_error",
      }));
    });
    child.once("error", (error) => {
      finish(workerFailure(integration, "Forked worker could not start.", { code: "worker_spawn_error", detail: error.message }));
    });
    child.once("exit", (code) => {
      if (!settled) finish(workerFailure(integration, "Forked worker exited before returning evidence.", {
        code: "worker_early_exit",
        exit_code: code,
        stderr_present: Boolean(stderr.trim()),
      }));
    });

    try {
      child.send({
        root,
        integration,
        pythonCommand: process.env.ADAPTER_CONFORMANCE_PYTHON || "python",
      }, (error) => {
        if (error) finish(workerFailure(integration, "Forked worker IPC failed.", { code: "worker_ipc_error" }));
      });
    } catch {
      finish(workerFailure(integration, "Forked worker IPC failed.", { code: "worker_ipc_error" }));
    }
  });
}

function writeReport(reportPath, report) {
  const absolute = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, absolute);
}

function textSummary(report) {
  const lines = [
    "Adapter Conformance Agent",
    `Scope: ${report.summary.total} integration(s); offline static and syntax evidence only`,
    `Result: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.advisories} advisory check(s)`,
  ];
  for (const result of report.results.filter((entry) => entry.result === "fail")) {
    const failures = result.checks.filter((check) => check.state === "fail").map((check) => check.id).join(", ");
    lines.push(`FAIL ${result.id}: ${failures}`);
  }
  if (report.report_path) lines.push(`Report: ${report.report_path}`);
  lines.push("Boundary: no adapter execution, network calls, paid calls, wallet actions, or production mutation.");
  return lines.join("\n");
}

export async function runAgent(options) {
  const started = Date.now();
  const root = fs.realpathSync(path.resolve(options.root));
  const manifestPath = resolveManifest(root, options.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.integrations)) throw new Error("Manifest must contain integrations[]");

  const requested = [...new Set(options.adapters)];
  const knownIds = new Set(manifest.integrations.map((integration) => integration.id));
  const unknown = requested.filter((id) => !knownIds.has(id));
  if (unknown.length > 0) throw new Error(`Unknown integration id(s): ${unknown.join(", ")}`);
  const selected = requested.length > 0
    ? manifest.integrations.filter((integration) => requested.includes(integration.id))
    : manifest.integrations;

  const results = new Array(selected.length);
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < selected.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await runForkedWorker(root, selected[index], options);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.jobs, Math.max(1, selected.length)) }, consume));

  const report = {
    schema: "agoragentic.adapter-conformance-report.v1",
    generated_at: new Date().toISOString(),
    source_commit: sourceCommit(root),
    manifest: normalizeReportPath(root, manifestPath),
    selection: requested.length > 0 ? requested : "all",
    execution: {
      coordinator_pid: process.pid,
      forked_workers: selected.length,
      max_concurrency: options.jobs,
      worker_timeout_ms: options.timeoutMs,
      node: process.version,
      platform: process.platform,
    },
    evidence_boundary: {
      adapter_code_executed: false,
      network_calls_performed: false,
      paid_calls_performed: false,
      production_mutation_performed: false,
      credential_values_inherited_by_workers: false,
    },
    summary: {
      total: results.length,
      passed: results.filter((result) => result.result === "pass").length,
      failed: results.filter((result) => result.result === "fail").length,
      advisories: results.reduce((sum, result) => sum + result.summary.warnings, 0),
      duration_ms: Date.now() - started,
    },
    results,
  };
  if (options.report) {
    writeReport(options.report, report);
    report.report_path = path.resolve(options.report);
  }
  return report;
}

function normalizeReportPath(root, absolute) {
  return path.relative(root, absolute).replaceAll("\\", "/");
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const report = await runAgent(options);
    console.log(options.json ? JSON.stringify(report, null, 2) : textSummary(report));
    if (report.summary.failed > 0) process.exitCode = 1;
  } catch (error) {
    console.error(`Adapter conformance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
