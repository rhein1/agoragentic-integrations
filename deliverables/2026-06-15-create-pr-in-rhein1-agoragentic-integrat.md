import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_API_BASE = process.env.AGORAGENTIC_API_BASE || "https://agoragentic.com/api";

export const sellerListingManifest = {
  schema: "agoragentic.integration.mcp-seller.v1",
  id: "example.code-review-mcp",
  name: "Example MCP Code Review Agent",
  description:
    "Sample seller listing manifest for a hypothetical MCP-native code review agent, plus a local buyer wrapper that routes through execute(), records receipts, and enforces review policy before any paid call.",
  provider: {
    name: "example-code-review-agent",
    runtime: "mcp",
    transport: {
      primary: "stdio",
      supported: ["stdio", "http"]
    },
    endpoint_url: null,
    requires_owner_hosting: true,
    mcp_server: {
      server_name: "code-review-agent",
      server_version: "0.1.0",
      tool_name: "review_pull_request",
      tool_description:
        "Review a bounded pull request diff and return findings grouped by severity with file and line references.",
      tool_input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "pull_request", "diff"],
        properties: {
          repo: {
            type: "string",
            minLength: 3,
            description: "Repository slug or local repo identifier."
          },
          pull_request: {
            type: "object",
            additionalProperties: false,
            required: ["number", "title", "base", "head"],
            properties: {
              number: { type: "integer", minimum: 1 },
              title: { type: "string", minLength: 1 },
              base: { type: "string", minLength: 1 },
              head: { type: "string", minLength: 1 }
            }
          },
          diff: {
            type: "string",
            minLength: 1,
            maxLength: 120000,
            description: "Unified diff content for the review scope."
          },
          changed_files: {
            type: "array",
            maxItems: 200,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "language"],
              properties: {
                path: { type: "string", minLength: 1 },
                language: { type: "string", minLength: 1 }
              }
            }
          },
          focus_areas: {
            type: "array",
            maxItems: 10,
            items: { type: "string", minLength: 1 }
          },
          policy: {
            type: "object",
            additionalProperties: false,
            properties: {
              block_secrets: { type: "boolean", default: true },
              max_cost_usdc: { type: "number", minimum: 0, default: 0.25 },
              require_receipt: { type: "boolean", default: true },
              require_human_approval_for_high_risk: { type: "boolean", default: true }
            }
          }
        }
      }
    }
  },
  listing: {
    category: "developer-tools",
    listing_type: "service",
    pricing_model: "usage_based",
    price_hint_usdc: {
      min: 0.1,
      typical: 0.2,
      max: 0.4
    },
    tags: [
      "mcp",
      "code-review",
      "pull-request",
      "developer-tools",
      "receipt-backed",
      "policy-enforced"
    ]
  },
  buyer_wrapper: {
    runtime: "node>=18",
    entrypoint: "LocalCodeReviewBuyerWrapper.executeReview",
    local_only: true,
    execute_entrypoint: `${DEFAULT_API_BASE}/execute`,
    receipt_entrypoint: `${DEFAULT_API_BASE}/commerce/receipts/{receipt_id}`,
    writes_local_usage_receipts: true
  },
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["repo", "pull_request", "diff"],
    properties: {
      repo: { type: "string", minLength: 3 },
      pull_request: {
        type: "object",
        additionalProperties: false,
        required: ["number", "title", "base", "head"],
        properties: {
          number: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 1 },
          base: { type: "string", minLength: 1 },
          head: { type: "string", minLength: 1 }
        }
      },
      diff: {
        type: "string",
        minLength: 1,
        maxLength: 120000
      },
      changed_files: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "language"],
          properties: {
            path: { type: "string", minLength: 1 },
            language: { type: "string", minLength: 1 }
          }
        }
      },
      focus_areas: {
        type: "array",
        maxItems: 10,
        items: { type: "string", minLength: 1 }
      },
      approval: {
        type: "object",
        additionalProperties: false,
        properties: {
          approved_by: { type: "string", minLength: 1 },
          ticket: { type: "string", minLength: 1 },
          approved_at: { type: "string", format: "date-time" }
        }
      }
    }
  },
  output_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "findings", "metadata"],
    properties: {
      summary: {
        type: "string",
        minLength: 1
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "title", "path", "start_line", "recommendation"],
          properties: {
            severity: {
              type: "string",
              enum: ["critical", "high", "medium", "low", "info"]
            },
            title: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
            start_line: { type: "integer", minimum: 1 },
            end_line: { type: "integer", minimum: 1 },
            recommendation: { type: "string", minLength: 1 },
            evidence: { type: "string" }
          }
        }
      },
      metadata: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "review_mode", "receipt_required"],
        properties: {
          provider: { type: "string", const: "example-code-review-agent" },
          review_mode: { type: "string", enum: ["bounded_pull_request_review"] },
          receipt_required: { type: "boolean", const: true },
          invocation_id: { type: "string" },
          receipt_id: { type: "string" }
        }
      }
    }
  },
  usage_receipts: {
    required: true,
    storage: "local_json",
    fields: [
      "local_receipt_id",
      "created_at",
      "repo",
      "pull_request.number",
      "policy.policy_hash",
      "request.diff_sha256",
      "request.changed_file_count",
      "router.invocation_id",
      "router.receipt_id",
      "router.cost",
      "router.settlement",
      "result.finding_count"
    ]
  },
  policy_enforcement: {
    enforced_by: "LocalCodeReviewBuyerWrapper",
    rules: [
      "Reject diffs larger than 120000 characters.",
      "Reject diffs or filenames that appear to contain secrets, private keys, bearer tokens, or environment exports.",
      "Require human approval metadata for public-repo or high-risk review requests when policy says so.",
      "Always set a max_cost_usdc constraint before execute().",
      "Persist a local usage receipt with request hash, policy hash, invocation id, and fetched commerce receipt when available."
    ]
  },
  sandbox_probe: {
    input: {
      repo: "example/monorepo",
      pull_request: {
        number: 42,
        title: "Fix auth middleware ordering",
        base: "main",
        head: "fix/auth-ordering"
      },
      diff: "diff --git a/src/auth.ts b/src/auth.ts\n@@ -10,6 +10,7 @@\n-validateSession();\n+loadConfig();\n+validateSession();\n",
      changed_files: [
        {
          path: "src/auth.ts",
          language: "typescript"
        }
      ],
      focus_areas: ["auth", "error handling"]
    },
    expected: {
      summary: "string",
      findings: "array",
      metadata: {
        receipt_required: true
      }
    }
  },
  guardrails: [
    "Do not upload repository archives, full history, or unrelated files; send only bounded diff scope.",
    "Do not pass secrets, credentials, private keys, raw tokens, or .env content into the review payload.",
    "Do not claim a review happened without an invocation id and local usage receipt.",
    "Do not bypass buyer-side policy checks even when the seller advertises a broader capability surface."
  ]
};

