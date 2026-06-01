type JsonObject = Record<string, unknown>;

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
};

interface RustHealthResponse {
  framework?: string;
  framework_version?: string;
  agent_id?: string;
  runtime?: {
    transport?: string;
    harness_compatible?: boolean;
  };
}

interface RustToolsResponse {
  tools?: unknown[];
}

interface RustAgentCardResponse {
  name?: string;
  version?: string;
  supportedInterfaces?: unknown[];
  skills?: unknown[];
  extensions?: {
    'agoragentic:rust_framework'?: {
      local_only?: boolean;
    };
  };
}

interface RustOpenApiResponse {
  paths?: Record<string, unknown>;
}

interface RustInvocationRequest {
  request_id?: string;
  agent_id?: string;
  task?: string;
  input?: JsonObject;
  trace?: JsonObject;
  limits?: JsonObject;
  [key: string]: unknown;
}

interface RustInvocationResponse {
  request_id?: string;
  status?: string;
  trace?: {
    trace_id?: string;
  };
}

const baseUrl = normalizeBaseUrl(
  process.env.AGORAGENTIC_RUST_AGENT_URL || 'http://127.0.0.1:8080'
);

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(trimmed)) {
    throw new Error('AGORAGENTIC_RUST_AGENT_URL must be an http(s) URL');
  }
  return trimmed;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      connection: 'close',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${path} failed with HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json as T;
}

async function postJson<T>(path: string, body: JsonObject): Promise<T> {
  return requestJson<T>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function main(): Promise<void> {
  const health = await requestJson<RustHealthResponse>('/health');
  const agentCard = await requestJson<RustAgentCardResponse>('/.well-known/agent-card.json');
  const tools = await requestJson<RustToolsResponse>('/tools');
  const openapi = await requestJson<RustOpenApiResponse>('/openapi.json');

  const typedRequest: RustInvocationRequest = {
    request_id: 'req_public_ts_example',
    agent_id: health.agent_id || 'rust-agent',
    task: 'summarize',
    input: {
      text: 'Rust agents expose HTTP/JSON contracts for TypeScript and Python callers.',
    },
    trace: {
      trace_id: 'trace_public_ts_example',
    },
    limits: {
      timeout_ms: 30000,
      max_cost_usdc: 0,
    },
  };

  const typedInvoke = await postJson<RustInvocationResponse>('/invoke', typedRequest);
  const rawInvoke = await postJson<RustInvocationResponse>('/invoke', {
    text: 'Raw JSON payloads remain compatible with simple marketplace-style callers.',
  });

  console.log(
    JSON.stringify(
      {
        runtime: {
          framework: health.framework,
          framework_version: health.framework_version,
          transport: health.runtime?.transport,
          harness_compatible: health.runtime?.harness_compatible === true,
        },
        tools_count: Array.isArray(tools.tools) ? tools.tools.length : 0,
        agent_card: {
          name: agentCard.name,
          version: agentCard.version,
          supported_interface_count: Array.isArray(agentCard.supportedInterfaces)
            ? agentCard.supportedInterfaces.length
            : 0,
          skill_count: Array.isArray(agentCard.skills) ? agentCard.skills.length : 0,
          local_only: agentCard.extensions?.['agoragentic:rust_framework']?.local_only === true,
        },
        openapi_paths: Object.keys(openapi.paths || {}).sort(),
        typed_invoke: {
          status: typedInvoke.status,
          request_id: typedInvoke.request_id,
          trace_id: typedInvoke.trace?.trace_id,
        },
        raw_invoke: {
          status: rawInvoke.status,
          request_id: rawInvoke.request_id,
        },
        authority_boundary: {
          hosted_router_execute_changed: false,
          direct_invoke_changed: false,
          wallet_spend_enabled: false,
          x402_settlement_enabled: false,
          marketplace_publication_enabled: false,
          trust_mutation_enabled: false,
          native_bindings_required: false,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
