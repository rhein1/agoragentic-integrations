#!/usr/bin/env node
// demo — simulates audit receipts and policy attestations; moves no real funds.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";

const DEFAULT_TOOL_NAME = "audit_bim_i3f_execute";
const DEFAULT_SERVER_NAME = "audit-bim-i3f-local";
const DEFAULT_CAPABILITY_ID = "agoragentic.audit_bim_i3f.governed_local_execute.v1";
const DEFAULT_LISTING_ID = "audit-bim-i3f.governed-local-execute.v1";
const DEFAULT_POLICY_ID = "audit-bim-i3f-policy.v1";
const DEFAULT_RECEIPT_SECRET = "audit-bim-i3f-demo-receipt-secret";
const DEFAULT_VERSION = "0.1.0";

const ALLOWED_OPERATIONS = new Set(["inspect_model", "check_clashes", "summarize_issues", "validate_metadata"]);
const ALLOWED_SEVERITIES = new Set(["low", "medium", "high", "critical"]);
const ALLOWED_CLASSIFICATIONS = new Set(["geometry", "metadata", "coordination", "compliance"]);
const DENIED_ACTION_PREFIXES = ["deploy", "restart", "delete", "publish", "mutate", "write", "approve_payment"];

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  const payload = typeof value === "string" ? value : stableStringify(value);
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function utcNow() {
  return new Date().toISOString();
}

function nonEmptyString(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return normalized;
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function positiveInteger(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}

function normalizeStringArray(values, field, { minLength = 0 } = {}) {
  if (!Array.isArray(values)) {
    throw new Error(`${field} must be an array`);
  }
  const normalized = values.map((value, index) => nonEmptyString(value, `${field}[${index}]`));
  if (normalized.length < minLength) {
    throw new Error(`${field} must contain at least ${minLength} item(s)`);
  }
  return normalized;
}

function buildInputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["operation", "asset", "findings", "policy"],
    properties: {
      operation: {
        type: "string",
        enum: Array.from(ALLOWED_OPERATIONS),
        description: "Bounded local audit operation.",
      },
      asset: {
        type: "object",
        additionalProperties: false,
        required: ["project_id", "model_uri", "discipline"],
        properties: {
          project_id: { type: "string", minLength: 3 },
          model_uri: { type: "string", minLength: 5 },
          discipline: { type: "string", minLength: 2 },
          revision: { type: "string" },
        },
      },
      findings: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "severity", "classification", "description"],
          properties: {
            id: { type: "string", minLength: 2 },
            severity: { type: "string", enum: Array.from(ALLOWED_SEVERITIES) },
            classification: { type: "string", enum: Array.from(ALLOWED_CLASSIFICATIONS) },
            description: { type: "string", minLength: 4 },
            tags: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
      policy: {
        type: "object",
        additionalProperties: false,
        required: ["policy_id", "allowed_operations", "max_findings", "allowed_classifications", "require_evidence_tags"],
        properties: {
          policy_id: { type: "string", minLength: 3 },
          allowed_operations: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: Array.from(ALLOWED_OPERATIONS) },
          },
          max_findings: { type: "integer", minimum: 1, maximum: 500 },
          allowed_classifications: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: Array.from(ALLOWED_CLASSIFICATIONS) },
          },
          require_evidence_tags: { type: "boolean" },
          deny_actions: {
            type: "array",
            items: { type: "string" },
          },
          max_critical_findings: { type: "integer", minimum: 0, maximum: 200 },
        },
      },
      metadata: {
        type: "object",
        additionalProperties: true,
      },
      request_id: { type: "string" },
    },
  };
}

function buildOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["ok", "request_id", "policy_result", "result", "receipt", "manifest_digest"],
    properties: {
      ok: { type: "boolean" },
      request_id: { type: "string" },
      policy_result: {
        type: "object",
        additionalProperties: false,
        required: ["allowed", "checks"],
        properties: {
          allowed: { type: "boolean" },
          checks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "status", "evidence"],
              properties: {
                name: { type: "string" },
                status: { type: "string", enum: ["pass", "fail", "warn"] },
                evidence: { type: "string" },
              },
            },
          },
        },
      },
      result: { type: "object", additionalProperties: true },
      receipt: { type: "object", additionalProperties: true },
      manifest_digest: { type: "string" },
    },
  };
}

