#!/usr/bin/env node
/** Apache-2.0. Separately operated Flash quote client. No order or signing methods. */
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {quoteRequest} from './governor.mjs';
import {boundedJson} from './http.mjs';
const URL='https://flash.definitive.fi/v1/quote';
const hash=x=>'sha256:'+createHash('sha256').update(x).digest('hex');
export function plan(side='buy',qty='10'){
  return Object.freeze({schema:'agoragentic.flash.quote-only-plan.v1',url:URL,method:'POST',request:quoteRequest({side,qty}),
    requires_api_key:true,funder_supplied:false,wallet_signing:false,order_submission:false,
    network_reference:'Base mainnet quotes only; this client cannot execute on any network',automatic_retry:false});
}
export function projectQuote(data,request){
  const id=typeof data?.quoteId==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(data.quoteId)?data.quoteId:null;
  const decimal=x=>typeof x==='string'&&x.length<=60&&/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(x)?x:null;
  if(!id||data.orderType!=='market'||data.side!==request.side||data.targetAsset?.toLowerCase()!==request.targetAsset||data.contraAsset?.toLowerCase()!==request.contraAsset)throw new Error('quote_binding_unrecognized');
  const expectedFrom=request.side==='buy'?'contra':'target',expectedTo=request.side==='buy'?'target':'contra';
  if(data.from?.asset!==expectedFrom||data.to?.asset!==expectedTo)throw new Error('spend_direction_mismatch');
  if(!decimal(data.from.amount)||!decimal(data.to.amount))throw new Error('quote_amount_unrecognized');
  return {quote_id:id,side:data.side,from:{asset:expectedFrom,amount_as_reported:data.from.amount},to:{asset:expectedTo,amount_as_reported:data.to.amount},
    estimated_price_impact:decimal(data.estimatedPriceImpact),
    setup_material_present:!!(data.evm||data.svm||data.wrap||data.setupTxs?.length||data.attachedBracket),
    setup_and_signing_payloads:'not returned or executed by this client',amount_unit_qualification:'required_before_economic_comparison',
    execution_authorized:false,settlement:'unverified'};
}
export async function requestQuote(side,qty,{apiKey,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=10000}={}){
  const p=plan(side,qty);
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
    if(env.AGORA_FLASH_QUOTE_APPROVAL!=='owner-approved-quote-only')throw new Error('quote_contact_not_authorized');
    // Read the credential only after the explicit, no-order operation is selected.
    return requestQuote(args[1],args[2],{...deps,apiKey:env.FLASH_API_KEY});
  }
  throw new Error('usage_plan_or_quote_buy_or_sell_quantity_--live');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await main(process.argv.slice(2)),null,2));}
  catch{console.error(JSON.stringify({status:'blocked',detail:'Quote client failed or was not authorized. No automatic retry. Inspect locally without exposing the key.',wallet_contacted:false,order_submitted:false}));process.exitCode=2;}
}
