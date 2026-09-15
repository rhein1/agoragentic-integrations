/** Apache-2.0. Deterministic, no-effects order-review lab; NOT a trade executor.
 * Fixtures use our own schema, not a claimed Flash provider response.
 * Flash's actual request convention is documented under /docs/placing-orders.
 */
export const ASSETS = Object.freeze({
  WETH: Object.freeze({address:'0x4200000000000000000000000000000000000006', decimals:18}),
  USDC: Object.freeze({address:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals:6})
});
export const FLASH_MODES = Object.freeze(['clean','over-budget','wrong-asset','recipient-change','unlimited-approval','expired','revoked','offchain-protection']);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function fail(s){throw new Error(s);}
export function atomic(value,decimals){
  if(!Number.isInteger(decimals)||decimals<0||decimals>18||typeof value!=='string'||value.length>40||!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))fail('invalid_decimal');
  const [whole,fraction='']=value.split('.');if(fraction.length>decimals)fail('excess_precision');
  return BigInt(whole)*10n**BigInt(decimals)+BigInt((fraction+'0'.repeat(decimals)).slice(0,decimals)||'0');
}
export function quoteRequest({side='buy',qty='10'}={}){
  if(!['buy','sell'].includes(side))fail('invalid_side');
  const amount=atomic(qty,side==='buy'?6:18),cap=side==='buy'?10000000n:10000000000000000n;
  if(amount<=0n||amount>cap)fail('quote_quantity_outside_demo_cap');
  return freeze({targetChain:'base',contraChain:'base',targetAsset:ASSETS.WETH.address,
    contraAsset:ASSETS.USDC.address,side,qty,orderType:'market',maxSlippage:'0.005',
    maxPriceImpact:'0.005',forceMinimalAllowance:true});
}
export function prepareFixture({mode='clean',side='buy',qty='10',ceiling='10'}={},now=Date.now()){
  if(!FLASH_MODES.includes(mode)||!Number.isFinite(now)||!Number.isSafeInteger(now)||now<0)fail('invalid_fixture_request');
  const request=quoteRequest({side,qty}),symbol=side==='buy'?'USDC':'WETH';
  const amount=atomic(qty,ASSETS[symbol].decimals),limit=atomic(ceiling,ASSETS[symbol].decimals);
  if(limit<=0n)fail('invalid_ceiling');
  const owner={schema:'agoragentic.flash.review-mandate.v1',request,network:'eip155:8453',
    spendAsset:ASSETS[symbol].address,spendCeilingAtomic:limit.toString(),recipient:'0x2222222222222222222222222222222222222222',
    revoked:mode==='revoked',requireIndependentPriceProtection:mode==='offchain-protection'};
  const quote={schema:'agoragentic.flash.unsigned-quote-fixture.v1',synthetic:true,network:owner.network,
    side,spendAsset:owner.spendAsset,spendAtomic:amount.toString(),recipient:owner.recipient,
    requiredAllowanceAtomic:amount.toString(),quotedAt:now,expiresAt:now+120000,priceProtection:'provider_offchain'};
  if(mode==='over-budget')quote.spendAtomic=(limit+1n).toString();
  if(mode==='wrong-asset')quote.spendAsset=side==='buy'?ASSETS.WETH.address:ASSETS.USDC.address;
  if(mode==='recipient-change')quote.recipient='0x3333333333333333333333333333333333333333';
  if(mode==='unlimited-approval')quote.requiredAllowanceAtomic=((1n<<256n)-1n).toString();
  if(mode==='expired')quote.expiresAt=now-1;
  return freeze({owner,quote,symbol,mode});
}
/** String input ensures inert JSON. No getters, callbacks, URLs, or signatures enter this lab. */
export function reviewFixture(serialized,now=Date.now()){
  if(typeof serialized!=='string'||serialized.length>8192||!Number.isSafeInteger(now)||now<0)fail('invalid_review_input');
  let pair;try{pair=JSON.parse(serialized);}catch{fail('invalid_json');}
  const o=pair?.owner,q=pair?.quote;
  if(!o||!q||o.schema!=='agoragentic.flash.review-mandate.v1'||q.schema!=='agoragentic.flash.unsigned-quote-fixture.v1'||q.synthetic!==true)fail('fixture_schema_required');
  const allowedO=['schema','request','network','spendAsset','spendCeilingAtomic','recipient','revoked','requireIndependentPriceProtection'];
  const allowedQ=['schema','synthetic','network','side','spendAsset','spendAtomic','recipient','requiredAllowanceAtomic','quotedAt','expiresAt','priceProtection'];
  if(Object.keys(o).some(k=>!allowedO.includes(k))||Object.keys(q).some(k=>!allowedQ.includes(k)))fail('unknown_review_fields');
  if(typeof o.revoked!=='boolean'||typeof o.requireIndependentPriceProtection!=='boolean')fail('invalid_authority_state');
  const request=quoteRequest(o.request),symbol=request.side==='buy'?'USDC':'WETH';
  const uint=x=>typeof x==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(x);
  if(![o.spendCeilingAtomic,q.spendAtomic,q.requiredAllowanceAtomic].every(uint))fail('invalid_atomic_amount');
  const checks=[];const check=(id,label,passed)=>checks.push({id,label,passed:passed===true});
  check('authority','Owner permission is active',o.revoked===false);
  check('network','Exact Base network bound',q.network==='eip155:8453'&&o.network===q.network);
  check('asset','Correct spent asset for buy / sell',o.spendAsset===ASSETS[symbol].address&&q.spendAsset===o.spendAsset&&q.side===request.side);
  check('amount','Quantity matches the request and ceiling',BigInt(q.spendAtomic)>0n&&BigInt(q.spendAtomic)===atomic(request.qty,ASSETS[symbol].decimals)&&BigInt(q.spendAtomic)<=BigInt(o.spendCeilingAtomic));
  check('recipient','Recipient matches owner intent',/^0x[0-9a-f]{40}$/.test(o.recipient)&&!/^0x0{40}$/.test(o.recipient)&&q.recipient===o.recipient);
  check('allowance','No excess / unlimited allowance',BigInt(q.requiredAllowanceAtomic)===BigInt(q.spendAtomic));
  check('expiry','Quote is recent and not expired',Number.isSafeInteger(q.quotedAt)&&Number.isSafeInteger(q.expiresAt)&&q.quotedAt<=now&&now-q.quotedAt<=120000&&q.expiresAt>now&&q.expiresAt-q.quotedAt<=120000);
  check('price','Price-protection trust model is acceptable for review',q.priceProtection==='provider_offchain'&&o.requireIndependentPriceProtection===false);
  const blocked=checks.filter(x=>!x.passed);
  return freeze({schema:'agoragentic.runtime.flash-review.v1',mode:'synthetic_preflight',
    decision:blocked.length?'blocked':'review_ready_not_authorized',checks,
    failed_checks:blocked.map(x=>x.id),spent_asset:symbol,qty:request.qty,
    quote_request:request,execution_authorized:false,provider_contacted:false,order_submitted:false,
    wallet_contacted:false,signature:null,transaction_hash:null,settlement:'unverified',
    warning:'Passing this fixture checks only its stated terms. No real approval, signing payload, Flash quote, order or settlement has been verified.',
    open_gates:['real_quote_and_setup_payload_qualification','signing_and_revocation_model_review','sponsor_requirements_confirmation','separately_authorized_execution']});
}
export function runFlashLab(options,now=Date.now()){
  return reviewFixture(JSON.stringify(prepareFixture(options,now)),now);
}