export function createSampleMcpManifest(options = {}) {
  const toolName = options.toolName || DEFAULT_TOOL_NAME;
  const serverName = options.serverName || DEFAULT_SERVER_NAME;
  const capabilityId = options.capabilityId || DEFAULT_CAPABILITY_ID;
  const listingId = options.listingId || DEFAULT_LISTING_ID;
  const inputSchema = buildInputSchema();
  const outputSchema = buildOutputSchema();

  const manifest = {
    schema: "agoragentic.seller-listing.mcp.v1",
    manifest_version: DEFAULT_VERSION,
    listing_id: listingId,
    capability_id: capabilityId,
    seller_id: "audit-bim-i3f",
    title: "audit-bim-i3f governed local execute example",
    summary: "Runnable local audit example with a sample MCP manifest, policy validation, and simulated receipts.",
    notes: [
      "demo — simulates audit receipts and policy attestations; moves no real funds.",
      "execute() is local-only and does not publish, mutate listings, or perform remote side effects.",
    ],
    governance: {
      execution_mode: "bounded-local",
      receipt_mode: "simulated",
      usage_tracking: true,
      required_controls: [
        "policy validation before execution",
        "classification allowlist",
        "evidence-tag requirement",
        "receipt digest over request, policy result, and output",
      ],
    },
    mcp: {
      server: {
        name: serverName,
        version: DEFAULT_VERSION,
        transport: "stdio",
      },
      tools: [
        {
          name: toolName,
          description: "Validate a bounded BIM audit request and produce an auditable local result with a simulated receipt.",
          inputSchema,
          outputSchema,
          annotations: {
            side_effects: "none",
            receipt_kind: "simulated-local-usage",
            bounded_operator_fallback: true,
          },
        },
      ],
    },
  };

  return {
    ...manifest,
    digests: {
      manifest_digest: sha256({
        listing_id: listingId,
        capability_id: capabilityId,
        server_name: serverName,
        tool_name: toolName,
        inputSchema,
        outputSchema,
        governance: manifest.governance,
      }),
      input_schema_digest: sha256(inputSchema),
      output_schema_digest: sha256(outputSchema),
    },
  };
}

export function createDefaultPolicy(overrides = {}) {
  return {
    policy_id: DEFAULT_POLICY_ID,
    allowed_operations: ["inspect_model", "check_clashes", "summarize_issues"],
    max_findings: 50,
    allowed_classifications: ["geometry", "metadata", "coordination", "compliance"],
    require_evidence_tags: true,
    deny_actions: ["deploy", "restart", "delete", "publish"],
    max_critical_findings: 5,
    ...clone(overrides),
  };
}

export function validatePolicy(policy) {
  assertPlainObject(policy, "policy");
  const checks = [];

  const policyId = nonEmptyString(policy.policy_id, "policy.policy_id");
  const allowedOperations = normalizeStringArray(policy.allowed_operations, "policy.allowed_operations", { minLength: 1 });
  const maxFindings = positiveInteger(policy.max_findings, "policy.max_findings", { min: 1, max: 500 });
  const allowedClassifications = normalizeStringArray(policy.allowed_classifications, "policy.allowed_classifications", { minLength: 1 });
  if (policy.require_evidence_tags !== true) {
    throw new Error("policy.require_evidence_tags must be true for governed receipt execution");
  }
  const denyActions = policy.deny_actions ? normalizeStringArray(policy.deny_actions, "policy.deny_actions") : [];
  const maxCriticalFindings = policy.max_critical_findings === undefined
    ? null
    : positiveInteger(policy.max_critical_findings, "policy.max_critical_findings", { min: 0, max: 200 });

  for (const operation of allowedOperations) {
    if (!ALLOWED_OPERATIONS.has(operation)) {
      throw new Error(`policy.allowed_operations contains unsupported operation: ${operation}`);
    }
  }
  for (const classification of allowedClassifications) {
    if (!ALLOWED_CLASSIFICATIONS.has(classification)) {
      throw new Error(`policy.allowed_classifications contains unsupported classification: ${classification}`);
    }
  }

  checks.push({ name: "policy_id_present", status: "pass", evidence: policyId });
  checks.push({ name: "allowed_operations_valid", status: "pass", evidence: allowedOperations.join(",") });
  checks.push({ name: "allowed_classifications_valid", status: "pass", evidence: allowedClassifications.join(",") });
  checks.push({ name: "evidence_tag_requirement_enforced", status: "pass", evidence: "required" });
  checks.push({ name: "max_findings_bound", status: maxFindings <= 200 ? "pass" : "warn", evidence: String(maxFindings) });
  checks.push({
    name: "deny_actions_present",
    status: denyActions.length > 0 ? "pass" : "warn",
    evidence: denyActions.join(",") || "none",
  });

  for (const denied of denyActions) {
    if (DENIED_ACTION_PREFIXES.some((prefix) => denied.startsWith(prefix))) {
      checks.push({ name: `denied_action_${denied}`, status: "pass", evidence: denied });
    }
  }

  return {
    policy_id: policyId,
    allowed_operations: allowedOperations,
    max_findings: maxFindings,
    allowed_classifications: allowedClassifications,
    require_evidence_tags: true,
    deny_actions: denyActions,
    max_critical_findings: maxCriticalFindings,
    checks,
  };
}

