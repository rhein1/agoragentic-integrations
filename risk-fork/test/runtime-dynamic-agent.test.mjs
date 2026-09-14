import test from 'node:test';import assert from 'node:assert/strict';
import {prepareAgent,finishPreview,sha} from '../examples/runtime-dynamic/core.mjs';
import {rehearse,options} from '../examples/runtime-dynamic/public/agent.mjs';
import {authorize,dispatchOnce} from '../examples/runtime-dynamic/live/authorization.mjs';
import {createDynamicAction} from '../examples/runtime-dynamic/live/dynamic-action.mjs';
const NOW=Date.parse('2026-09-13T20:00:00.000Z');
const inspect=async p=>({accepted:p.id!=='trap',cleanup:'verified',risk_fork_executed:true});
const make=async(goal='current',budget=6,scenario='clean')=>prepareAgent({goal,budget,scenario},{inspect,now:()=>NOW});
function policy(p){return {schema:'agoragentic.runtime-owner-approval.v1',approved:true,revoked:false,
 network:'eip155:84532',wallet_model:'dynamic_developer_owned_server_wallet',approved_plan_hash:sha(p),
 wallet_address:'0x1111111111111111111111111111111111111111',seller_address:'0x2222222222222222222222222222222222222222',
 expires_at:new Date(NOW+240000).toISOString(),unit_price_wei:'1000000000000',max_payment_wei:'10000000000000',
 max_fee_per_gas_wei:'1000000000',max_total_cost_wei:'50000000000000'};}
