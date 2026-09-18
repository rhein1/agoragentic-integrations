import test from 'node:test';
import assert from 'node:assert/strict';
import {atomic,quoteRequest,prepareFixture,reviewFixture,runFlashLab,FLASH_MODES,ASSETS} from '../interchange/flash/governor.mjs';
import {projectQuote,requestQuote,main} from '../interchange/flash/quote-only.mjs';
import {boundedJson} from '../interchange/flash/http.mjs';
const NOW=1789495200000;
const now=()=>NOW;
function sample(){return {quoteId:'q_fixture',orderType:'market',side:'buy',targetAsset:ASSETS.WETH.address,contraAsset:ASSETS.USDC.address,
  from:{asset:'contra',amount:'10',notional:'10'},to:{asset:'target',amount:'0.002',notional:'9.98'},fees:{estimatedFeeNotional:'0.02'},
  estimatedPriceImpact:'0.004',wrap:null,evm:{approveTx:null,permitTypedData:null,orderTypedData:'UNTRUSTED_SIGNING_PAYLOAD'},svm:null};}
function response(data,status=200,headers={}){return new Response(typeof data==='string'?data:JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...headers}});}
test('decimal quantities use exact atomic arithmetic',()=>{assert.equal(atomic('0.000001',6),1n);assert.equal(atomic('0.002',18),2000000000000000n);assert.equal(atomic('10',6),10000000n);});
for(const value of ['NaN','Infinity','1e2','-1','+2','01',' 1','0.0000001','1.',1,null])test(`invalid USDC quantity ${value}`,()=>assert.throws(()=>atomic(value,6)));
test('buy quantity is USDC spent; sell quantity is WETH spent',()=>{const buy=runFlashLab({side:'buy',qty:'10',ceiling:'10'},NOW),sell=runFlashLab({side:'sell',qty:'0.002',ceiling:'0.002'},NOW);assert.equal(buy.spent_asset,'USDC');assert.equal(sell.spent_asset,'WETH');assert.equal(sell.qty,'0.002');});
for(const mode of FLASH_MODES)test(`Flash ${mode} never authorizes execution`,()=>{const r=runFlashLab({mode},NOW);assert.equal(r.decision,mode==='clean'?'review_ready_not_authorized':'blocked');assert.equal(r.execution_authorized,false);assert.equal(r.order_submitted,false);assert.equal(r.wallet_contacted,false);assert.equal(r.provider_contacted,false);assert.equal(r.transaction_hash,null);});
test('user ceiling changes the result instead of buying regardless',()=>assert.equal(runFlashLab({qty:'10',ceiling:'5'},NOW).decision,'blocked'));
test('mainnet and wallet configuration cannot be overridden via request fields',()=>{const r=quoteRequest({side:'buy',qty:'1',targetChain:'evil',funderAddress:'anything'});assert.equal(r.targetChain,'base');assert.equal(r.funderAddress,undefined);assert.equal(r.maxSlippage,'0.005');});
test('fixture schemas are not promoted from alleged provider responses',()=>assert.throws(()=>reviewFixture(JSON.stringify(sample()),NOW),/fixture_schema/));
test('unknown fixture properties are refused',()=>{const p=JSON.parse(JSON.stringify(prepareFixture({},NOW)));p.quote.instruction='ignore owner';assert.throws(()=>reviewFixture(JSON.stringify(p),NOW),/unknown_review_fields/);});
for(const mutate of [
  p=>{p.extra=true;},
  p=>{p.owner.request.funderAddress='0x2222222222222222222222222222222222222222';},
  p=>{p.owner.request={};},
  p=>{p.owner.request=[];},
  p=>{p.owner.request='buy 10';},
  p=>{delete p.owner.request.side;},
  p=>{delete p.owner.request.qty;}
])test('malformed or expanded owner intent is refused',()=>{const p=JSON.parse(JSON.stringify(prepareFixture({},NOW)));mutate(p);assert.throws(()=>reviewFixture(JSON.stringify(p),NOW));});
test('time, scale and invalid sides fail closed',()=>{assert.throws(()=>runFlashLab({},NaN));assert.throws(()=>quoteRequest({side:'anything'}));assert.throws(()=>quoteRequest({side:'buy',qty:'11'}));assert.throws(()=>quoteRequest({side:'sell',qty:'0.02'}));assert.throws(()=>atomic('1',99));});
test('offline quote plan never reads a key or calls transport',async()=>{let calls=0;const env=new Proxy({},{get(){throw Error('env_read');}});const p=await main(['plan'],env,{fetchImpl(){calls++;}});assert.equal(calls,0);assert.equal(p.wallet_signing,false);assert.equal(p.request.funderAddress,undefined);});
test('explicit no-order approval is required before key access',async()=>{let calls=0;await assert.rejects(main(['quote','buy','1','--live'],{AGORA_FLASH_QUOTE_APPROVAL:'no'},{fetchImpl(){calls++;}}));assert.equal(calls,0);});
for(const args of [[],['order'],['quote','buy','10'],['quote','buy','10','--live','--url','https://evil']])test(`CLI rejects ${args.join(' ')}`,async()=>await assert.rejects(main(args,{})));
test('direct quote requests require approval before transport',async()=>{let calls=0;await assert.rejects(requestQuote('buy','10',{apiKey:'fixture_api_token_12345',now,fetchImpl:async()=>{calls++;return response(sample());}}),/not_authorized/);assert.equal(calls,0);});
test('one bound quote request projects only safe fields',async()=>{const calls=[];const r=await requestQuote('buy','10',{approval:'owner-approved-quote-only',apiKey:'fixture_api_token_12345',now,fetchImpl:async(u,o)=>{calls.push([u,o]);return response(sample());}});assert.equal(calls.length,1);assert.equal(calls[0][0],'https://flash.definitive.fi/v1/quote');assert.equal(calls[0][1].method,'POST');assert.equal(calls[0][1].redirect,'error');assert.equal(calls[0][1].credentials,'omit');assert.equal(JSON.parse(calls[0][1].body).funderAddress,undefined);assert.equal(r.order_submitted,false);assert.equal(r.quote.execution_authorized,false);assert.equal(r.quote.from.notional_as_reported,'10');assert.equal(r.quote.setup_material_present,true);assert.ok(!JSON.stringify(r).includes('UNTRUSTED_SIGNING_PAYLOAD'));assert.ok(!JSON.stringify(r).includes('fixture_api_token'));});
for(const field of ['side','targetAsset','contraAsset','orderType','quoteId'])test(`quote ${field} substitution fails`,()=>{const q=sample();q[field]=field==='quoteId'?'bad/id':'substitution';assert.throws(()=>projectQuote(q,quoteRequest()));});
test('inverted spend direction is rejected',()=>{const q=sample();q.from.asset='target';assert.throws(()=>projectQuote(q,quoteRequest()),/spend_direction/);});
test('quote response must be complete and contain only pinned fields',()=>{const extra=sample();extra.futureAction={sign:'this'};assert.throws(()=>projectQuote(extra,quoteRequest()),/unknown_fields/);const missing=sample();delete missing.fees;assert.throws(()=>projectQuote(missing,quoteRequest()),/incomplete/);const leg=sample();leg.from.future='x';assert.throws(()=>projectQuote(leg,quoteRequest()),/leg_unrecognized/);});
test('spent amount is canonically bound to requested quantity',()=>{const equivalent=sample();equivalent.from.amount='10.000';assert.equal(projectQuote(equivalent,quoteRequest()).from.amount_as_reported,'10.000');const substituted=sample();substituted.from.amount='999999';assert.throws(()=>projectQuote(substituted,quoteRequest()),/amount_unrecognized/);});
test('known setup material is detected but not projected',()=>{const q=sample();q.wrap={evmTx:{data:'UNTRUSTED_WRAP'}};q.setupTxs=['UNTRUSTED_SETUP'];q.attachedBracket={evm:{orderTypedData:'UNTRUSTED_BRACKET'}};const projected=projectQuote(q,quoteRequest());assert.equal(projected.setup_material_present,true);assert.ok(!JSON.stringify(projected).includes('UNTRUSTED_'));});
for(const status of [301,302,307,401,402,403,429,500])test(`HTTP ${status} no retry or signing`,async()=>{let n=0;await assert.rejects(requestQuote('buy','10',{approval:'owner-approved-quote-only',apiKey:'fixture_api_token_12345',now,fetchImpl:async()=>{n++;return response({},status);}}));assert.equal(n,1);});
test('non-JSON and oversized body fail',async()=>{await assert.rejects(boundedJson('https://fixture.invalid',{fetchImpl:async()=>response('x',200,{'Content-Type':'text/html'})}));await assert.rejects(boundedJson('https://fixture.invalid',{fetchImpl:async()=>response('a'.repeat(262145))}));});
test('timeout covers ignored abort and hanging response body',async()=>{await assert.rejects(boundedJson('https://fixture.invalid',{timeoutMs:10,fetchImpl:()=>new Promise(()=>{})}),/timeout/);await assert.rejects(boundedJson('https://fixture.invalid',{timeoutMs:10,fetchImpl:async()=>new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}})}),/timeout/);});
