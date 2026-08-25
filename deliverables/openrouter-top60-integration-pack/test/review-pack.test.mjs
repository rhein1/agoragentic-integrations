import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AgoragenticClient, AgoragenticOpenRouterError } from '../openrouter-agent-sdk/src/agoragentic-client.mjs';
import { OrationClient } from '../adapters/oration-client.mjs';
function response(status,payload){return new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}})}
const blockedHostDecisionUrl=new URL('../decisions/blocked-qualified-host-enforcement.json',import.meta.url);
const mcpPackageName=`agoragentic-${'mcp'}`;
function assertNoRunnableMcpConfiguration(value,label='blocked host decision'){
  if(typeof value==='string'){
    assert.doesNotMatch(value,new RegExp(`\\b${mcpPackageName}@[^\\s\\x60"']+`,'i'),`${label} contains a versioned registry coordinate`);
    assert.doesNotMatch(value,new RegExp(`\\bnpx(?:\\.cmd)?(?:\\s+(?:--|-{1,2}[A-Za-z][\\w-]*(?:=[^\\s\\x60"']+)?))*\\s+(?:${mcpPackageName}(?:@[^\\s\\x60"']+)?|(?:-p|--package)=${mcpPackageName}(?:@[^\\s\\x60"']+)?)(?=\\s|$|[\\x60"'])`,'i'),`${label} contains a registry-resolving command`);
    assert.doesNotMatch(value,new RegExp(`https://agoragentic\\.com/api/${'mcp'}\\b`,'i'),`${label} contains the direct hosted MCP endpoint`);
    return;
  }
  if(Array.isArray(value)){
    const tokens=value.filter(item=>typeof item==='string').map(item=>item.trim().toLowerCase());
    const npxIndex=tokens.findIndex(token=>/^npx(?:\.cmd)?$/i.test(token));
    assert.ok(npxIndex<0||!tokens.slice(npxIndex+1).some(token=>token===mcpPackageName||token.startsWith(`${mcpPackageName}@`)),`${label} contains split npx arguments`);
    value.forEach((item,index)=>assertNoRunnableMcpConfiguration(item,`${label}[${index}]`));
    return;
  }
  if(!value||typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)){
    assert.doesNotMatch(key,/^(?:command|cmd|executable|args|configuration|url|headers?|authorization|enabled)$/i,`${label}.${key} is a runnable MCP configuration field`);
    assertNoRunnableMcpConfiguration(child,`${label}.${key}`);
  }
}
test('match constructs an authenticated no-spend preview request',async()=>{let seen;const client=new AgoragenticClient({apiKey:'amk_test_placeholder',fetchImpl:async(url,init)=>{seen={url:String(url),init};return response(200,{providers:[]})}});assert.deepEqual(await client.match({task:'summarize public text',constraints:{max_cost:0}}),{providers:[]});assert.match(seen.url,/\/api\/execute\/match\?/);assert.match(seen.url,/max_cost=0/);assert.equal(seen.init.headers.Authorization,'Bearer amk_test_placeholder')});
test('missing key fails before network',async()=>{let called=false;const client=new AgoragenticClient({apiKey:'',fetchImpl:async()=>{called=true}});await assert.rejects(client.match({task:'x'}),e=>e.code==='missing_api_key');assert.equal(called,false)});
test('HTTP errors preserve retryability',async()=>{const client=new AgoragenticClient({apiKey:'amk_test_placeholder',fetchImpl:async()=>response(429,{error:{code:'rate_limited',message:'slow down'}})});await assert.rejects(client.quote({task:'x'}),e=>e instanceof AgoragenticOpenRouterError&&e.retryable&&e.status===429)});
test('paid execute timeout is outcome-unknown and never automatically retryable',async()=>{const client=new AgoragenticClient({apiKey:'amk_test_placeholder',timeoutMs:5,fetchImpl:async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});await assert.rejects(client.execute({task:'x',constraints:{max_cost:0.01}}),e=>e instanceof AgoragenticOpenRouterError&&e.code==='execute_outcome_unknown'&&e.retryable===false&&e.outcomeUnknown===true&&e.reconciliationRequired===true)});
test('paid execute server failure is outcome-unknown and never automatically retryable',async()=>{const client=new AgoragenticClient({apiKey:'amk_test_placeholder',fetchImpl:async()=>response(503,{error:{code:'temporarily_unavailable'}})});await assert.rejects(client.execute({task:'x',constraints:{max_cost:0.01}}),e=>e instanceof AgoragenticOpenRouterError&&e.retryable===false&&e.outcomeUnknown===true&&e.reconciliationRequired===true)});
test('read-only network failures remain retryable',async()=>{const client=new AgoragenticClient({apiKey:'amk_test_placeholder',fetchImpl:async()=>{throw new Error('offline')}});await assert.rejects(client.match({task:'x'}),e=>e instanceof AgoragenticOpenRouterError&&e.retryable===true&&e.outcomeUnknown===false)});
test('execute tool is approval-gated and safe example exposes match only after credential preflight',async()=>{const tools=await readFile(new URL('../openrouter-agent-sdk/src/agoragentic-tools.mjs',import.meta.url),'utf8');assert.match(tools,/name:\s*'agoragentic_execute'[\s\S]*?requireApproval:\s*true/);const example=await readFile(new URL('../openrouter-agent-sdk/examples/match-only.mjs',import.meta.url),'utf8');assert.match(example,/tools:\s*\[match\]/);assert.doesNotMatch(example,/tools:\s*\[[^\]]*execute/);const agoragenticPreflight=example.indexOf("if (!process.env.AGORAGENTIC_API_KEY)");const modelCall=example.indexOf('openrouter.callModel');assert.ok(agoragenticPreflight>=0&&agoragenticPreflight<modelCall)});
test('MCP host research is blocked and contains no runnable configuration',async()=>{await assert.rejects(readFile(new URL('../host-configs.json',import.meta.url),'utf8'),error=>error?.code==='ENOENT');const packet=JSON.parse(await readFile(blockedHostDecisionUrl,'utf8'));assert.equal(packet.group,'blocked_pending_qualified_host_enforcement');assert.equal(packet.runtime_verified,false);assert.equal(packet.authority_granted,false);assert.equal(packet.items.length,12);for(const [index,item] of packet.items.entries()){assert.equal(item.runtime_verified,false);assert.equal(item.authority_granted,false);assert.ok(Array.isArray(item.required_controls)&&item.required_controls.length>0);assertNoRunnableMcpConfiguration(item,`blocked host decision ${index}`)}});
test('Codebuff candidate deliberately omits execute',async()=>{const source=await readFile(new URL('../adapters/codebuff-tools.ts',import.meta.url),'utf8');assert.doesNotMatch(source,/toolName:\s*'agoragentic_execute'/)});
test('Oration creation has dual gate plus telephony and DND gates',async()=>{const source=await readFile(new URL('../adapters/oration-client.mjs',import.meta.url),'utf8');for(const required of ['ORATION_ENABLE_CREATE','ownerApproved','ORATION_ENABLE_TELEPHONY','ORATION_ALLOW_IGNORE_DND']) assert.ok(source.includes(required))});
test('Oration creation network failure is outcome-unknown and non-retryable',async()=>{const prior=process.env.ORATION_ENABLE_CREATE;process.env.ORATION_ENABLE_CREATE='true';try{const client=new OrationClient({token:'test-token',fetchImpl:async()=>{throw new Error('offline')}});await assert.rejects(client.createConversations({ownerApproved:true,conversations:[{conversationType:'chat'}]}),e=>e.code==='conversation_creation_outcome_unknown'&&e.retryable===false&&e.outcomeUnknown===true&&e.reconciliationRequired===true)}finally{if(prior===undefined)delete process.env.ORATION_ENABLE_CREATE;else process.env.ORATION_ENABLE_CREATE=prior}});
