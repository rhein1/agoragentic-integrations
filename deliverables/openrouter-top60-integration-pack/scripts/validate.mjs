#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors=[]; const fail=(m)=>errors.push(m);
const readJson=async(rel)=>JSON.parse(await readFile(path.join(root,rel),'utf8'));
const index=await readJson('catalog/index.json');
if(index.schema!=='agoragentic.openrouter-top60-review-index.v1') fail('unexpected catalog index schema');
if(index.distribution_status!=='review_only'||index.runtime_verified!==false||index.catalog_inclusion_requested!==false||index.entry_count!==60) fail('review-only index boundary is invalid');
for(const [key,value] of Object.entries(index.authority||{})) if(value!==false) fail(`authority.${key} must be false`);
if(!Array.isArray(index.parts)||index.parts.length!==6) fail('catalog index must contain six parts');
const entries=[];
for(const part of index.parts||[]){const chunk=await readJson(part.path);if(!Array.isArray(chunk)||chunk.length!==part.count) fail(`${part.path} count mismatch`);entries.push(...chunk)}
if(entries.length!==60) fail('catalog must contain exactly 60 entries');
const ranks=new Set(), slugs=new Set();
for(const entry of entries){
 if(!Number.isInteger(entry.rank)||entry.rank<1||entry.rank>60||ranks.has(entry.rank)) fail(`invalid/duplicate rank ${entry.rank}`); ranks.add(entry.rank);
 if(!/^[a-z0-9][a-z0-9-]*$/.test(entry.slug||'')||slugs.has(entry.slug)) fail(`invalid/duplicate slug ${entry.slug}`); slugs.add(entry.slug);
 const target=path.resolve(root,entry.artifact||''); if(!target.startsWith(`${root}${path.sep}`)) fail(`${entry.slug} artifact escapes root`); else try{await stat(target)}catch{fail(`${entry.slug} artifact missing: ${entry.artifact}`)}
 for(const url of entry.sources||[]) if(!/^https:\/\//.test(url)) fail(`${entry.slug} source must be https`);
}
for(let rank=1;rank<=60;rank++) if(!ranks.has(rank)) fail(`missing rank ${rank}`);
const hosts=await readJson('host-configs.json'); if(hosts.hosts?.length!==12) fail('host-configs must contain 12 candidates');
const decisionFiles={covered_existing:'decisions/covered-existing.json',composition_recipe:'decisions/composition-recipes.json',provider_recipe:'decisions/provider-recipes.json',plugin_scaffold:'decisions/plugin-scaffolds.json',vendor_intake:'decisions/vendor-intakes.json',blocked_no_public_surface:'decisions/blocked.json',deprecated:'decisions/deprecated.json',needs_verification:'decisions/needs-verification.json'};
const expected={covered_existing:5,composition_recipe:9,provider_recipe:4,plugin_scaffold:4,vendor_intake:8,blocked_no_public_surface:10,deprecated:2,needs_verification:4};
for(const [group,rel] of Object.entries(decisionFiles)){const packet=await readJson(rel);if(packet.group!==group||packet.runtime_verified!==false||packet.authority_granted!==false) fail(`${rel} boundary invalid`);if(packet.items?.length!==expected[group]) fail(`${group} expected ${expected[group]}, got ${packet.items?.length}`)}
if(errors.length){for(const e of errors) console.error(`❌ ${e}`);process.exitCode=1}else console.log('✅ OpenRouter top-60 review pack validated: 60 decisions, 12 host candidates');
