import { readFile } from 'node:fs/promises';

export const policyManifest = JSON.parse(await readFile(new URL('../../src/postgres-request-policy-catalog.json', import.meta.url), 'utf8'));
const queries = [
  ['internal_triggers', 't.tgtype'], ['auxiliary_objects', 'SELECT kind,name FROM'],
  ['relations', 'c.relkind AS kind'], ['columns', 'a.attnum,'], ['constraints', 'con.connoinherit'],
  ['indexes', 'ix.indislive'], ['triggers', 'pg_get_triggerdef'], ['functions', 'pg_get_functiondef'],
  ['types', 't.typcategory'], ['policies', 'SELECT p.polname'], ['rewrites', 'SELECT r.rulename'], ['inheritance', 'pg_inherits'],
];
function render(value, schema) {
  if (typeof value === 'string') return value.replaceAll('__schema__', schema);
  if (Array.isArray(value)) return value.map((x) => render(x, schema));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, render(v, schema)]));
  return value;
}
export function policyCatalogQuery(sql, values = [], catalog = policyManifest.catalog) {
  const key = queries.find(([, marker]) => sql.includes(marker))?.[0];
  if (key) {
    const rows = render(catalog[key], values[0]);
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith('SELECT version,migration_hash')) return { rowCount: 1,
    rows: [{ version: 1, migration_hash: policyManifest.migration_hash }] };
  return undefined;
}
