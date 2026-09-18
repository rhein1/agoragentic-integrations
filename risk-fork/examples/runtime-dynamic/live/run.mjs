import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {authorize,dispatchOnce} from './authorization.mjs';import {sha,freeze} from '../core.mjs';
import {composeBrief,CATALOG} from '../public/agent.mjs';
function readSafe(file,secret=false){
 const abs=path.resolve(file);if(!path.isAbsolute(file))throw new Error('absolute_paths_required');
 const fd=fs.openSync(abs,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.size>262144||(secret&&(s.mode&0o077)))throw new Error('unsafe_file');
 const b=Buffer.alloc(s.size);let n=0;while(n<b.length){const x=fs.readSync(fd,b,n,b.length-n,null);if(!x)throw new Error('short_read');n+=x;}
 return JSON.parse(b.toString('utf8'));}finally{fs.closeSync(fd);}
}
const [planPath,approvalPath,secretPath,stateDir]=process.argv.slice(2);
if(!planPath||!approvalPath||!secretPath||!stateDir||process.argv.length!==6)throw new Error('usage: run.mjs /plan /approval /secret /state-directory');
if(process.env.RUNTIME_DYNAMIC_LIVE!=='owner-approved-base-sepolia-demo')throw new Error('live_disabled');
if(!['linux','darwin'].includes(process.platform))throw new Error('use_supported_linux_or_macos_not_native_windows');
const plan=readSafe(planPath),approval=readSafe(approvalPath),transfer=authorize(plan,approval);
const repo=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(approval.reviewed_head!==head||approval.hosted_ci_passed!==true||!/^https:\/\/github\.com\/rhein1\/agoragentic-integrations\/actions\/runs\/\d+$/.test(approval.ci_run_url??''))throw new Error('exact_head_review_and_hosted_ci_required');
if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim())throw new Error('clean_reviewed_checkout_required');
for(const p of [secretPath,stateDir]){const r=path.relative(repo,path.resolve(p));if(r===''||(!r.startsWith('..'+path.sep)&&!path.isAbsolute(r)))throw new Error('secret_and_state_must_be_outside_repo');}
const stat=fs.lstatSync(stateDir);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077))throw new Error('private_state_directory_required');
// Require a reviewed lockfile. This task does not invent registry integrity or claim an install occurred.
if(!fs.existsSync(new URL('./package-lock.json',import.meta.url)))throw new Error('reviewed_live_dependency_lock_required');
let claimed=false;
const result=await dispatchOnce(plan,approval,{
 reloadPolicy:()=>readSafe(approvalPath),
 claim:async()=>{try{const fd=fs.openSync(path.join(stateDir,transfer.plan_hash.slice(7)+'.claim'),'wx',0o600);fs.writeFileSync(fd,JSON.stringify({head,plan_hash:transfer.plan_hash,state:'claimed_no_retry'}));fs.fsyncSync(fd);fs.closeSync(fd);claimed=true;return true;}catch(e){if(e.code==='EEXIST')return false;throw e;}},
 action:async fixed=>{
   const secret=readSafe(secretPath,true);
   const {createDynamicAction}=await import('./dynamic-action.mjs');
   const action=await createDynamicAction(secret);
   const assertCurrent=()=>{const current=readSafe(approvalPath);if(sha(current)!==fixed.approval_hash)throw new Error('approval_changed');authorize(plan,current);};
   const evidence=await action(freeze({...fixed,assertCurrent}));
   return evidence;
 }
});
const receipt={schema:'agoragentic.runtime-live-demo-receipt.v1',plan_hash:sha(plan),head,claimed,
 ...result,brief:result.status==='confirmed_testnet'?composeBrief(plan.proposal.goal,CATALOG.find(x=>x.id===plan.proposal.provider_id)):null,
 source:'First-party synthetic report service; the testnet transfer is real only when independently confirmed.',
 risk_fork:'local_reference_protocol_only_not_production_containment'};
const output=path.join(stateDir,transfer.plan_hash.slice(7)+'.receipt.json');fs.writeFileSync(output,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:receipt.status,receipt:output,transaction_hash:receipt.transaction_hash??null,automatic_retry:false},null,2));
