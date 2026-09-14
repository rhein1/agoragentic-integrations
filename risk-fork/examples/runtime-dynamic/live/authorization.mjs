import {sha,freeze} from '../core.mjs';import {CATALOG,MODES,rankProviders} from '../public/agent.mjs';
const address=x=>typeof x==='string'&&/^0x[0-9a-fA-F]{40}$/.test(x)&&!/^0x0{40}$/.test(x);
const uint=x=>typeof x==='string'&&/^(0|[1-9]\d{0,24})$/.test(x);
function fail(code){throw new Error(code);}
export function authorize(plan,policy,now=Date.now()) {
  if(!Number.isFinite(now))fail('invalid_clock');
  if(!plan||plan.status!=='prepared'||!plan.proposal||!plan.selected)fail('prepared_plan_required');
  if(!policy||policy.schema!=='agoragentic.runtime-owner-approval.v1'||policy.approved!==true)fail('owner_approval_required');
  if(policy.network!=='eip155:84532'||policy.wallet_model!=='dynamic_developer_owned_server_wallet')fail('wrong_wallet_model_or_network');
  if(policy.approved_plan_hash!==sha(plan)||plan.proposal_hash!==sha(plan.proposal))fail('plan_changed');
  if(policy.revoked!==false)fail('revoked_or_unknown');
  const end=Date.parse(policy.expires_at),pEnd=Date.parse(plan.proposal.expires_at);
  if(!Number.isFinite(end)||!Number.isFinite(pEnd)||now>=end||now>=pEnd||end-now>900000)fail('expired_or_excessive_window');
  if(plan.evidence?.risk_fork_executed!==true||plan.inspections?.some(x=>x.cleanup!=='verified'))fail('reference_cleanup_missing');
  if(!Array.isArray(plan.inspections)||plan.inspections.length<4)fail('reference_evidence_missing');
  if(!address(policy.wallet_address)||!address(policy.seller_address)||policy.wallet_address.toLowerCase()===policy.seller_address.toLowerCase())fail('invalid_demo_accounts');
  if(!Object.hasOwn(MODES,plan.proposal.goal)||plan.proposal.network!=='eip155:84532')fail('invalid_task');
  if(!Number.isInteger(plan.proposal.budget_units)||plan.proposal.budget_units<0||plan.proposal.budget_units>10)fail('invalid_budget');
  const selected=rankProviders(plan.proposal.goal,plan.proposal.budget_units,CATALOG).find(x=>x.eligible);
  if(!selected||selected.id!==plan.selected.id||selected.id!==plan.proposal.provider_id||selected.units!==plan.proposal.units)fail('selection_changed');
  if(!selected.units)fail('free_result_requires_no_wallet');
  if(!uint(policy.unit_price_wei)||!uint(policy.max_payment_wei)||!uint(policy.max_fee_per_gas_wei)||!uint(policy.max_total_cost_wei))fail('invalid_cost_limits');
  const value=BigInt(policy.unit_price_wei)*BigInt(selected.units),gas=21000n,maxFee=BigInt(policy.max_fee_per_gas_wei);
  if(value<=0n||value>BigInt(policy.max_payment_wei)||value>10000000000000n)fail('payment_limit');
  if(maxFee<=0n||maxFee>2000000000n||value+gas*maxFee>BigInt(policy.max_total_cost_wei)||BigInt(policy.max_total_cost_wei)>100000000000000n)fail('gas_or_total_limit');
  return freeze({chainId:84532,from:policy.wallet_address.toLowerCase(),to:policy.seller_address.toLowerCase(),
    value:value.toString(),gas:gas.toString(),maxFeePerGas:maxFee.toString(),
    maxPriorityFeePerGas:(maxFee<1000000000n?maxFee:1000000000n).toString(),
    approval_hash:sha(policy),plan_hash:sha(plan),run_id:plan.id,provider:selected.id});
}
export async function dispatchOnce(plan,policy,{claim,action,now=()=>Date.now(),reloadPolicy=()=>policy}={}) {
  if(typeof claim!=='function'||typeof action!=='function')fail('dependencies_required');
  const fixed=authorize(plan,policy,now());
  if(!await claim(fixed))fail('attempt_already_claimed');
  const refreshed=await reloadPolicy();
  if(sha(refreshed)!==fixed.approval_hash)fail('approval_changed');
  authorize(plan,refreshed,now()); // No await before invoking the bounded action callback.
  try {return await action(fixed);}catch {return {status:'reconciliation_required',plan_hash:fixed.plan_hash,
    provider_contact:'unknown',signature:'unknown',submission:'unknown',settlement:'unverified',automatic_retry:false};}
}
