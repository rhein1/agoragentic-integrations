import { setTimeout as pause } from 'node:timers/promises';

// pg.Pool.end() can resolve before its idle clients' socket-close callbacks.
// Observe server-side absence before dropping only this fixture's child DB;
// never terminate a still-closing client or conceal a failed cleanup.
export async function waitForDisposableDatabaseDrain(root, database) {
  if (typeof database !== 'string'
    || !/^risk_fork_(?:control|worker)_role_[a-f0-9]{18}$/.test(database)) {
    throw new Error('Only an exact disposable role-test child database may be drained');
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await root.query(
      'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=$1',
      [database],
    );
    const count = result.rows?.[0]?.count;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('Disposable database drain returned invalid session evidence');
    }
    if (count === 0) return;
    if (attempt < 99) await pause(25);
  }
  throw new Error('Disposable database sessions did not drain within the bounded wait');
}
