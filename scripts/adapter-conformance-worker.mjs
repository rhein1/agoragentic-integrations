import { validateIntegration } from "./adapter-conformance-lib.mjs";
import {
  ADAPTER_CONFORMANCE_WORKER_PROTOCOL,
  isWorkerRequestId,
  RESULT_ACK_MESSAGE,
  VALIDATE_INTEGRATION_MESSAGE,
  VALIDATION_RESULT_MESSAGE,
} from "./adapter-conformance-protocol.mjs";

let state = "awaiting_request";
let requestId = null;
let resultExitCode = 1;

function failClosed() {
  state = "failed";
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}

function sendResult(payload, exitCode) {
  if (typeof process.send !== "function") {
    failClosed();
    return;
  }
  resultExitCode = exitCode;
  state = "awaiting_ack";
  process.send({
    type: VALIDATION_RESULT_MESSAGE,
    protocol: ADAPTER_CONFORMANCE_WORKER_PROTOCOL,
    request_id: requestId,
    ...payload,
  }, (error) => {
    if (error) failClosed();
  });
}

process.on("message", async (message) => {
  if (state === "awaiting_ack") {
    if (
      message?.type !== RESULT_ACK_MESSAGE
      || message.protocol !== ADAPTER_CONFORMANCE_WORKER_PROTOCOL
      || message.request_id !== requestId
    ) {
      failClosed();
      return;
    }
    state = "acknowledged";
    process.exitCode = resultExitCode;
    process.disconnect();
    return;
  }

  if (
    state !== "awaiting_request"
    || message?.type !== VALIDATE_INTEGRATION_MESSAGE
    || message.protocol !== ADAPTER_CONFORMANCE_WORKER_PROTOCOL
    || !isWorkerRequestId(message.request_id)
  ) {
    failClosed();
    return;
  }

  state = "running";
  requestId = message.request_id;
  try {
    if (!message || typeof message !== "object" || !message.integration || !message.root) {
      throw new Error("invalid_worker_payload");
    }
    const result = await validateIntegration(message.root, message.integration, {
      pythonCommand: message.pythonCommand,
    });
    sendResult({ ok: true, result }, 0);
  } catch (error) {
    sendResult({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      integration_id: message?.integration?.id || "unknown",
    }, 1);
  }
});

process.on("disconnect", () => {
  if (state !== "acknowledged") process.exitCode = 1;
});