export function validateExecuteInput(input) {
  assertPlainObject(input, "input");

  const operation = nonEmptyString(input.operation, "input.operation");
  if (!ALLOWED_OPERATIONS.has(operation)) {
    throw new Error(`input.operation must be one of: ${Array.from(ALLOWED_OPERATIONS).join(", ")}`);
  }

  assertPlainObject(input.asset, "input.asset");
  const asset = {
    project_id: nonEmptyString(input.asset.project_id, "input.asset.project_id"),
    model_uri: nonEmptyString(input.asset.model_uri, "input.asset.model_uri"),
    discipline: nonEmptyString(input.asset.discipline, "input.asset.discipline"),
    revision: input.asset.revision ? nonEmptyString(input.asset.revision, "input.asset.revision") : "unspecified",
  };

  if (!Array.isArray(input.findings) || input.findings.length === 0) {
    throw new Error("input.findings must be a non-empty array");
  }
  if (input.findings.length > 200) {
    throw new Error("input.findings must contain at most 200 findings");
  }

  const findings = input.findings.map((finding, index) => {
    assertPlainObject(finding, `input.findings[${index}]`);
    const id = nonEmptyString(finding.id, `input.findings[${index}].id`);
    const severity = nonEmptyString(finding.severity, `input.findings[${index}].severity`);
    const classification = nonEmptyString(finding.classification, `input.findings[${index}].classification`);
    const description = nonEmptyString(finding.description, `input.findings[${index}].description`);
    if (!ALLOWED_SEVERITIES.has(severity)) {
      throw new Error(`input.findings[${index}].severity must be one of: ${Array.from(ALLOWED_SEVERITIES).join(", ")}`);
    }
    if (!ALLOWED_CLASSIFICATIONS.has(classification)) {
      throw new Error(`input.findings[${index}].classification must be one of: ${Array.from(ALLOWED_CLASSIFICATIONS).join(", ")}`);
    }
    const tags = finding.tags ? normalizeStringArray(finding.tags, `input.findings[${index}].tags`) : [];
    return { id, severity, classification, description, tags };
  });

  const policy = validatePolicy(input.policy);
  return {
    operation,
    asset,
    findings,
    policy,
    metadata: clone(input.metadata || {}),
    request_id: input.request_id ? nonEmptyString(input.request_id, "input.request_id") : `audit_bim_i3f_${randomUUID()}`,
  };
}

