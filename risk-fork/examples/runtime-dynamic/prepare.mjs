import {writeFile} from 'node:fs/promises';
import {prepareAgent,sha} from './core.mjs';import {inspectSource} from './risk-fork.mjs';
const args=process.argv.slice(2);const [goal='current',budget='6',scenario='clean',output='runtime-plan.json']=args;
if(args.length>4)throw new Error('usage: prepare.mjs current 6 clean /path/to/plan.json');
// This process must never receive signer credentials, even though the reference child is not a security boundary.
if(Object.keys(process.env).some(k=>/^(DYNAMIC_|WALLET_|RUNTIME_SECRET)/.test(k)))throw new Error('remove_signer_credentials_from_prepare_environment');
const plan=await prepareAgent({goal,budget:Number(budget),scenario},{inspect:inspectSource});
await writeFile(output,JSON.stringify(plan,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:plan.status,plan_hash:sha(plan),proposal_hash:plan.proposal_hash??null,output,
  next:'Review the plan. Live signing is a separate owner-authorized process, not this command.'},null,2));
