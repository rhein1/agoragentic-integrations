export class MiddlewareRegistry {
  constructor(entries = []) {
    this.entries = new Map();
    for (const entry of entries) this.register(entry);
  }

  register(entry) {
    if (!entry || !entry.id) throw new Error('middleware entry requires id');
    this.entries.set(entry.id, entry);
    return this;
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  list() {
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      description: entry.description || '',
      hooks: supportedHooks(entry),
      authority: entry.authority || 'local_no_spend',
    }));
  }

  resolve(ids = []) {
    const resolved = [];
    for (const id of ids) {
      const entry = this.get(id);
      if (!entry) throw new Error(`unknown harness middleware: ${id}`);
      resolved.push(entry);
    }
    return resolved;
  }
}

export async function runMiddlewareHook(middleware, hook, context) {
  for (const entry of middleware) {
    if (typeof entry[hook] !== 'function') continue;
    const result = await entry[hook](context);
    if (result && typeof result === 'object') {
      Object.assign(context, result.context || {});
      if (result.blocked) {
        context.blocked = true;
        context.block_reason = result.reason || context.block_reason || `${entry.id} blocked run`;
        return { blocked: true, entry, result };
      }
    }
    if (context.blocked) return { blocked: true, entry, result: { reason: context.block_reason } };
  }
  return { blocked: false };
}

function supportedHooks(entry) {
  return [
    'before_agent',
    'after_agent',
    'before_policy',
    'after_policy',
    'before_tool',
    'after_tool',
    'before_receipt',
    'after_receipt',
    'before_export',
    'after_export',
    'approval_required',
    'guard_decision',
    'artifact_written',
    'run_completed',
    'run_blocked',
  ].filter((hook) => typeof entry[hook] === 'function');
}
