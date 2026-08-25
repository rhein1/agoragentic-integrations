import {
  ADAPTER_CONFORMANCE_WORKER_PROTOCOL,
  RESULT_ACK_MESSAGE,
  VALIDATE_INTEGRATION_MESSAGE,
  VALIDATION_RESULT_MESSAGE,
} from "../../scripts/adapter-conformance-protocol.mjs";

let requestId = null;
let awaitingAck = false;

process.on("message", (message) => {
  if (awaitingAck) {
    if (
      message?.type !== RESULT_ACK_MESSAGE
      || message.protocol !== ADAPTER_CONFORMANCE_WORKER_PROTOCOL
      || message.request_id !== requestId
    ) {
      process.exit(25);
    }
    process.disconnect();
    return;
  }

  if (
    message?.type !== VALIDATE_INTEGRATION_MESSAGE
    || message.protocol !== ADAPTER_CONFORMANCE_WORKER_PROTOCOL
    || typeof message.request_id !== "string"
    || message.request_id.length === 0
  ) {
    process.exit(24);
  }

  requestId = message.request_id;
  const { integration } = message;
  const result = {
    id: integration.id,
    name: integration.name,
    language: integration.language,
    declared_status: integration.status,
    primary_path: integration.path,
    docs_path: integration.docs,
    result: "pass",
    checks: [],
    summary: { failed: 0, warnings: 0, passed: 1, not_applicable: 0 },
    evidence_boundary: {
      adapter_code_executed: false,
      network_calls_performed: false,
      paid_calls_performed: false,
      wallet_actions_performed: false,
      production_mutation_performed: false,
      proof_level: "fixture",
    },
    duration_ms: 0,
  };

  awaitingAck = true;
  process.send({
    type: VALIDATION_RESULT_MESSAGE,
    protocol: ADAPTER_CONFORMANCE_WORKER_PROTOCOL,
    request_id: requestId,
    ok: true,
    result,
  });
});

process.on("disconnect", () => {
  process.exitCode = awaitingAck ? 0 : 26;
});