const DEFAULT_POLICY = Object.freeze({
  maxDiffChars: 120000,
  maxFiles: 200,
  maxCostUsdc: 0.25,
  requireReceipt: true,
  requireHumanApprovalForHighRisk: true,
  approvalRequiredForPublicRepo: true,
  blockedFilePattern: /(^|\/)\.env($|\.)|id_rsa|id_ed25519|\.pem$|\.p12$|\.key$|secrets?\.json$|credentials?\.json$/i,
  blockedContentPattern:
    /(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36,}|glpat-[A-Za-z0-9\-_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._\-]+|api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,}|secret\s*[:=]\s*['"]?[A-Za-z0-9\/+=._\-]{12,})/i,
  allowedLanguages: new Set([
    "typescript",
    "javascript",
    "python",
    "go",
    "rust",
    "java",
    "csharp",
    "ruby",
    "php",
    "kotlin",
    "swift"
  ])
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeHeaders(apiKey) {
  const headers = {
    "content-type": "application/json"
  };

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

async function readJsonOrThrow(response) {
  const text = await response.text();
  let body = null;

  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Expected JSON response, got: ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function classifyRisk(input) {
  const focus = new Set((input.focus_areas || []).map((value) => String(value).toLowerCase()));
  const text = `${input.repo}\n${input.pull_request?.title || ""}\n${input.diff}`.toLowerCase();

  if (
    focus.has("auth") ||
    focus.has("authentication") ||
    focus.has("authorization") ||
    focus.has("permissions") ||
    focus.has("payments") ||
    focus.has("crypto") ||
    focus.has("security") ||
    /auth|oauth|token|permission|payment|wallet|crypto|signature|sudo|rbac/.test(text)
  ) {
    return "high";
  }

  return "normal";
}

function assertPolicy(input, policy) {
  if (!input || typeof input !== "object") {
    throw new Error("Review input must be an object.");
  }

  if (!input.repo || typeof input.repo !== "string") {
    throw new Error("repo is required.");
  }

  if (!input.pull_request || typeof input.pull_request !== "object") {
    throw new Error("pull_request is required.");
  }

  if (!Number.isInteger(input.pull_request.number) || input.pull_request.number < 1) {
    throw new Error("pull_request.number must be a positive integer.");
  }

  if (!input.diff || typeof input.diff !== "string") {
    throw new Error("diff is required.");
  }

  if (input.diff.length > policy.maxDiffChars) {
    throw new Error(`Diff exceeds policy limit of ${policy.maxDiffChars} characters.`);
  }

  if (policy.blockedContentPattern.test(input.diff)) {
    throw new Error("Diff appears to contain a secret, credential, token, or private key material.");
  }

  const changedFiles = Array.isArray(input.changed_files) ? input.changed_files : [];
  if (changedFiles.length > policy.maxFiles) {
    throw new Error(`changed_files exceeds policy limit of ${policy.maxFiles} files.`);
  }

  for (const file of changedFiles) {
    if (!file || typeof file !== "object") {
      throw new Error("Each changed_files entry must be an object.");
    }

    if (!file.path || typeof file.path !== "string") {
      throw new Error("Each changed_files entry must include a path.");
    }

    if (policy.blockedFilePattern.test(file.path)) {
      throw new Error(`Blocked file path detected by policy: ${file.path}`);
    }

    if (file.language && !policy.allowedLanguages.has(String(file.language).toLowerCase())) {
      throw new Error(`Language not allowed by policy: ${file.language}`);
    }
  }

  const risk = classifyRisk(input);
  const repoLooksPublic =
    typeof input.repo === "string" &&
    !input.repo.startsWith(".") &&
    !input.repo.startsWith("/") &&
    input.repo.includes("/");

  if (
    (risk === "high" && policy.requireHumanApprovalForHighRisk) ||
    (repoLooksPublic && policy.approvalRequiredForPublicRepo)
  ) {
    const approval = input.approval || {};
    if (!approval.approved_by || !approval.ticket || !approval.approved_at) {
      throw new Error(
        "Human approval metadata is required by policy for this review request."
      );
    }
  }

  return {
    risk,
    repoLooksPublic,
    changedFileCount: changedFiles.length
  };
}

async function writeLocalReceipt(receiptDir, receipt) {
  await mkdir(receiptDir, { recursive: true });
  const filePath = path.join(
    receiptDir,
    `${receipt.local_receipt_id}.json`
  );
  await writeFile(filePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return filePath;
}

export class LocalCodeReviewBuyerWrapper {
  constructor(options = {}) {
    this.apiBase = options.apiBase || DEFAULT_API_BASE;
    this.apiKey = options.apiKey || process.env.AGORAGENTIC_API_KEY || "";
    this.receiptDir =
      options.receiptDir ||
      path.resolve(process.cwd(), ".agoragentic", "receipts", "code-review");
    this.policy = {
      ...DEFAULT_POLICY,
      ...(options.policy || {})
    };
  }

  buildExecutePayload(input, overrides = {}) {
    const effectiveMaxCost =
      overrides.maxCostUsdc ??
      input.policy?.max_cost_usdc ??
      this.policy.maxCostUsdc;

    return {
      task: "code_review",
      input: {
        repo: input.repo,
        pull_request: input.pull_request,
        diff: input.diff,
        changed_files: input.changed_files || [],
        focus_areas: input.focus_areas || [],
        review_mode: "bounded_pull_request_review"
      },
      constraints: {
        max_cost: effectiveMaxCost,
        require_receipt: input.policy?.require_receipt ?? this.policy.requireReceipt,
        tags: ["mcp", "code-review", "pull-request"],
        metadata: {
          seller_listing_id: sellerListingManifest.id,
          buyer_wrapper: "LocalCodeReviewBuyerWrapper",
          policy_hash: sha256(
            stableStringify({
              maxDiffChars: this.policy.maxDiffChars,
              maxFiles: this.policy.maxFiles,
              maxCostUsdc: effectiveMaxCost,
              requireReceipt: this.policy.requireReceipt,
              requireHumanApprovalForHighRisk:
                this.policy.requireHumanApprovalForHighRisk,
              approvalRequiredForPublicRepo:
                this.policy.approvalRequiredForPublicRepo
            })
          )
        }
      }
    };
  }

  async fetchReceipt(receiptId) {
    if (!receiptId) {
      return null;
    }

    const response = await fetch(
      `${this.apiBase}/commerce/receipts/${encodeURIComponent(receiptId)}`,
      {
        method: "GET",
        headers: normalizeHeaders(this.apiKey)
      }
    );

    return readJsonOrThrow(response);
  }

  async executeReview(input, overrides = {}) {
    const policyEvaluation = assertPolicy(input, this.policy);
    const payload = this.buildExecutePayload(input, overrides);
    const requestHash = sha256(
      stableStringify({
        task: payload.task,
        input: payload.input,
        constraints: payload.constraints
      })
    );

    const executeResponse = await fetch(`${this.apiBase}/execute`, {
      method: "POST",
      headers: normalizeHeaders(this.apiKey),
      body: JSON.stringify(payload)
    });

    const executeBody = await readJsonOrThrow(executeResponse);
    const invocationId =
      executeBody.invocation_id ||
      executeBody.invocation?.id ||
      executeBody.metadata?.invocation_id ||
      null;
    const receiptId =
      executeBody.receipt_id ||
      executeBody.receipt?.receipt_id ||
      executeBody.metadata?.receipt_id ||
      null;

    const fetchedReceipt =
      payload.constraints.require_receipt && receiptId
        ? await this.fetchReceipt(receiptId)
        : null;

    const localReceipt = {
      local_receipt_id: `local_rcpt_${crypto.randomUUID()}`,
      created_at: nowIso(),
      listing_id: sellerListingManifest.id,
      repo: input.repo,
      pull_request: {
        number: input.pull_request.number,
        title: input.pull_request.title,
        base: input.pull_request.base,
        head: input.pull_request.head
      },
      policy: {
        risk: policyEvaluation.risk,
        repo_looks_public: policyEvaluation.repoLooksPublic,
        changed_file_count: policyEvaluation.changedFileCount,
        policy_hash: payload.constraints.metadata.policy_hash
      },
      request: {
        diff_sha256: sha256(input.diff),
        changed_file_count: policyEvaluation.changedFileCount,
        focus_areas: input.focus_areas || [],
        max_cost_usdc: payload.constraints.max_cost
      },
      router: {
        invocation_id: invocationId,
        receipt_id: receiptId,
        cost:
          executeBody.cost ??
          executeBody.price ??
          executeBody.metadata?.cost ??
          null,
        settlement:
          fetchedReceipt?.settlement ||
          executeBody.settlement ||
          executeBody.metadata?.settlement ||
          null
      },
      result: {
        summary:
          executeBody.result?.summary ||
          executeBody.summary ||
          null,
        finding_count:
          executeBody.result?.findings?.length ||
          executeBody.findings?.length ||
          0
      },
      commerce_receipt: fetchedReceipt
    };

    const receiptPath = await writeLocalReceipt(this.receiptDir, localReceipt);

    return {
      manifest_id: sellerListingManifest.id,
      invocation_id: invocationId,
      receipt_id: receiptId,
      local_receipt_path: receiptPath,
      local_receipt: localReceipt,
      result: executeBody.result || executeBody
    };
  }
}

export async function demo() {
  const wrapper = new LocalCodeReviewBuyerWrapper();
  const sampleInput = {
    repo: "example/monorepo",
    pull_request: {
      number: 42,
      title: "Fix auth middleware ordering",
      base: "main",
      head: "fix/auth-ordering"
    },
    diff: [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "@@ -10,6 +10,7 @@",
      "-validateSession();",
      "+loadConfig();",
      "+validateSession();"
    ].join("\n"),
    changed_files: [{ path: "src/auth.ts", language: "typescript" }],
    focus_areas: ["auth"],
    approval: {
      approved_by: "maintainer@example.com",
      ticket: "SEC-142",
      approved_at: nowIso()
    }
  };

  const result = await wrapper.executeReview(sampleInput);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isDirectRun = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isDirectRun) {
  demo().catch((error) => {
    const output = {
      error: error.message,
      status: error.status || null,
      body: error.body || null
    };
    process.stderr.write(`${JSON.stringify(output, null, 2)}\n`);
    process.exit(1);
  });
}