/**
 * Agoragentic Plugin for Paperclip — Worker Entrypoint
 *
 * This plugin integrates Agoragentic's capability router into Paperclip's
 * agent orchestration platform. When a Paperclip agent needs external AI
 * capabilities, it calls Agoragentic instead of implementing them locally.
 *
 * Integration seam: Paperclip Plugin SDK
 *   - Tools: agents call execute/match/invoke as tools
 *   - Jobs: background capability syncs
 *   - Events: react to issue.created for auto-routing
 *   - Cost: maps Agoragentic costs into Paperclip's cost tracking
 *   - Activity: logs all invocations as audit trail
 *
 * Trust is preserved as-is: 'verified', 'reachable', 'failed'
 * Router-first: execute() is default, invoke() only when approval-required
 */

const { AgoragenticClient, AgoragenticError, TRUST_LEVELS } = require('./client');

// ─── Plugin Definition (Paperclip SDK pattern) ─────────────────────

function createAgoragenticPlugin() {
  let client = null;
  let ctx = null;

  return {
    /**
     * Plugin setup — called by Paperclip host on worker start.
     */
    async setup(pluginCtx) {
      ctx = pluginCtx;

      // Read config from plugin settings
      const config = await ctx.config.get();
      const apiKey = config?.agoragentic_api_key
        || (await ctx.secrets?.get?.('AGORAGENTIC_API_KEY'))
        || process.env.AGORAGENTIC_API_KEY;

      if (!apiKey) {
        ctx.logger.warn('Agoragentic plugin: No API key configured. Set AGORAGENTIC_API_KEY in plugin config or secrets.');
        return;
      }

      client = new AgoragenticClient({
        apiKey,
        baseUrl: config?.agoragentic_base_url || process.env.AGORAGENTIC_BASE_URL || 'https://agoragentic.com',
        timeoutMs: config?.agoragentic_timeout_ms || 30000,
        maxRetries: config?.agoragentic_max_retries ?? 2,
      });

      ctx.logger.info('Agoragentic plugin initialized', {
        baseUrl: client.baseUrl,
        timeoutMs: client.timeoutMs,
      });

      // ── Register Tools ──
      registerTools(ctx);

      // ── Register Jobs ──
      registerJobs(ctx);

      // ── Register Data Handlers ──
      registerDataHandlers(ctx);

      // ── Register Event Listeners ──
      registerEventListeners(ctx);
    },

    async onHealth() {
      if (!client) {
        return { status: 'degraded', message: 'No API key configured' };
      }
      try {
        // Quick health probe — lightweight GET
        const res = await fetch(`${client.baseUrl}/api/health`, {
          headers: { 'User-Agent': 'paperclip-agoragentic-plugin/1.0' },
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json().catch(() => ({}));
        return {
          status: data.status === 'healthy' ? 'ok' : 'degraded',
          message: `Agoragentic: ${data.status || 'unreachable'}`,
        };
      } catch (err) {
        return { status: 'degraded', message: `Agoragentic unreachable: ${err.message}` };
      }
    },
  };

  // ─── Tool Registration ──────────────────────────────────

  /**
   * Tools are the primary integration surface.
   * Agents call these tools when they need external capabilities.
   */
  function registerTools(ctx) {
    // Tool 1: Execute (router-first — default path)
    ctx.tools?.register?.('agoragentic_execute', {
      description: 'Route a task to the best external AI provider via Agoragentic. Uses automatic capability discovery and trust-aware ranking.',
      parameters: {
        type: 'object',
        required: ['task', 'input'],
        properties: {
          task: { type: 'string', description: 'Task type: summarize, translate, code_review, generate, etc.' },
          input: { description: 'Task input — string or structured object' },
          max_cost: { type: 'number', description: 'Maximum cost in USDC (optional)' },
          category: { type: 'string', description: 'Preferred category filter (optional)' },
        },
      },
      execute: async (params, toolCtx) => {
        assertClient();
        const startTime = Date.now();
        try {
          const result = await client.executeCapability({
            task: params.task,
            input: params.input,
            constraints: {
              ...(params.max_cost != null && { max_cost: params.max_cost }),
              ...(params.category && { category: params.category }),
            },
          });

          // Record cost in Paperclip's cost system
          await recordCost(toolCtx, result, params.task, startTime);

          // Log activity
          await logInvocation(toolCtx, 'execute', params, result);

          return {
            output: result.output,
            provider: result.provider,
            cost: result.cost,
            execution_id: result.execution_id,
            trust_status: result.provider?.trust_status,
          };
        } catch (err) {
          await logInvocationError(toolCtx, 'execute', params, err);
          throw err;
        }
      },
    });

    // Tool 2: Match (approval-gated discovery path)
    ctx.tools?.register?.('agoragentic_match', {
      description: 'Discover candidate providers for a task without executing. Use when supervisor approval is needed before invoking.',
      parameters: {
        type: 'object',
        required: ['task'],
        properties: {
          task: { type: 'string', description: 'Task type to match' },
          max_cost: { type: 'number', description: 'Max cost filter (optional)' },
          category: { type: 'string', description: 'Category filter (optional)' },
        },
      },
      execute: async (params) => {
        assertClient();
        const result = await client.matchCapabilities({
          task: params.task,
          constraints: {
            ...(params.max_cost != null && { max_cost: params.max_cost }),
            ...(params.category && { category: params.category }),
          },
        });
        return {
          candidates: result.candidates.map(c => ({
            capability_id: c.capability_id,
            name: c.name,
            price: c.price,
            trust_status: c.trust_status,
            seller_name: c.seller_name,
            category: c.category,
          })),
        };
      },
    });

    // Tool 3: Invoke (direct commerce path — after approval)
    ctx.tools?.register?.('agoragentic_invoke', {
      description: 'Invoke a specific Agoragentic provider by ID. Use after agoragentic_match when a supervisor has approved the provider selection.',
      parameters: {
        type: 'object',
        required: ['capability_id', 'input'],
        properties: {
          capability_id: { type: 'string', description: 'ID of the capability to invoke' },
          input: { description: 'Input payload to send to the provider' },
          idempotency_key: { type: 'string', description: 'Idempotency key for safe retries (optional)' },
        },
      },
      execute: async (params, toolCtx) => {
        assertClient();
        const startTime = Date.now();
        try {
          const result = await client.invokeCapability({
            capabilityId: params.capability_id,
            input: params.input,
            idempotencyKey: params.idempotency_key,
          });

          await recordCost(toolCtx, result, 'invoke:' + params.capability_id, startTime);
          await logInvocation(toolCtx, 'invoke', params, result);

          return {
            output: result.output,
            invocation_id: result.invocation_id,
            provider: result.provider,
            cost: result.cost,
            trust_status: result.provider?.trust_status,
          };
        } catch (err) {
          await logInvocationError(toolCtx, 'invoke', params, err);
          throw err;
        }
      },
    });
  }

  // ─── Job Registration ───────────────────────────────────

  function registerJobs(ctx) {
    // Periodic capability sync — keeps plugin state fresh
    ctx.jobs?.register?.('agoragentic-sync', async (job) => {
      assertClient();
      ctx.logger.info('Agoragentic sync job starting');
      try {
        const health = await fetch(`${client.baseUrl}/api/health`, {
          headers: { 'User-Agent': 'paperclip-agoragentic-plugin/1.0' },
          signal: AbortSignal.timeout(10000),
        });
        const data = await health.json().catch(() => ({}));

        await ctx.state.set(
          { scopeKind: 'instance', stateKey: 'agoragentic-health' },
          {
            status: data.status,
            checked_at: new Date().toISOString(),
            capabilities_count: data.approved_capabilities || data.stats?.approved_capabilities,
          }
        );
        ctx.logger.info('Agoragentic sync complete', { status: data.status });
      } catch (err) {
        ctx.logger.error('Agoragentic sync failed', { error: err.message });
      }
    });
  }

  // ─── Data Handlers ──────────────────────────────────────

  function registerDataHandlers(ctx) {
    ctx.data?.register?.('agoragentic-status', async () => {
      const health = await ctx.state.get({
        scopeKind: 'instance',
        stateKey: 'agoragentic-health',
      });
      return {
        connected: !!client,
        baseUrl: client?.baseUrl,
        lastHealth: health,
      };
    });
  }

  // ─── Event Listeners ────────────────────────────────────

  function registerEventListeners(ctx) {
    // Listen for issues that could benefit from external capabilities
    ctx.events?.on?.('issue.created', async (event) => {
      // Store event for potential auto-routing (configurable)
      const config = await ctx.config.get();
      if (config?.auto_route_issues) {
        ctx.logger.info('Issue created — auto-routing enabled', {
          issueId: event.entityId,
        });
        // Auto-routing would go here in a future version
      }
    });
  }

  // ─── Helpers ────────────────────────────────────────────

  function assertClient() {
    if (!client) {
      throw new Error('Agoragentic plugin not configured. Set AGORAGENTIC_API_KEY in plugin settings or secrets.');
    }
  }

  /**
   * Record Agoragentic cost as a Paperclip cost event.
   * Maps USDC cost → Paperclip's cent-based cost system.
   */
  async function recordCost(toolCtx, result, taskType, startTime) {
    if (!result.cost || !ctx.http) return;

    const companyId = toolCtx?.companyId;
    const agentId = toolCtx?.agentId;
    if (!companyId) return;

    try {
      const costCents = Math.ceil(result.cost * 100); // USDC → cents
      await ctx.activity?.log?.({
        companyId,
        action: 'agoragentic.cost',
        entityType: 'agoragentic_invocation',
        entityId: result.execution_id || result.invocation_id || 'unknown',
        details: {
          costCents,
          costUsdc: result.cost,
          model: taskType,
          provider: result.provider?.name,
          trust_status: result.provider?.trust_status,
          latency_ms: Date.now() - startTime,
        },
      });
    } catch (err) {
      ctx.logger.warn('Failed to record Agoragentic cost', { error: err.message });
    }
  }

  async function logInvocation(toolCtx, method, params, result) {
    try {
      await ctx.activity?.log?.({
        companyId: toolCtx?.companyId,
        action: `agoragentic.${method}`,
        entityType: 'agoragentic_invocation',
        entityId: result.execution_id || result.invocation_id || 'unknown',
        details: {
          task: params.task || params.capability_id,
          provider_id: result.provider?.id,
          provider_name: result.provider?.name,
          trust_status: result.provider?.trust_status,
          cost: result.cost,
          status: result.status,
        },
      });
    } catch (err) {
      ctx.logger.warn('Failed to log Agoragentic invocation', { error: err.message });
    }
  }

  async function logInvocationError(toolCtx, method, params, error) {
    try {
      await ctx.activity?.log?.({
        companyId: toolCtx?.companyId,
        action: `agoragentic.${method}.error`,
        entityType: 'agoragentic_invocation',
        entityId: 'error',
        details: {
          task: params.task || params.capability_id,
          error: error.message,
          statusCode: error.statusCode,
          retryable: error.retryable,
        },
      });
    } catch { }
  }
}

module.exports = { createAgoragenticPlugin };
