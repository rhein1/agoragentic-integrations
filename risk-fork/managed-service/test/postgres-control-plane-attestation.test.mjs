import assert from 'node:assert/strict';
import test from 'node:test';
import manifest from '../src/postgres-control-plane-catalog-v2.json' with { type: 'json' };
import { verifyPostgresControlPlaneAttestation } from '../src/postgres-control-plane-attestation.mjs';

const schema='risk_fork_managed'; const owner='managed_migrator'; const runtime='managed_runtime';
const tables=manifest.catalog.relations.map((r)=>r.name);
const inserts=['managed_audit_events','managed_invocations','managed_lease_token_uses','managed_resource_journal_receipts','managed_usage_buckets'];
const updates=['managed_invocations','managed_usage_buckets'];
const clone=(v)=>JSON.parse(JSON.stringify(v));

function fixture(){
  const state={mutation:null};
  const query=async(sql)=>{
    if(sql.includes("current_setting('server_version_num')")) return {rowCount:1,rows:[{version:'160000'}]};
    if(sql.includes('pg_catalog.pg_roles r WHERE r.rolname=current_user')) return {rowCount:1,rows:[{runtime,session:runtime,rolcanlogin:true,rolinherit:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false,fsync:'on',synchronous_commit:'on',replication_role:'origin'}]};
    if(sql.includes('pg_catalog.pg_auth_members')) return {rowCount:0,rows:[]};
    if(sql.includes('FROM (')&&sql.includes('n.nspowner')) return {rowCount:state.mutation==='ownership'?1:0,rows:[]};
    if(sql.includes('x.grantee<>c.relowner')&&sql.includes('c.relname=ANY')){
      if(state.mutation==='table_acl') return {rowCount:1,rows:[{name:'managed_tenants',grantee:'PUBLIC',privilege_type:'SELECT',is_grantable:false}]};
      return {rowCount:tables.length+inserts.length+updates.length,rows:tables.flatMap((name)=>['SELECT',...(inserts.includes(name)?['INSERT']:[]),...(updates.includes(name)?['UPDATE']:[])].sort().map((privilege_type)=>({name,grantee:runtime,privilege_type,is_grantable:false})))};
    }
    if(sql.includes('x.grantee<>p.proowner')) return {rowCount:3,rows:['lock_managed_api_key_share','lock_managed_tenant_share','lock_managed_tenant_update'].map((name)=>({name,grantee:runtime,privilege_type:'EXECUTE',is_grantable:false}))};
    if(sql.includes('database_owner')) return {rowCount:1,rows:[{usage:true,schema_create:false,connect:true,db_create:false,temporary:false,database_owner:false}]};
    if(sql.includes('p.proacl')||sql.includes('a.attacl')||sql.includes('n.nspacl')||sql.includes('pg_database d')||sql.includes('pg_default_acl')||sql.includes('FROM pg_catalog.pg_roles o')) return {rowCount:0,rows:[]};
    if(sql.includes('has_schema_privilege')) return {rowCount:1,rows:[{usage:true,schema_create:false,connect:true,db_create:false,temporary:false,database_owner:false}]};
    if(sql.includes('SELECT version,migration_hash,applied_at')){const rows=manifest.migration_hashes.map((migration_hash,index)=>({version:index+1,migration_hash,applied_at:new Date(0)}));if(state.mutation==='ledger')rows[0].migration_hash='sha256:'+'0'.repeat(64);if(state.mutation==='cancellation_ledger')rows.pop();return {rowCount:rows.length,rows};}
    if(sql.includes('pg_catalog.pg_attribute')){const rows=clone(manifest.catalog.columns);if(state.mutation==='column')rows[0].attnotnull=!rows[0].attnotnull;if(state.mutation==='cancellation_column'){const row=rows.find((column)=>column.name==='cancel_request_hash');assert.ok(row);row.attnotnull=!row.attnotnull;}return {rowCount:rows.length,rows};}
    if(sql.includes('pg_catalog.pg_class c')&&sql.includes('relkind NOT IN')){const rows=clone(manifest.catalog.relations);if(state.mutation==='extra_object')rows.push({...rows[0],name:'unreviewed_extra'});return {rowCount:rows.length,rows};}
    if(sql.includes('pg_catalog.pg_constraint')){const rows=clone(manifest.catalog.constraints);if(state.mutation==='constraint')rows[0].definition+=' /* drift */';return {rowCount:rows.length,rows};}
    if(sql.includes('pg_catalog.pg_index')){const rows=clone(manifest.catalog.indexes);if(state.mutation==='index')rows[0].definition+=' WHERE false';return {rowCount:rows.length,rows};}
    if(sql.includes('pg_catalog.pg_trigger')){const rows=clone(manifest.catalog.triggers);if(state.mutation==='trigger')rows[0].tgenabled='D';if(state.mutation==='cancellation_trigger'){const row=rows.find((trigger)=>trigger.name==='managed_invocations_no_cancellation_rearm');assert.ok(row);row.tgenabled='D';}return {rowCount:rows.length,rows};}
    if(sql.includes('pg_catalog.pg_proc p')&&sql.includes('pg_get_functiondef')){const rows=clone(manifest.catalog.functions);if(state.mutation==='function')rows[0].definition+='\n-- drift';if(state.mutation==='search_path')rows[1].proconfig=['search_path=public'];if(state.mutation==='cancellation_function'){const row=rows.find((fn)=>fn.name==='reject_managed_cancellation_rearm');assert.ok(row);row.definition+='\n-- drift';}return {rowCount:rows.length,rows};}
    if(sql.includes('pg_catalog.pg_type t'))return {rowCount:manifest.catalog.types.length,rows:clone(manifest.catalog.types)};
    if(sql.includes('pg_catalog.pg_policy')||sql.includes('pg_catalog.pg_rewrite')||sql.includes('pg_catalog.pg_inherits'))return {rowCount:0,rows:[]};
    throw new Error(`unmapped fixture query: ${sql}`);
  };
  return {client:{query},mutate:(mutation)=>{state.mutation=mutation;}};
}

test('control-plane attestation accepts provider-free reviewed baseline',async()=>{
  const f=fixture();
  const report=await verifyPostgresControlPlaneAttestation(f.client,{schemaName:schema,expectedOwner:owner});
  assert.equal(report.catalog_verified,true); assert.equal(report.runtime_privileges_verified,true); assert.equal(report.production_qualified,false);
});

test('control-plane attestation rejects catalog, ledger, helper, and ACL drift',async()=>{
  for(const mutation of ['constraint','index','function','search_path','column','trigger','extra_object','ledger','table_acl','cancellation_column','cancellation_trigger','cancellation_function','cancellation_ledger']){
    const f=fixture(); f.mutate(mutation);
    await assert.rejects(verifyPostgresControlPlaneAttestation(f.client,{schemaName:schema,expectedOwner:owner}), { code: 'MANAGED_POSTGRES_ATTESTATION_FAILED' }, mutation);
  }
});

test('control-plane attestation closes malformed options and private errors',async()=>{
  for(const options of [null,[],{unexpected:true},{schemaName:'Bad-Name'},{expectedOwner:''}]) await assert.rejects(verifyPostgresControlPlaneAttestation({query:async()=>({rowCount:0,rows:[]})},options),(e)=>e.code==='MANAGED_POSTGRES_ATTESTATION_FAILED');
  const secret='control-plane-secret';
  await assert.rejects(verifyPostgresControlPlaneAttestation({query:async()=>{throw new Error(secret);}},{}),(e)=>e.code==='MANAGED_POSTGRES_ATTESTATION_FAILED'&&!e.message.includes(secret));
});
