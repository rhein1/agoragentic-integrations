/* Executes the existing local-reference protocol. It is NOT kernel isolation. */
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import {sha256Ref} from '../../src/canonical.mjs';
import {createForkIdentity,createSavepointCapsule,networkPolicy} from '../../src/contracts.mjs';
import {validateCommitCandidate} from '../../src/taint-gate.mjs';
import {inspectLocalWorkspace,LocalReferenceRiskForkAdapter} from '../../src/adapters/local-reference.mjs';
const schema={type:'object',additionalProperties:false,required:['provider_id','description'],properties:{
 provider_id:{type:'string',maxLength:40},description:{type:'string',maxLength:400}}};
export async function inspectSource(candidate,{runId,scenario}={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'agora-runtime-'));
  const source=path.join(root,'source'); await mkdir(source);
  let adapter=null,adapterRoot=null,savepoint=null,fork=null,artifact=null,accepted=false,cleanup;
  let capsule=null,executionError=null;
  try {
    const inspection=await inspectLocalWorkspace({source_workspace:source});
    const born=new Date();
    capsule=createSavepointCapsule({created_at:born,expires_at:new Date(born.getTime()+60000),
      parent:{agent_id:'runtime_parent',session_id:`session_${runId}`,state_hash:sha256Ref('clean_parent'),lineage_ref:'runtime_lineage',lineage_hash:sha256Ref('runtime_lineage')},
      agent_configuration:{model_version_hash:sha256Ref('bounded_utility_planner_v1'),system_instruction_hash:sha256Ref('sources_are_data'),tool_manifest_hash:sha256Ref('closed_demo_catalog')},
      checkpoint:{goal_ref:'runtime_goal',goal_hash:sha256Ref(runId),task_graph_ref:'runtime_graph',task_graph_hash:sha256Ref('inspect_select_authorize_deliver')},
      memory_roots:[],workspace:{snapshot_ref:'runtime_empty_workspace',digest:inspection.workspace_digest},
      governance:{policy_version:'runtime_demo_v1',policy_hash:sha256Ref('no_child_authority')},receipt_chain_head:sha256Ref('runtime_chain_start'),
      proposed_interaction:{mcp_server_ref:'runtime_fixture',mcp_server_origin:'https://runtime-fixture.invalid/',mcp_method:'tools/call',tool_name:'inspect_source',effective_arguments_hash:sha256Ref({provider_id:candidate.id}),target_ref:'runtime_fixture_target'},
      execution_authorization:{ref:null,hash:null},allowed_commit_types:['TYPED_RESULT'],authorized_result_schema_hash:sha256Ref(schema),runtime_snapshot:{mode:'none'}});
    const stateRoot=path.join(root,'state');
    await mkdir(stateRoot,{mode:0o700});
    adapter=new LocalReferenceRiskForkAdapter(process.platform==='win32'?{}:{baseDirectory:stateRoot}); await adapter.initialize();
    adapterRoot=adapter.baseDirectory;
    savepoint=await adapter.createSavepoint({capsule,source_workspace:source});
    const identity=createForkIdentity({parent_agent_id:capsule.parent.agent_id,parent_session_id:capsule.parent.session_id});
    fork=await adapter.createFork({savepoint_ref:savepoint.savepoint_ref,fork_identity:identity,network_policy:networkPolicy({mode:'blocked'}),ttl_ms:10000});
    const result=await adapter.executeInFork({fork_ref:fork.fork_ref,execution_mode:'isolated_execution',timeout_ms:5000,
      operation:{kind:'bounded_file_batch',actions:[],commit_candidate:{type:'TYPED_RESULT',payload:{provider_id:candidate.id,description:candidate.description},payload_schema:schema}}});
    try {artifact=validateCommitCandidate({candidate:result.commit_candidate,source_fork_id:fork.fork_ref,policy:{typed_result_schema_hash:sha256Ref(schema)}});accepted=true;}
    catch {accepted=false;} // A rejected typed artifact never becomes an instruction or permission.
  } catch {executionError='reference_execution_failed';}
  finally {
    try {
      if(fork) {await adapter.destroyFork({fork_ref:fork.fork_ref,reason:'runtime_demo_complete'});const r=await adapter.verifyDestroyed({fork_ref:fork.fork_ref});if(r.status!=='verified')throw new Error('fork_not_absent');}
      if(savepoint) {await adapter.destroySavepoint({savepoint_ref:savepoint.savepoint_ref});const r=await adapter.verifySavepointDestroyed({savepoint_ref:savepoint.savepoint_ref});if(r.status!=='verified')throw new Error('savepoint_not_absent');}
      cleanup=executionError?'unknown':'verified';
    } catch {cleanup='unknown';}
    try {if(adapter)await adapter.dispose();}catch{cleanup='unknown';}
    try {if(adapterRoot)await rm(adapterRoot,{recursive:true,force:true});}catch{cleanup='unknown';}
    await rm(root,{recursive:true,force:true}); // Only the exact mkdtemp-owned synthetic root.
  }
  return {accepted:accepted&&!executionError,cleanup:scenario==='cleanup-unknown'?'unknown':cleanup,
    capsule_hash:capsule?.capsule_hash??null,artifact_hash:artifact?.artifact_hash??null,
    risk_fork_executed:true,isolation_boundary:false,credentials_included:false,error:executionError};
}
