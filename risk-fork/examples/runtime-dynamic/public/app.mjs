import {rehearse} from './agent.mjs';
const $=id=>document.getElementById(id);let status=null,last=null;
async function boot(){try{const r=await fetch('./api/status');if(r.ok)status=await r.json();}catch{}if(status?.mode==='local_reference_demo'){$('mode').textContent='Node / Risk Fork reference';$('disclosure').textContent='This server executes the real local-reference Risk Fork protocol. Fictional company data and mock purchase. Not production isolation. Dynamic signing is a separate owner-only command.';}}
await boot();
function node(tag,text,cls){const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x;}
function render(r){last=r;$('trace').replaceChildren();for(const e of r.events??[]){const li=node('li'),body=node('div');body.append(node('strong',e.phase),node('p',e.detail));li.append(node('span','','dot'),body);$('trace').append(li);}
 $('status').textContent=r.status==='completed'?'Completed — inspect evidence':r.status==='prepared'?'Prepared, not paid':'Blocked — no signing';
 const selected=r.decision??(r.selected?{provider:r.selected.name,units:r.selected.units}:null);
 $('decision').replaceChildren(node('span',r.status==='blocked'?'×':'↗','big-mark'),node('p',r.status==='blocked'?`Stopped: ${(r.reason??'unverified').replaceAll('_',' ')}.`:selected?`${selected.provider}: ${selected.units} demo units. The lowest-cost adequate source.`:'No selection.'));
 $('candidates').replaceChildren();for(const c of r.candidates??[]){const d=node('div',undefined,'candidate');d.append(node('span',c.name),node('span',`${c.units} units · ${c.age}d`),node('span',c.reason.replaceAll('_',' ')));$('candidates').append(d);}
 $('brief').replaceChildren();$('brief').hidden=!r.brief;if(r.brief){const b=r.brief,ul=node('ul');for(const f of b.facts)ul.append(node('li',f));$('brief').append(node('h4',b.title),node('p',`${b.company} · ${b.source}`),ul,node('p',b.conclusion),node('p',b.provenance??'Synthetic first-party report service.'));}
 $('download').disabled=false;
}
$('form').addEventListener('submit',async e=>{e.preventDefault();$('run').disabled=true;$('status').textContent='Inspecting sources…';
 const input={goal:$('goal').value,budget:Number($('budget').value),scenario:$('scenario').value};
 try{let r;if(status?.mode==='local_reference_demo'){const response=await fetch('./api/run',{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Token':status.token},body:JSON.stringify(input)});r=await response.json();if(!response.ok)throw new Error('reference_run_failed');}else{r=rehearse(input);}render(r);}catch{$('status').textContent='Run failed — no wallet action';}finally{$('run').disabled=false;}});
$('download').addEventListener('click',()=>{if(!last)return;const url=URL.createObjectURL(new Blob([JSON.stringify(last,null,2)],{type:'application/json'}));const a=node('a');a.href=url;a.download='agoragentic-demo-evidence.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
