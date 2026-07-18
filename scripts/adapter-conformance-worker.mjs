import { validateIntegration } from "./adapter-conformance-lib.mjs";

let handled = false;

function send(payload, exitCode = 0) {
  if (typeof process.send !== "function") {
    process.exitCode = 1;
    return;
  }
  process.send(payload, () => {
    process.exitCode = exitCode;
    process.disconnect();
  });
}

process.once("message", async (message) => {
  if (handled) return;
  handled = true;
  try {
    if (!message || typeof message !== "object" || !message.integration || !message.root) {
      throw new Error("invalid_worker_payload");
    }
    const result = await validateIntegration(message.root, message.integration, {
      pythonCommand: message.pythonCommand,
    });
    send({ ok: true, result });
  } catch (error) {
    send({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      integration_id: message?.integration?.id || "unknown",
    }, 1);
  }
});

process.on("disconnect", () => {
  if (!handled) process.exit(1);
});
