#!/usr/bin/env node
/** Public, no-spend Interchange inspection. No credentials, SDKs, or URL overrides. */
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ORIGIN = 'https://agoragentic.com';
const SURFACE = '/api/commerce/interchange';
const MANIFEST = '/.well-known/agent-commerce.json';
const VERIFY = `${SURFACE}/receipts/verify`;
const LIMIT = 262144;
const TIMEOUT_MS = 10000;
const ID = /^areceipt2_[A-Za-z0-9_-]{1,160}$/;
const obj = x => !!x && typeof x === 'object' && !Array.isArray(x);
const bool = x => typeof x === 'boolean' ? x : null;
const hash = text => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const freeze = x => { if (x && typeof x === 'object') {Object.values(x).forEach(freeze); Object.freeze(x);} return x; };
function fail(code) {throw new Error(code);}
function stamp(now) {const n = now(); if (!Number.isFinite(n)) fail('invalid_clock'); return n;}

export const POLICY = freeze({
  schema:'agoragentic.bankr.read-only-policy.v1', origin:ORIGIN,
  requests:[{method:'GET',path:SURFACE},{method:'GET',path:MANIFEST},{method:'POST',path:VERIFY}],
  credentials:false, redirects:false, automatic_retries:false,
  wallet_signing:false, spending:false, provider_invocation:false, deployment:false,
  note:'POST is allowed only for the existing read-only receipt verifier. Skill prose is not a sandbox.'
});

/** Construct every request internally. No arbitrary method, URL, header, or receipt-body input. */
export function requestFor(operation, receiptId) {
  if (operation === 'surface' || operation === 'manifest') {
    if (receiptId !== undefined) fail('unexpected_argument');
    return freeze({url:ORIGIN+(operation==='surface'?SURFACE:MANIFEST), method:'GET', body:null});
  }
  if (operation === 'verify-id') {
    if (typeof receiptId !== 'string' || !ID.test(receiptId)) fail('invalid_receipt_id');
    return freeze({url:ORIGIN+VERIFY,method:'POST',body:JSON.stringify({receipt_id:receiptId})});
  }
  fail('operation_not_allowed');
}

/** Bound both headers and streamed body, including dependencies that ignore AbortSignal. */
export async function request(operation, receiptId, {fetchImpl=globalThis.fetch, now=Date.now, timeoutMs=TIMEOUT_MS}={}) {
  const r=requestFor(operation,receiptId), started=stamp(now);
  if (typeof fetchImpl!=='function' || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>TIMEOUT_MS) fail('invalid_transport');
  const controller=new AbortController(); let reader, timer;
  const headers={Accept:'application/json','Cache-Control':'no-cache'};
  if(r.method==='POST') headers['Content-Type']='application/json';
  const work=(async()=>{
    const response=await fetchImpl(r.url,{method:r.method,headers,body:r.body??undefined,
      credentials:'omit',redirect:'error',cache:'no-store',signal:controller.signal});
    if(response.redirected || (response.url && response.url!==r.url)) fail('redirect_refused');
    if(response.status>=300 && response.status<400) fail('redirect_refused');
    if(!Number.isInteger(response.status)) fail('invalid_http_status');
    if(response.status===429) fail('rate_limited_no_retry');
    if(response.status===402) fail('payment_required_not_authorized');
    if(response.status===401 || response.status===403) fail('access_denied_no_credentials');
    const media=response.headers.get('content-type')??'';
    if(!/^application\/json(?:\s*;|$)/i.test(media)) fail('unexpected_media_type');
    const length=response.headers.get('content-length');
    if(length!==null && (!/^\d+$/.test(length)||Number(length)>LIMIT)) fail('response_too_large');
    if(!response.body?.getReader) fail('response_stream_required');
    reader=response.body.getReader(); let size=0; const chunks=[];
    while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>LIMIT)fail('response_too_large');chunks.push(Buffer.from(item.value));}
    const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
    let data;try{data=JSON.parse(text);}catch{fail('invalid_json');}
    if(!obj(data)) fail('json_object_required');
    const completed=stamp(now),date=response.headers.get('date'),serverTime=Date.parse(date??''),age=response.headers.get('age');
    const ageSeconds=age===null?null:/^\d+$/.test(age)?Number(age):NaN;
    const ageMs=Number.isFinite(serverTime)?completed-serverTime:null;
    // HTTP freshness is transport evidence, not an independent attestation of deployment or financial flags.
    const freshness=ageMs!==null&&ageMs>=-60000&&ageMs<=300000&&(ageSeconds===null||ageSeconds<=300)?'recent_http_response':'unverified_or_stale';
    return {data,evidence:{endpoint:r.url,method:r.method,http_status:response.status,
      observed_at:new Date(completed).toISOString(),elapsed_ms:Math.max(0,completed-started),
      server_date:Number.isFinite(serverTime)?new Date(serverTime).toISOString():null,
      cache_age_seconds:Number.isFinite(ageSeconds)?ageSeconds:null,freshness,body_sha256:hash(text),bytes:size}};
  })();
  try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('request_timeout_no_retry'));},timeoutMs);})]);}
  finally{clearTimeout(timer);controller.abort();if(reader) void reader.cancel().catch(()=>{});}
}

