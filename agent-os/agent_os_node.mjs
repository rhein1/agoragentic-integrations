/**
 * Agoragentic Agent OS control-plane example.
 *
 * Public boundary:
 * - Uses only public API endpoints.
 * - Approval and reconciliation calls are free control-plane calls.
 * - Paid settlement happens only when AGORAGENTIC_EXECUTE=true and /api/execute succeeds.
 */

const BASE_URL = process.env.AGORAGENTIC_BASE_URL || "https://agoragentic.com";
const BUYER_KEY = process.env.AGORAGENTIC_API_KEY || "";
const SUPERVISOR_KEY = process.env.AGORAGENTIC_SUPERVISOR_API_KEY || "";
const CAPABILITY_ID = process.env.AGORAGENTIC_CAPABILITY_ID || "";
const EXECUTE = process.env.AGORAGENTIC_EXECUTE === "true";
const AUTO_APPROVE = process.env.AGORAGENTIC_AUTO_APPROVE === "true";
const DEFAULT_INPUT = { text: "Summarize this Agent OS control-plane request." };

function requireValue(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function parseInput() {
  const raw = process.env.AGORAGENTIC_INPUT_JSON;
  if (!raw) return DEFAULT_INPUT;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`AGORAGENTIC_INPUT_JSON must be valid JSON: ${err.message}`);
  }
}

async function api(method, path, apiKey, body) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  return { status: response.status, ok: response.ok, data };
}

async function createQuote(capabilityId, input, apiKey) {
  const result = await api("POST", "/api/commerce/quotes", apiKey, {
    capability_id: capabilityId,
    units: 1,
    input,
  });
  if (!result.ok) throw new Error(`Quote failed: ${JSON.stringify(result.data)}`);
  return result.data.quote;
}

async function procurementCheck(quote, input, apiKey) {
  const result = await api("POST", "/api/commerce/procurement/check", apiKey, {
    capability_id: quote.capability.id,
    quoted_cost_usdc: quote.quoted_price_usdc,
    input,
  });
  if (!result.ok) throw new Error(`Procurement check failed: ${JSON.stringify(result.data)}`);
  return result;
}

async function executeWithQuote(quote, input, apiKey) {
  return api("POST", "/api/execute", apiKey, {
    quote_id: quote.quote_id,
    task: quote.capability.category || quote.capability.name || quote.capability.id,
    input,
  });
}

async function buyerFlow() {
  const apiKey = requireValue(BUYER_KEY, "AGORAGENTIC_API_KEY");
  const capabilityId = requireValue(CAPABILITY_ID, "AGORAGENTIC_CAPABILITY_ID");
  const input = parseInput();

  const quote = await createQuote(capabilityId, input, apiKey);
  console.log("quote", {
    quote_id: quote.quote_id,
    execution_ready: quote.execution_ready,
    price: quote.quoted_price_usdc,
  });

  const procurement = await procurementCheck(quote, input, apiKey);
  console.log("procurement", procurement.data.procurement_check?.decision || procurement.data);

  if (!EXECUTE) {
    console.log("execution_skipped", {
      reason: "AGORAGENTIC_EXECUTE is not true",
      quote_id: quote.quote_id,
      next_step: "Set AGORAGENTIC_EXECUTE=true to run paid execution.",
    });
    return;
  }

  const execution = await executeWithQuote(quote, input, apiKey);
  if (execution.status === 202 || execution.data.error === "pending_approval") {
    console.log("approval_required", {
      approval_id: execution.data.approval?.approval_id || execution.data.approval?.id || null,
      approvals_url: execution.data.approvals_url || "GET /api/approvals?role=buyer",
      retry: "Retry this same quote_id and input after supervisor approval.",
    });
    return;
  }
  if (!execution.ok) throw new Error(`Execution failed: ${JSON.stringify(execution.data)}`);

  console.log("execution", {
    invocation_id: execution.data.invocation_id,
    status: execution.data.status,
    cost: execution.data.cost,
    receipt: execution.data.receipt_id || execution.data.receipt || null,
    approval: execution.data.approval || null,
  });
}

async function supervisorFlow() {
  const apiKey = requireValue(SUPERVISOR_KEY, "AGORAGENTIC_SUPERVISOR_API_KEY");
  const queue = await api("GET", "/api/approvals?role=supervisor&status=pending&limit=10", apiKey);
  if (!queue.ok) throw new Error(`Approval queue failed: ${JSON.stringify(queue.data)}`);

  const approvals = queue.data.supervisor_queue?.approvals || queue.data.approvals || [];
  console.log("pending_approvals", approvals.map((approval) => ({
    id: approval.id,
    buyer_id: approval.buyer_id,
    capability_id: approval.capability_id,
    cost_usdc: approval.cost_usdc,
    status: approval.status,
  })));

  if (!AUTO_APPROVE || approvals.length === 0) return;

  const approval = approvals[0];
  const resolved = await api("POST", `/api/approvals/${encodeURIComponent(approval.id)}/resolve`, apiKey, {
    decision: "approve",
    reason: "Approved by controlled Agent OS integration test.",
  });
  if (!resolved.ok) throw new Error(`Approval resolution failed: ${JSON.stringify(resolved.data)}`);
  console.log("resolved_approval", resolved.data.approval || resolved.data);
}

async function reconciliationFlow(jobId) {
  const apiKey = requireValue(BUYER_KEY, "AGORAGENTIC_API_KEY");
  const result = await api("GET", `/api/jobs/${encodeURIComponent(jobId)}/reconciliation`, apiKey);
  if (!result.ok) throw new Error(`Reconciliation failed: ${JSON.stringify(result.data)}`);
  console.log("job_reconciliation", result.data.reconciliation || result.data);
}

async function jobsFlow(jobId) {
  const apiKey = requireValue(BUYER_KEY, "AGORAGENTIC_API_KEY");

  const summary = await api("GET", "/api/jobs/summary", apiKey);
  if (!summary.ok) throw new Error(`Jobs summary failed: ${JSON.stringify(summary.data)}`);
  console.log("jobs_summary", summary.data.summary || summary.data);

  const list = await api("GET", "/api/jobs?status=active", apiKey);
  if (!list.ok) throw new Error(`Jobs list failed: ${JSON.stringify(list.data)}`);
  console.log("active_jobs", list.data.jobs || list.data);

  if (!jobId) return;

  const detail = await api("GET", `/api/jobs/${encodeURIComponent(jobId)}`, apiKey);
  if (!detail.ok) throw new Error(`Job detail failed: ${JSON.stringify(detail.data)}`);
  console.log("job_detail", detail.data.job || detail.data);

  const runs = await api("GET", `/api/jobs/${encodeURIComponent(jobId)}/runs?limit=5`, apiKey);
  if (!runs.ok) throw new Error(`Job runs failed: ${JSON.stringify(runs.data)}`);
  console.log("job_runs", runs.data.runs || runs.data);
}

const mode = process.argv[2] || "buyer";
if (mode === "buyer") {
  await buyerFlow();
} else if (mode === "supervisor") {
  await supervisorFlow();
} else if (mode === "reconciliation") {
  await reconciliationFlow(requireValue(process.argv[3], "job id argument"));
} else if (mode === "jobs") {
  await jobsFlow(process.argv[3] || "");
} else {
  throw new Error("Usage: node agent_os_node.mjs buyer|supervisor|jobs [job_id]|reconciliation <job_id>");
}
