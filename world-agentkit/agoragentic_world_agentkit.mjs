const DEFAULT_BASE_URL = "https://agoragentic.com";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export class AgoragenticWorldAgentkitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgoragenticWorldAgentkitError";
    this.code = code;
  }
}

function validateBaseUrl(value, allowInsecureLoopback) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AgoragenticWorldAgentkitError("invalid_base_url", "baseUrl must be an absolute URL.");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new AgoragenticWorldAgentkitError(
      "invalid_base_url",
      "baseUrl cannot contain credentials, path, query, or fragment.",
    );
  }
  if (url.protocol === "https:" && url.hostname === "agoragentic.com" && !url.port) {
    return DEFAULT_BASE_URL;
  }
  if (allowInsecureLoopback && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
    return url.origin;
  }
  throw new AgoragenticWorldAgentkitError(
    "invalid_base_url",
    "baseUrl must be https://agoragentic.com; HTTP loopback is allowed only for explicit tests.",
  );
}

function targetUrl(baseUrl, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new AgoragenticWorldAgentkitError("invalid_path", "path must be an origin-relative path.");
  }
  const target = new URL(path, `${baseUrl}/`);
  if (target.origin !== baseUrl) {
    throw new AgoragenticWorldAgentkitError("cross_origin_request_blocked", "AgentKit calls must stay on the configured origin.");
  }
  return target.href;
}

async function officialFactory() {
  const module = await import("@worldcoin/agentkit");
  return module.createAgentkitClient;
}

/**
 * Wrap plain fetch with World AgentKit's pre-payment retry for Agoragentic.
 *
 * The returned client does not perform x402 payment. If human-backed access is
 * unavailable, the original 402 remains available to the caller for a separate
 * owner-authorized payment decision.
 */
export async function createAgoragenticWorldAgentkitClient({
  signer,
  fetchImpl = globalThis.fetch,
  createAgentkitClientImpl,
  baseUrl = DEFAULT_BASE_URL,
  allowInsecureLoopback = false,
  allowMutation = false,
  onEvent,
} = {}) {
  if (!signer) {
    throw new AgoragenticWorldAgentkitError("missing_signer", "A World AgentKit signer is required.");
  }
  if (typeof fetchImpl !== "function") {
    throw new AgoragenticWorldAgentkitError("missing_fetch", "A fetch implementation is required.");
  }
  const origin = validateBaseUrl(baseUrl, allowInsecureLoopback);
  const factory = createAgentkitClientImpl || (await officialFactory());
  if (typeof factory !== "function") {
    throw new AgoragenticWorldAgentkitError("missing_agentkit_factory", "createAgentkitClient is unavailable.");
  }
  const agentkit = factory({ signer, fetch: fetchImpl, onEvent });
  if (!agentkit || typeof agentkit.fetch !== "function") {
    throw new AgoragenticWorldAgentkitError("invalid_agentkit_client", "World AgentKit returned an invalid client.");
  }

  return Object.freeze({
    async fetch(path, init = undefined) {
      const method = String(init?.method || "GET").toUpperCase();
      if (!allowMutation && !["GET", "HEAD"].includes(method)) {
        throw new AgoragenticWorldAgentkitError(
          "mutation_not_authorized",
          "The AgentKit wrapper is read-only unless allowMutation is explicitly enabled.",
        );
      }
      return agentkit.fetch(targetUrl(origin, path), init);
    },
  });
}