for(const [goal,budget,expected] of [['overview',6,'public'],['current',6,'current'],['deep',6,'deep'],['deep',4,null]])test(`decision ${goal}/${budget} selects ${expected}`,async()=>{const p=await make(goal,budget);assert.equal(p.selected?.id??null,expected);});
test('required Risk Fork bridge cannot silently disappear',async()=>{await assert.rejects(prepareAgent({}),/risk_fork_required/);});
test('tainted cheaper source never enters selection',async()=>{const p=await make('current',6,'attack');assert.equal(p.selected.id,'current');assert.deepEqual(p.rejected_sources,['trap']);});
test('unknown cleanup stops before a proposal',async()=>{const p=await prepareAgent({},{inspect:async()=>({accepted:true,cleanup:'unknown'})});assert.equal(p.reason,'cleanup_unverified');assert.equal(p.proposal,undefined);});
for(const s of ['revoked','tampered'])test(`${s} stops the demo`,async()=>{assert.equal((await make('current',6,s)).status,'blocked');});
test('preview never claims Dynamic or payment',async()=>{const p=finishPreview(await make());assert.equal(p.status,'completed');assert.equal(p.evidence.dynamic_contacted,false);assert.equal(p.payment.status,'not_attempted');assert.ok(p.brief.facts.length);});
test('browser rehearsal never claims reference runtime',()=>{const r=rehearse({scenario:'attack'});assert.equal(r.risk_fork_executed,false);assert.equal(r.dynamic_contacted,false);assert.equal(r.status,'completed');});
test('closed input rejects URL override, fractional and unlimited budgets',()=>{for(const x of [{url:'https://bad.invalid'}, {budget:1.2},{budget:100},{goal:'__proto__'}])assert.throws(()=>options(x));});
test('owner approval derives exact bounded transfer',async()=>{const p=await make(),a=authorize(p,policy(p),NOW);assert.equal(a.value,'2000000000000');assert.equal(a.chainId,84532);assert.equal(a.gas,'21000');assert.ok(Object.isFrozen(a));});
test('changed plan is rejected',async()=>{const p=await make(),a=policy(p),x=JSON.parse(JSON.stringify(p));x.proposal.units=9;assert.throws(()=>authorize(x,a,NOW),/plan_changed/);});
for(const [name,patch] of [['revoked',{revoked:true}],['mainnet',{network:'eip155:8453'}],['wrong model',{wallet_model:'provider_managed'}],['not approved',{approved:false}],['excess gas',{max_fee_per_gas_wei:'999999999999'}]])test(`authorization refuses ${name}`,async()=>{const p=await make();assert.throws(()=>authorize(p,{...policy(p),...patch},NOW));});
test('expiry is enforced after async claim',async()=>{const p=await make(),a=policy(p);let now=NOW,calls=0;await assert.rejects(dispatchOnce(p,a,{now:()=>now,claim:async()=>{now+=400000;return true;},action:()=>{calls++;}}));assert.equal(calls,0);});
test('revocation after async claim prevents action',async()=>{const p=await make(),a=policy(p);let calls=0;await assert.rejects(dispatchOnce(p,a,{now:()=>NOW,claim:async()=>true,reloadPolicy:()=>({...a,revoked:true}),action:()=>{calls++;}}));assert.equal(calls,0);});
test('one-use claim allows at most one action',async()=>{const p=await make(),a=policy(p);let used=false,calls=0;const d={now:()=>NOW,claim:async()=>{if(used)return false;used=true;return true;},action:async()=>{calls++;return {status:'fixture'};}};await dispatchOnce(p,a,d);await assert.rejects(dispatchOnce(p,a,d),/already_claimed/);assert.equal(calls,1);});
test('ambiguous action yields reconciliation without retry',async()=>{const p=await make(),a=policy(p);let calls=0;const r=await dispatchOnce(p,a,{now:()=>NOW,claim:async()=>true,action:async()=>{calls++;throw new Error('secret-shaped-raw-error');}});assert.equal(r.status,'reconciliation_required');assert.equal(r.automatic_retry,false);assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes('secret-shaped'));});
test('free source cannot be forced through wallet',async()=>{const p=await make('overview');assert.throws(()=>authorize(p,policy(p),NOW),/free_result/);});
function mockSdk({chain=84532,wrongRecipient=false}={}){
 const counts={sign:0,broadcast:0},raw='fixture-serialized-transaction',from='0x1111111111111111111111111111111111111111',to='0x2222222222222222222222222222222222222222';let signed;
 class Client{async authenticateApiToken(){}async getWalletClient(){return {account:{address:from},signTransaction:async x=>{counts.sign++;signed=x;return raw;}};}}
 const rpc={getChainId:async()=>chain,getBytecode:async()=>undefined,getTransactionCount:async()=>0,
 sendRawTransaction:async()=>{counts.broadcast++;return '0x'+'a'.repeat(64);},getTransactionReceipt:async()=>({blockNumber:1n,status:'success'}),getBlockNumber:async()=>2n,
 getTransaction:async()=>({from,to,value:signed.value,nonce:0})};
 return {counts,load:async()=>[{DynamicEvmWalletClient:Client},{createPublicClient:()=>rpc,http:()=>{},parseTransaction:()=>({...signed,to:wrongRecipient?from:to}),recoverTransactionAddress:async()=>from},{baseSepolia:{id:84532}}]};
}
test('real SDK wrapper performs one bound sign and broadcast under injected SDK',async()=>{const m=mockSdk(),p=await make(),a=authorize(p,policy(p),NOW);const action=await createDynamicAction({environment_id:'fixture',api_token:'fixture',account_address:a.from},{load:m.load});const r=await action({...a,assertCurrent(){}});assert.equal(r.status,'confirmed_testnet');assert.equal(m.counts.sign,1);assert.equal(m.counts.broadcast,1);});
test('wrong RPC chain blocks signing',async()=>{const m=mockSdk({chain:1}),p=await make(),a=authorize(p,policy(p),NOW);const action=await createDynamicAction({environment_id:'fixture',api_token:'fixture',account_address:a.from},{load:m.load});await assert.rejects(action({...a,assertCurrent(){}}));assert.equal(m.counts.sign,0);});
test('wrong signed recipient blocks broadcasting',async()=>{const m=mockSdk({wrongRecipient:true}),p=await make(),a=authorize(p,policy(p),NOW);const action=await createDynamicAction({environment_id:'fixture',api_token:'fixture',account_address:a.from},{load:m.load});await assert.rejects(action({...a,assertCurrent(){}}),/signed_transaction_mismatch/);assert.equal(m.counts.broadcast,0);});