export function evaluatePolicy(input) {
  const checks = [...input.policy.checks];
  const operationAllowed = input.policy.allowed_operations.includes(input.operation);
  checks.push({
    name: "operation_allowed",
    status: operationAllowed ? "pass" : "fail",
    evidence: `${input.operation} in ${input.policy.allowed_operations.join(",")}`,
  });

  const findingsWithinLimit = input.findings.length <= input.policy.max_findings;
  checks.push({
    name: "finding_count_within_limit",
    status: findingsWithinLimit ? "pass" : "fail",
    evidence: `${input.findings.length}/${input.policy.max_findings}`,
  });

  const disallowedClassifications = input.findings
    .map((finding) => finding.classification)
    .filter((classification) => !input.policy.allowed_classifications.includes(classification));
  checks.push({
    name: "classification_allowlist",
    status: disallowedClassifications.length === 0 ? "pass" : "fail",
    evidence: disallowedClassifications.length === 0 ? "all findings allowed" : disallowedClassifications.join(","),
  });

  const missingEvidenceTags = input.policy.require_evidence_tags
    ? input.findings.filter((finding) => finding.tags.length === 0).map((finding) => finding.id)
    : [];
  checks.push({
    name: "evidence_tags_present",
    status: missingEvidenceTags.length === 0 ? "pass" : "fail",
    evidence: missingEvidenceTags.length === 0 ? "all findings tagged" : missingEvidenceTags.join(","),
  });

  const criticalCount = input.findings.filter((finding) => finding.severity === "critical").length;
  if (input.policy.max_critical_findings !== null) {
    checks.push({
      name: "critical_findings_bound",
      status: criticalCount <= input.policy.max_critical_findings ? "pass" : "fail",
      evidence: `${criticalCount}/${input.policy.max_critical_findings}`,
    });
  }

  const deniedActionHit = input.policy.deny_actions.find((denied) => input.operation.startsWith(denied));
  checks.push({
    name: "deny_action_not_triggered",
    status: deniedActionHit ? "fail" : "pass",
    evidence: deniedActionHit || "none",
  });

  return {
    allowed: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

function summarizeFindings(findings) {
  const severityCounts = {};
  const classificationCounts = {};
  for (const severity of ALLOWED_SEVERITIES) severityCounts[severity] = 0;
  for (const classification of ALLOWED_CLASSIFICATIONS) classificationCounts[classification] = 0;
  for (const finding of findings) {
    severityCounts[finding.severity] += 1;
    classificationCounts[finding.classification] += 1;
  }
  return { severityCounts, classificationCounts };
}

export function simulateAuditExecution(input) {
  const { severityCounts, classificationCounts } = summarizeFindings(input.findings);
  const topSeverity = Object.entries(severityCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "low";
  const mostCommonClassification = Object.entries(classificationCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "geometry";

  const recommendations = [];
  if (severityCounts.critical > 0) recommendations.push("Escalate critical findings for design review before downstream coordination.");
  if (classificationCounts.coordination > 0) recommendations.push("Run a focused clash-resolution pass on coordination findings.");
  if (classificationCounts.metadata > 0) recommendations.push("Normalize metadata fields before issuing the next model revision.");
  if (recommendations.length === 0) recommendations.push("No blocking pattern detected; continue with routine QA review.");

  return {
    operation: input.operation,
    project_id: input.asset.project_id,
    model_uri: input.asset.model_uri,
    discipline: input.asset.discipline,
    revision: input.asset.revision,
    summary: `Processed ${input.findings.length} finding(s); dominant severity=${topSeverity}; dominant classification=${mostCommonClassification}.`,
    totals: {
      findings: input.findings.length,
      severity: severityCounts,
      classification: classificationCounts,
    },
    highlighted_findings: input.findings
      .filter((finding) => finding.severity === "critical" || finding.severity === "high")
      .slice(0, 5)
      .map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        classification: finding.classification,
        description: finding.description,
      })),
    recommendations,
    execution_trace: {
      mode: "local-simulation",
      side_effects: "none",
      simulated_at: utcNow(),
    },
  };
}

export function createSimulatedReceipt({
  requestId,
  input,
  policyResult,
  result,
  manifestDigest,
  receiptSecret = DEFAULT_RECEIPT_SECRET,
  capabilityId = DEFAULT_CAPABILITY_ID,
  listingId = DEFAULT_LISTING_ID,
}) {
  const issuedAt = utcNow();
  const receiptPayload = {
    receipt_id: `rcpt_${randomUUID()}`,
    schema: "agoragentic.receipt.simulated.v1",
    simulated: true,
    issued_at: issuedAt,
    request_id: requestId,
    capability_id: capabilityId,
    listing_id: listingId,
    policy_id: input.policy.policy_id,
    manifest_digest: manifestDigest,
    input_digest: sha256({
      operation: input.operation,
      asset: input.asset,
      findings: input.findings,
      metadata: input.metadata,
    }),
    output_digest: sha256(result),
    policy_digest: sha256(policyResult),
    usage: {
      findings_processed: input.findings.length,
      evidence_tagged_findings: input.findings.filter((finding) => finding.tags.length > 0).length,
      high_or_critical_findings: input.findings.filter((finding) => finding.severity === "high" || finding.severity === "critical").length,
    },
  };

  return {
    ...receiptPayload,
    receipt_signature: `sim:${createHash("sha256")
      .update(`${receiptSecret}:${stableStringify(receiptPayload)}`)
      .digest("hex")}`,
  };
}

export class AuditBimI3fLocalAdapter {
  constructor(options = {}) {
    this.toolName = options.toolName || DEFAULT_TOOL_NAME;
    this.serverName = options.serverName || DEFAULT_SERVER_NAME;
    this.capabilityId = options.capabilityId || DEFAULT_CAPABILITY_ID;
    this.listingId = options.listingId || DEFAULT_LISTING_ID;
    this.receiptSecret = options.receiptSecret || DEFAULT_RECEIPT_SECRET;
    this.defaultPolicy = createDefaultPolicy(options.defaultPolicy || {});
    this.manifestCache = createSampleMcpManifest({
      toolName: this.toolName,
      serverName: this.serverName,
      capabilityId: this.capabilityId,
      listingId: this.listingId,
    });
  }

  manifest() {
    return clone(this.manifestCache);
  }

  execute(input = {}) {
    const normalized = validateExecuteInput({
      ...clone(input),
      policy: input.policy ? clone(input.policy) : clone(this.defaultPolicy),
    });
    const policyResult = evaluatePolicy(normalized);
    if (!policyResult.allowed) {
      const error = new Error("policy validation failed");
      error.name = "PolicyValidationError";
      error.policy_result = policyResult;
      error.request_id = normalized.request_id;
      throw error;
    }

    const result = simulateAuditExecution(normalized);
    const receipt = createSimulatedReceipt({
      requestId: normalized.request_id,
      input: normalized,
      policyResult,
      result,
      manifestDigest: this.manifestCache.digests.manifest_digest,
      receiptSecret: this.receiptSecret,
      capabilityId: this.capabilityId,
      listingId: this.listingId,
    });

    return {
      ok: true,
      request_id: normalized.request_id,
      policy_result: policyResult,
      result,
      receipt,
      manifest_digest: this.manifestCache.digests.manifest_digest,
    };
  }

  handleToolCall(name, args = {}) {
    if (name !== this.toolName) {
      throw new Error(`unknown tool: ${name}`);
    }
    return this.execute(args);
  }
}

export function execute(input = {}, options = {}) {
  const adapter = options.adapter || new AuditBimI3fLocalAdapter(options);
  return adapter.execute(input);
}

export function handleMcpJsonRpc(request, options = {}) {
  const adapter = options.adapter || new AuditBimI3fLocalAdapter(options);
  const manifest = adapter.manifest();
  const tool = manifest.mcp.tools[0];

  if (request?.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-03-26",
        serverInfo: {
          name: manifest.mcp.server.name,
          version: manifest.mcp.server.version,
        },
        capabilities: {
          tools: {},
        },
      },
    };
  }

  if (request?.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [tool],
      },
    };
  }

  if (request?.method === "tools/call") {
    try {
      const payload = adapter.handleToolCall(request.params?.name, request.params?.arguments || {});
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
          structuredContent: payload,
        },
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32000,
          message: error.message,
          data: {
            name: error.name,
            request_id: error.request_id || null,
            policy_result: error.policy_result || null,
          },
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id: request?.id ?? null,
    error: {
      code: -32601,
      message: `unsupported method: ${request?.method || "unknown"}`,
    },
  };
}

