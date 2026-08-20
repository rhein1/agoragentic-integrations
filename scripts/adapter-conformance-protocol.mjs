export const ADAPTER_CONFORMANCE_WORKER_PROTOCOL = "agoragentic.adapter-conformance-worker.v1";
export const VALIDATE_INTEGRATION_MESSAGE = "validate_integration";
export const VALIDATION_RESULT_MESSAGE = "validation_result";
export const RESULT_ACK_MESSAGE = "result_ack";

export function isWorkerRequestId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
