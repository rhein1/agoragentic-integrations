/**
 * OpenAI Agents SDK TypeScript Integration for Agoragentic.
 * 
 * Provides TypeScript tool parity for the OpenAI Agents SDK, enabling agents to run
 * quotes, search/match capability providers, execute tasks, poll status, and extract receipts.
 * Includes a robust dry-run mode that executes locally without requiring live keys.
 */

declare const process: { env: Record<string, string | undefined> };
const AGORAGENTIC_BASE_URL = process.env.AGORAGENTIC_BASE_URL || 'https://agoragentic.com';

export interface AgoragenticToolOptions {
  apiKey?: string;
  dryRun?: boolean;
}

function getHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Creates the OpenAI Agents SDK-compatible tool wrapper.
 */
export function getAgoragenticTools(options: AgoragenticToolOptions = {}) {
  const apiKey = options.apiKey || process.env.AGORAGENTIC_API_KEY || '';
  const dryRun = options.dryRun ?? !apiKey;

  if (dryRun) {
    console.log('[OpenAI Agents TS] Running in offline dry-run mode.');
  }

  const agoragentic_quote = async (task: string, constraints: string = '{}'): Promise<string> => {
    /**
     * Create a durable quote before paid execution.
     * @param task The task description to quote.
     * @param constraints JSON string of execution constraints.
     */
    if (dryRun) {
      return JSON.stringify({
        quote_id: 'q_openai_mock_123',
        cost_usdc: 0.05,
        expires_at: Math.floor(Date.now() / 1000) + 600,
        provider_name: 'Mock OpenAI Agents TS Provider',
        dry_run: true
      }, null, 2);
    }

    try {
      const resp = await fetch(`${AGORAGENTIC_BASE_URL}/api/execute/quote`, {
        method: 'POST',
        headers: getHeaders(apiKey),
        body: JSON.stringify({ task, constraints: JSON.parse(constraints) }),
      });
      const data = await resp.json();
      return JSON.stringify(data, null, 2);
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  };

  const agoragentic_match = async (task: string, constraints: string = '{}'): Promise<string> => {
    /**
     * Preview routed providers matching the task before execution.
     * @param task The task query to match.
     * @param constraints JSON string of constraints (e.g. max_cost, min_trust).
     */
    if (dryRun) {
      return JSON.stringify([
        {
          provider_id: 'prov_openai_mock_456',
          name: 'Mock OpenAI Agents TS Provider',
          cost_usdc: 0.05,
          trust_score: 0.98,
          rating: 'verified'
        }
      ], null, 2);
    }

    try {
      const parsedConstraints = JSON.parse(constraints);
      const params = new URLSearchParams({ task });
      if (parsedConstraints.max_cost_usdc) params.append('max_cost', String(parsedConstraints.max_cost_usdc));
      if (parsedConstraints.min_trust) params.append('min_trust', parsedConstraints.min_trust);

      const resp = await fetch(`${AGORAGENTIC_BASE_URL}/api/execute/match?${params.toString()}`, {
        method: 'GET',
        headers: getHeaders(apiKey),
      });
      const data = await resp.json();
      return JSON.stringify(data, null, 2);
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  };

  const agoragentic_execute = async (
    task: string,
    inputData: string = '{}',
    constraints: string = '{}'
  ): Promise<string> => {
    /**
     * Primary Agent OS execution path. Routes a task through execute() with fallback.
     * @param task The task query to execute.
     * @param inputData JSON string of parameters for the tool.
     * @param constraints JSON string of execution constraints.
     */
    if (dryRun) {
      return JSON.stringify({
        invocation_id: 'inv_openai_mock_789',
        status: 'completed',
        output: { result: `OpenAI Agents TS dry-run executed task: ${task}` },
        dry_run: true
      }, null, 2);
    }

    try {
      const payload = {
        task,
        input: JSON.parse(inputData),
        constraints: JSON.parse(constraints),
      };
      const resp = await fetch(`${AGORAGENTIC_BASE_URL}/api/execute`, {
        method: 'POST',
        headers: getHeaders(apiKey),
        body: JSON.stringify(payload),
      });
      const data = await resp.json();
      return JSON.stringify(data, null, 2);
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  };

  const agoragentic_status = async (invocationId: string): Promise<string> => {
    /**
     * Inspect execution status for an invocation.
     * @param invocationId The ID of the invocation to poll.
     */
    if (dryRun) {
      return JSON.stringify({
        invocation_id: invocationId,
        status: 'completed',
        progress: 100,
        dry_run: true
      }, null, 2);
    }

    try {
      const resp = await fetch(`${AGORAGENTIC_BASE_URL}/api/execute/status/${invocationId}`, {
        method: 'GET',
        headers: getHeaders(apiKey),
      });
      const data = await resp.json();
      return JSON.stringify(data, null, 2);
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  };

  const agoragentic_receipt = async (invocationId: string): Promise<string> => {
    /**
     * Fetch normalized receipt and settlement metadata.
     * @param invocationId The ID of the invocation to retrieve the receipt for.
     */
    if (dryRun) {
      return JSON.stringify({
        receipt_id: 'rec_openai_mock_991',
        invocation_id: invocationId,
        cost_usdc: 0.05,
        settled_at: Math.floor(Date.now() / 1000),
        status: 'settled',
        dry_run: true
      }, null, 2);
    }

    try {
      const resp = await fetch(`${AGORAGENTIC_BASE_URL}/api/execute/receipt/${invocationId}`, {
        method: 'GET',
        headers: getHeaders(apiKey),
      });
      const data = await resp.json();
      return JSON.stringify(data, null, 2);
    } catch (error: any) {
      return JSON.stringify({ error: error.message });
    }
  };

  return {
    agoragentic_quote,
    agoragentic_match,
    agoragentic_execute,
    agoragentic_status,
    agoragentic_receipt,
  };
}
export default getAgoragenticTools;
export const version = '2.21.0';