/** Project only known fields. Remote descriptions, instructions and advertised action URLs are never returned. */
export function projectSurface(data) {
  if(!obj(data)||data.schema!=='agoragentic.agent-commerce.interchange-surface.v1') fail('surface_schema_mismatch');
  const a=obj(data.availability)?data.availability:{},c=obj(a.custody)?a.custody:{};
  const rail=obj(data.external_x402_rail)?data.external_x402_rail:{},s=obj(data.safety)?data.safety:{};
  const freezeConfirmed=c.status==='frozen'&&c.authoritative===true&&c.authority_read_ok===true
    &&a.paid_execution==='temporarily_unavailable'&&rail.enabled===false&&rail.operational===false
    &&Array.isArray(s.live_money_paths)&&s.live_money_paths.length===0;
  const noEffects=s.funds_moved_by_this_surface===false&&s.provider_called_by_this_surface===false&&s.trust_mutated===false;
  const signing={receipt_signing_enabled:bool(data.signing_enabled),signed_receipts_required:bool(data.signed_receipts_required)};
  const counts={};for(const key of ['capability_cards','mandates','transaction_plans','receipts']) {
    counts[key]=Number.isSafeInteger(data.counts?.[key])&&data.counts[key]>=0?data.counts[key]:null;
  }
  return freeze({schema:data.schema,reported_custody_frozen:freezeConfirmed,
    read_only_surface_declared:noEffects,paid_execution_authorized:false,
    expected_no_money_profile:freezeConfirmed&&noEffects?'matched':'blocked_or_unknown',
    reported_counts:counts,receipt_evidence:signing,
    dispute_filing:data.dispute_filing?.status==='temporarily_unavailable'?'temporarily_unavailable':'unverified',
    note:'Surface declarations only. Counts are not customers or paid demand; receipt signing is not wallet signing.'});
}
export function projectManifest(data) {
  if(!obj(data)||data.schema!=='agoragentic.agent-commerce.manifest.v1') fail('manifest_schema_mismatch');
  if(data.interfaces?.api!==ORIGIN+SURFACE||data.interfaces?.receipt_verifier!==ORIGIN+VERIFY)fail('manifest_endpoint_mismatch');
  return freeze({schema:data.schema,known_endpoints_match:true,advertised_capabilities_are_not_authority:true});
}
export function projectVerification(data, status) {
  // 404/422 are honest negative results, not transport success promoted into verification.
  const v=obj(data.verification)?data.verification:null;
  if(status===200&&v&&typeof v.verified==='boolean')return freeze({
    outcome:v.verified?'provider_reports_verified':'provider_reports_rejected',
    provider_reports_verified:v.verified,independent_cryptographic_check:false,
    settlement_verified:false,task_correctness_verified:false});
  if(status===404)return freeze({outcome:'receipt_not_found',provider_reports_verified:false,
    independent_cryptographic_check:false,settlement_verified:false,task_correctness_verified:false});
  if(status===400||status===422)return freeze({outcome:'request_or_receipt_rejected',provider_reports_verified:false,
    independent_cryptographic_check:false,settlement_verified:false,task_correctness_verified:false});
  fail('verification_contract_unrecognized');
}
export async function inspect(deps={}) {
  const first=await request('surface',undefined,deps);
  if(first.evidence.http_status!==200)fail('surface_unavailable');
  const surface=projectSurface(first.data);
  const second=await request('manifest',undefined,deps);
  if(second.evidence.http_status!==200)fail('manifest_unavailable');
  const manifest=projectManifest(second.data);
  return freeze({schema:'agoragentic.bankr.inspection.v1',mode:'live_public_read_only',surface,manifest,
    evidence:[first.evidence,second.evidence],
    preflight:surface.expected_no_money_profile==='matched'&&[first,second].every(r=>r.evidence.freshness==='recent_http_response')?'pass_read_only_profile':'hold_for_review',
    scope:'Two public HTTP observations, not an end-to-end commerce or Bankr-host compatibility test.',
    bankr_host_tested:false,money_moved:false,wallet_contacted:false,production_mutation:false});
}
export async function verifyId(receiptId,deps={}) {
  const r=await request('verify-id',receiptId,deps);
  return freeze({schema:'agoragentic.bankr.receipt-check.v1',receipt_id:receiptId,
    verification:projectVerification(r.data,r.evidence.http_status),evidence:r.evidence,
    money_moved:false,wallet_contacted:false,production_mutation:false});
}
export async function main(args=process.argv.slice(2),deps={}) {
  if(args.length===0||(args.length===1&&args[0]==='plan'))return {exit:0,result:POLICY};
  if(args.length===2&&args[0]==='status'&&args[1]==='--live'){
    const result=await inspect(deps);return {exit:result.preflight==='pass_read_only_profile'?0:2,result};
  }
  if(args.length===3&&args[0]==='verify-id'&&args[2]==='--live')return {exit:0,result:await verifyId(args[1],deps)};
  fail('usage_plan_or_status_--live_or_verify-id_ID_--live');
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try{const {exit,result}=await main();console.log(JSON.stringify(result,null,2));process.exitCode=exit;}
  catch(error){const known=/^[a-z0-9_-]{1,100}$/.test(error?.message??'')?error.message:'transport_or_validation_failed';
    console.error(JSON.stringify({status:'blocked',error:known,automatic_retry:false,money_moved:false,wallet_contacted:false}));process.exitCode=2;}
}
