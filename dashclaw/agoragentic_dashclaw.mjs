import { DashClaw } from "dashclaw";
import agoragentic from "agoragentic";

export function createDashClawAgoragenticBridge({
  dashclawBaseUrl,
  dashclawApiKey,
  agoragenticApiKey,
  agentId = "agoragentic-buyer"
} = {}) {
  if (!dashclawBaseUrl) throw new Error("DASHCLAW_BASE_URL is required");
  if (!dashclawApiKey) throw new Error("DASHCLAW_API_KEY is required");
  if (!agoragenticApiKey) throw new Error("AGORAGENTIC_API_KEY is required");

  const claw = new DashClaw({
    baseUrl: dashclawBaseUrl,
    apiKey: dashclawApiKey,
    agentId
  });
  const agora = agoragentic(agoragenticApiKey);

  async function executeGovernedSpend({
    task,
    input = {},
    listingId,
    maxCostUsdc = 0.1,
    riskScore = 50,
    execute = false
  } = {}) {
    if (!task) throw new Error("task is required");

    const guard = await claw.guard({
      action_type: "external_capability_purchase",
      risk_score: riskScore,
      declared_goal: `Buy external capability for task: ${task}`
    });

    if (guard?.decision === "block") {
      throw new Error(`DashClaw blocked spend: ${guard.reason || "policy_denied"}`);
    }

    const action = await claw.createAction({
      action_type: "external_capability_purchase",
      declared_goal: `Execute ${task} through Agoragentic`,
      risk_score: riskScore
    });

    const account = await agora.account();
    const procurement = listingId
      ? await agora.procurementCheck(listingId, { quotedCostUsdc: maxCostUsdc })
      : await agora.procurement();

    const procurementDecision = procurement.procurement_check?.decision || null;
    if (procurementDecision?.allowed === false) {
      await claw.updateOutcome(action.action_id, {
        status: "blocked",
        error_message: procurementDecision.status || "agoragentic_procurement_blocked"
      });
      throw new Error(`Agent OS blocked spend: ${procurementDecision.status}`);
    }

    if (!execute) {
      await claw.recordAssumption({
        action_id: action.action_id,
        assumption: "Agoragentic execution skipped because execute=false"
      });
      await claw.updateOutcome(action.action_id, { status: "completed" });
      return {
        mode: "preflight_only",
        dashclaw_action_id: action.action_id,
        dashclaw_guard: guard,
        account,
        procurement
      };
    }

    const result = await agora.execute(task, input, { max_cost: maxCostUsdc });
    const receiptId = result.receipt_id || result.invocation_id;
    const receipt = receiptId ? await agora.receipt(receiptId) : null;

    await claw.recordAssumption({
      action_id: action.action_id,
      assumption: `Agoragentic invocation ${result.invocation_id} completed with receipt ${receiptId}`
    });
    await claw.updateOutcome(action.action_id, { status: "completed" });

    return {
      mode: "executed",
      dashclaw_action_id: action.action_id,
      dashclaw_guard: guard,
      result,
      receipt
    };
  }

  return { claw, agora, executeGovernedSpend };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bridge = createDashClawAgoragenticBridge({
    dashclawBaseUrl: process.env.DASHCLAW_BASE_URL,
    dashclawApiKey: process.env.DASHCLAW_API_KEY,
    agoragenticApiKey: process.env.AGORAGENTIC_API_KEY,
    agentId: process.env.DASHCLAW_AGENT_ID || "agoragentic-buyer"
  });

  const output = await bridge.executeGovernedSpend({
    task: process.env.AGORAGENTIC_TASK || "summarize",
    input: { text: process.env.AGORAGENTIC_INPUT || "Agent OS controls commerce spend." },
    listingId: process.env.AGORAGENTIC_CAPABILITY_ID,
    maxCostUsdc: Number(process.env.AGORAGENTIC_MAX_COST_USDC || "0.1"),
    riskScore: Number(process.env.DASHCLAW_RISK_SCORE || "50"),
    execute: process.env.AGORAGENTIC_EXECUTE === "true"
  });

  console.log(JSON.stringify(output, null, 2));
}
