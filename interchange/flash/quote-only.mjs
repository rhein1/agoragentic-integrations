#!/usr/bin/env node
/** Apache-2.0. Separately operated Flash quote client. No order or signing methods. */
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {quoteRequest} from './governor.mjs';
import {boundedJson} from './http.mjs';
const URL='https://flash.definitive.fi/v1/quote';
const APPROVAL='owner-approved-quote-only';
const RESPONSE_FIELDS=Object.freeze(['quoteId','bridgeQuoteId','orderType','side','targetAsset','contraAsset','from','to','fees','estimatedPriceImpact','recommendedSlippage','wrap','evm','svm','attachedBracket','setupTxs']);
const REQUIRED_RESPONSE_FIELDS=Object.freeze(['quoteId','orderType','side','targetAsset','contraAsset','from','to','fees','estimatedPriceImpact','wrap','evm','svm']);
const hash=x=>'sha256:'+createHash('sha256').update(x).digest('hex');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const decimal=x=>typeof x==='string'&&x.length<=60&&/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(x)?x:null;
const canonicalDecimal=x=>{const valid=decimal(x);if(valid===null)return null;const [whole,fraction='']=valid.split('.');const trimmed=fraction.replace(/0+$/,'');return trimmed?`${whole}.${trimmed}`:whole;};
function exactObject(value,fields,error){
  if(!object(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(k=>!fields.includes(k)))throw new Error(error);
}
export function plan(side='buy',qty='10'){
  return Object.freeze({schema:'agoragentic.flash.quote-only-plan.v1',url:URL,method:'POST',request:quoteRequest({side,qty}),
    requires_api_key:true,funder_supplied:false,wallet_signing:false,order_submission:false,
    network_reference:'Base mainnet quotes only; this client cannot execute on any network',automatic_retry:false});
}
export function projectQuote(data,request){
  if(!object(data)||Object.keys(data).some(k=>!RESPONSE_FIELDS.includes(k)))throw new Error('quote_response_unknown_fields');
  if(REQUIRED_RESPONSE_FIELDS.some(k=>!Object.hasOwn(data,k)))throw new Error('quote_response_incomplete');
  const id=typeof data?.quoteId==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(data.quoteId)?data.quoteId:null;
  if(!id||data.orderType!=='market'||data.side!==request.side||typeof data.targetAsset!=='string'||typeof data.contraAsset!=='string'||data.targetAsset.toLowerCase()!==request.targetAsset||data.contraAsset.toLowerCase()!==request.contraAsset)throw new Error('quote_binding_unrecognized');
  exactObject(data.from,['asset','amount','notional'],'quote_leg_unrecognized');
  exactObject(data.to,['asset','amount','notional'],'quote_leg_unrecognized');
  exactObject(data.fees,['estimatedFeeNotional'],'quote_fees_unrecognized');
  const expectedFrom=request.side==='buy'?'contra':'target',expectedTo=request.side==='buy'?'target':'contra';
  if(data.from?.asset!==expectedFrom||data.to?.asset!==expectedTo)throw new Error('spend_direction_mismatch');
  const fromAmount=canonicalDecimal(data.from.amount),toAmount=canonicalDecimal(data.to.amount),requested=canonicalDecimal(request.qty);
  if(fromAmount===null||toAmount===null||fromAmount==='0'||toAmount==='0'||fromAmount!==requested||decimal(data.from.notional)===null||decimal(data.to.notional)===null||decimal(data.fees.estimatedFeeNotional)===null)throw new Error('quote_amount_unrecognized');
  if(data.estimatedPriceImpact!==null&&decimal(data.estimatedPriceImpact)===null)throw new Error('quote_price_impact_unrecognized');
  if(Object.hasOwn(data,'recommendedSlippage')&&data.recommendedSlippage!==null&&decimal(data.recommendedSlippage)===null)throw new Error('quote_slippage_unrecognized');
  if(![data.wrap,data.evm,data.svm].every(x=>x===null||object(x)))throw new Error('quote_setup_unrecognized');
  if(Object.hasOwn(data,'bridgeQuoteId')&&data.bridgeQuoteId!==null&&(typeof data.bridgeQuoteId!=='string'||data.bridgeQuoteId.length<1||data.bridgeQuoteId.length>256))throw new Error('quote_bridge_unrecognized');
  if(Object.hasOwn(data,'setupTxs')&&data.setupTxs!==null&&(!Array.isArray(data.setupTxs)||data.setupTxs.some(x=>typeof x!=='string')))throw new Error('quote_setup_unrecognized');
  if(Object.hasOwn(data,'attachedBracket')&&data.attachedBracket!==null&&!object(data.attachedBracket))throw new Error('quote_setup_unrecognized');
  return {quote_id:id,side:data.side,from:{asset:expectedFrom,amount_as_reported:data.from.amount,notional_as_reported:data.from.notional},to:{asset:expectedTo,amount_as_reported:data.to.amount,notional_as_reported:data.to.notional},
    fees:{estimated_fee_notional_as_reported:data.fees.estimatedFeeNotional},estimated_price_impact:data.estimatedPriceImpact,
    recommended_slippage:Object.hasOwn(data,'recommendedSlippage')?data.recommendedSlippage:null,
    setup_material_present:!!(data.evm||data.svm||data.wrap||(Array.isArray(data.setupTxs)&&data.setupTxs.length)||data.attachedBracket),
    setup_and_signing_payloads:'not returned or executed by this client',amount_unit_qualification:'required_before_economic_comparison',
    execution_authorized:false,settlement:'unverified'};
}
export async function requestQuote(side,qty,{approval,apiKey,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=10000}={}){
  const p=plan(side,qty);
  if(approval!==APPROVAL)throw new Error('quote_contact_not_authorized');
  if(typeof apiKey!=='string'||!/^[A-Za-z0-9_-]{12,256}$/.test(apiKey))throw new Error('api_key_required_in_operator_process');
  const r=await boundedJson(URL,{fetchImpl,method:'POST',headers:{'Content-Type':'application/json','x-definitive-api-key':apiKey},body:JSON.stringify(p.request),timeoutMs});
  const t=now();if(!Number.isSafeInteger(t)||t<0)throw new Error('invalid_clock');
  return {schema:'agoragentic.flash.quote-observation.v1',observed_at:new Date(t).toISOString(),
    request_sha256:hash(JSON.stringify(p.request)),response_sha256:hash(r.text),http_status:200,
    quote:projectQuote(r.data,p.request),provider_response_received:true,
    wallet_contacted:false,order_submitted:false,transaction_hash:null,
    qualification:'quote observation only; not trade readiness or sponsor eligibility'};
}
export async function main(args,env=process.env,deps={}){
  if(args.length===1&&args[0]==='plan')return plan();
  if(args.length===4&&args[0]==='quote'&&args[3]==='--live'){
    if(env.AGORA_FLASH_QUOTE_APPROVAL!==APPROVAL)throw new Error('quote_contact_not_authorized');
    // Read the credential only after the explicit, no-order operation is selected.
    return requestQuote(args[1],args[2],{...deps,approval:env.AGORA_FLASH_QUOTE_APPROVAL,apiKey:env.FLASH_API_KEY});
  }
  throw new Error('usage_plan_or_quote_buy_or_sell_quantity_--live');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await main(process.argv.slice(2)),null,2));}
  catch{console.error(JSON.stringify({status:'blocked',detail:'Quote client failed or was not authorized. No automatic retry. Inspect locally without exposing the key.',wallet_contacted:false,order_submitted:false}));process.exitCode=2;}
}
