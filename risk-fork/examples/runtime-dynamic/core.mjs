import {createHash,randomUUID} from 'node:crypto';
import {options,catalogFor,rankProviders,composeBrief,MODES} from './public/agent.mjs';
export const sha = x => 'sha256:'+createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function freeze(x) {if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
export async function prepareAgent(input, {inspect,now=()=>Date.now()}={}) {
  if(typeof inspect!=='function') throw new Error('risk_fork_required');
  const o=options(input), budget=o.scenario==='budget'?0:o.budget;
  const events=[], accepted=[], rejected=[], inspections=[];
  const id=randomUUID(), started=now();
  const event=(phase,detail)=>events.push({phase,detail});
  event('mandate',`${MODES[o.goal].label}; ${budget} demo units. No outside URLs or credentials accepted.`);
  for(const candidate of catalogFor(o.scenario)) {
    const result=await inspect(candidate, {runId:id,scenario:o.scenario});
    if(!result||typeof result.accepted!=='boolean'||result.cleanup!=='verified') {
      return freeze({id,status:'blocked',reason:'cleanup_unverified',events:[...events,{phase:'denial',detail:'Cleanup could not be verified. No signing request.'}],inspections,
        evidence:{risk_fork_executed:result?.risk_fork_executed===true,isolation_boundary:false,dynamic_contacted:false,money_moved:false}});
    }
    inspections.push({provider:candidate.id,accepted:result.accepted,cleanup:result.cleanup,
      capsule_hash:result.capsule_hash??null,artifact_hash:result.artifact_hash??null,
      risk_fork_executed:result.risk_fork_executed===true});
    if(result.accepted){accepted.push(candidate);}else{rejected.push(candidate.id);event('denial',`${candidate.name}: typed artifact refused. The source gets no signing authority.`);}
  }
  event('fork','Actual Risk Fork local-reference lifecycle; typed candidates checked, copies destroyed and absence verified. Not a production isolation boundary.');
  const ranked=rankProviders(o.goal,budget,accepted), selected=ranked.find(p=>p.eligible);
  event('decision',selected?`${selected.name}: lowest cost satisfying freshness and detail.`:'No source meets both task and budget.');
  if(!selected) return freeze({id,status:'blocked',reason:'no_eligible_provider',events,candidates:ranked,inspections,rejected_sources:rejected,
    evidence:{risk_fork_executed:true,isolation_boundary:false,dynamic_contacted:false,money_moved:false}});
  const proposal=freeze({schema:'agoragentic.runtime-demo-action.v1',run_id:id,goal:o.goal,provider_id:selected.id,
    units:selected.units,budget_units:budget,network:'eip155:84532',expires_at:new Date(started+300000).toISOString(),
    source_digest:sha(selected),action:'access_demo_report',synthetic_service:true});
  const digest=sha(proposal);
  if(['revoked','tampered'].includes(o.scenario)) {
    event('authority',`Stopped: ${o.scenario}. No signing request.`);
    return freeze({id,status:'blocked',reason:o.scenario,proposal,proposal_hash:digest,events,candidates:ranked,inspections,
      evidence:{risk_fork_executed:true,isolation_boundary:false,dynamic_contacted:false,money_moved:false}});
  }
  event('authority','Proposal fixed. A paid or wallet-backed action still requires separate owner authorization.');
  return freeze({id,status:'prepared',proposal,proposal_hash:digest,selected,events,candidates:ranked,inspections,rejected_sources:rejected,
    evidence:{risk_fork_executed:inspections.every(x=>x.risk_fork_executed),isolation_boundary:false,dynamic_contacted:false,money_moved:false}});
}
export function finishPreview(prepared) {
  if(prepared.status!=='prepared')return prepared;
  return freeze({...prepared,mode:'local_reference_demo',status:'completed',
    events:[...prepared.events,{phase:'wallet',detail:prepared.selected.units?'Mock purchase; no Dynamic contact or payment.':'Free public result; no wallet action.'},
      {phase:'outcome',detail:'Demo service result delivered and used in the brief.'}],
    brief:composeBrief(prepared.proposal.goal,prepared.selected),
    payment:{status:'not_attempted',settlement:'unverified'},production_ready:false});
}