export function buildDemoInput(overrides = {}) {
  return {
    operation: "check_clashes",
    asset: {
      project_id: "hospital-wing-a",
      model_uri: "file:///tmp/hospital-wing-a.ifc",
      discipline: "structural",
      revision: "r7",
    },
    findings: [
      {
        id: "F-101",
        severity: "critical",
        classification: "coordination",
        description: "Beam intersects fire stair head clearance envelope.",
        tags: ["view:3d", "sheet:A401", "zone:north-core"],
      },
      {
        id: "F-102",
        severity: "medium",
        classification: "metadata",
        description: "Door hardware set missing on two rated openings.",
        tags: ["schedule:doors", "discipline:architecture"],
      },
      {
        id: "F-103",
        severity: "high",
        classification: "geometry",
        description: "Pipe penetration clearance below required tolerance.",
        tags: ["view:mech-02", "zone:ward-3"],
      },
    ],
    policy: createDefaultPolicy(),
    metadata: {
      caller: "sample-mcp-manifest",
      workflow: "draft-local-audit",
    },
    ...clone(overrides),
  };
}

export function runSelfTest() {
  const adapter = new AuditBimI3fLocalAdapter();
  const manifest = adapter.manifest();
  assert.equal(manifest.schema, "agoragentic.seller-listing.mcp.v1");
  assert.equal(manifest.mcp.tools[0].name, DEFAULT_TOOL_NAME);
  assert.equal(typeof manifest.digests.manifest_digest, "string");

  const success = adapter.execute(buildDemoInput());
  assert.equal(success.ok, true);
  assert.equal(success.policy_result.allowed, true);
  assert.equal(success.receipt.simulated, true);
  assert.equal(success.receipt.usage.findings_processed, 3);
  assert.match(success.receipt.receipt_signature, /^sim:[0-9a-f]{64}$/);
  assert.equal(success.manifest_digest, manifest.digests.manifest_digest);

  const customAdapter = new AuditBimI3fLocalAdapter({
    serverName: "audit-bim-i3f-custom",
    capabilityId: "agoragentic.audit_bim_i3f.custom.v1",
    listingId: "audit-bim-i3f.custom.v1",
  });
  const customManifest = customAdapter.manifest();
  const defaultManifest = createSampleMcpManifest();
  assert.notEqual(customManifest.digests.manifest_digest, defaultManifest.digests.manifest_digest);
  const customSuccess = customAdapter.execute(buildDemoInput({ request_id: "req-custom-ids" }));
  assert.equal(customSuccess.receipt.capability_id, "agoragentic.audit_bim_i3f.custom.v1");
  assert.equal(customSuccess.receipt.listing_id, "audit-bim-i3f.custom.v1");
  assert.equal(customSuccess.manifest_digest, customManifest.digests.manifest_digest);

  assert.throws(
    () => {
      adapter.execute(buildDemoInput({
        findings: [
          {
            id: "F-201",
            severity: "high",
            classification: "metadata",
            description: "Asset lacks evidence tags and should fail policy.",
            tags: [],
          },
        ],
      }));
    },
    (error) => error?.name === "PolicyValidationError" && error?.policy_result?.checks?.some((check) => check.name === "evidence_tags_present" && check.status === "fail"),
  );

  assert.throws(
    () => {
      adapter.execute(buildDemoInput({
        policy: {
          ...createDefaultPolicy(),
          require_evidence_tags: 0,
        },
      }));
    },
    /policy\.require_evidence_tags must be true/,
  );

  const rpcList = handleMcpJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { adapter });
  assert.equal(rpcList.result.tools[0].name, DEFAULT_TOOL_NAME);

  const rpcCall = handleMcpJsonRpc(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: DEFAULT_TOOL_NAME,
        arguments: buildDemoInput({ request_id: "req-self-test" }),
      },
    },
    { adapter },
  );
  assert.equal(rpcCall.result.structuredContent.request_id, "req-self-test");
  return {
    ok: true,
    manifest_digest: manifest.digests.manifest_digest,
    tool_name: DEFAULT_TOOL_NAME,
  };
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes("--self-test")) {
    printJson(runSelfTest());
    return;
  }

  if (argv.includes("--manifest")) {
    printJson(createSampleMcpManifest());
    return;
  }

  if (argv.includes("--demo")) {
    printJson(execute(buildDemoInput()));
    return;
  }

  printJson({
    usage: ["--self-test", "--manifest", "--demo"],
    default_policy: createDefaultPolicy(),
    sample_request: buildDemoInput(),
  });
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
