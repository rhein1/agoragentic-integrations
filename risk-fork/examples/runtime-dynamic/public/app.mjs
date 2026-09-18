import {rehearse} from './agent.mjs';
const $ = id => document.getElementById(id);
let runtime = null, last = null;
async function boot() {
  if (!['127.0.0.1', 'localhost'].includes(location.hostname) || location.protocol === 'file:') return;
  try { const r = await fetch('./api/status'); if (r.ok) runtime = await r.json(); } catch {}
  if (runtime?.mode === 'local_reference_demo') {
    $('mode').textContent = 'Node / local-reference Risk Fork';
    $('disclosure').textContent = 'This server uses the real Risk Fork local-reference APIs. Fictional company data and mock purchase. Not production OS isolation. No Dynamic wallet action from this page.';
    $('fork-state').textContent = 'ready for reference run';
  }
}
function el(tag, text, className) { const x=document.createElement(tag); if(text!==undefined)x.textContent=text; if(className)x.className=className; return x; }
function render(r) {
  last=r; $('trace').replaceChildren();
  for (const e of r.events??[]) {const li=el('li'),body=el('div');li.dataset.phase=e.phase;body.append(el('strong',e.phase),el('p',e.detail));li.append(el('span','','dot'),body);$('trace').append(li);}
  $('status').textContent = r.status==='completed'?'Completed · no payment':r.status==='prepared'?'Prepared · not paid':'Blocked · no signing';
  const selected=r.decision??(r.selected?{provider:r.selected.name,units:r.selected.units}:null);
  $('decision').replaceChildren(el('span',r.status==='blocked'?'×':'↗','big-mark'),el('p',r.status==='blocked'?`Stopped: ${(r.reason??'unverified').replaceAll('_',' ')}.`:selected?`${selected.provider}: ${selected.units} demo units. Lowest cost among sources that meet the task.`:'No selection.'));
  $('candidates').replaceChildren();
  for(const c of r.candidates??[]) {const d=el('div',undefined,'candidate');d.append(el('span',c.name),el('span',`${c.units} units · ${c.age}d`),el('span',c.reason.replaceAll('_',' ')));$('candidates').append(d);}
  $('brief').replaceChildren();$('brief').hidden=!r.brief;
  if(r.brief){const b=r.brief,ul=el('ul');for(const f of b.facts)ul.append(el('li',f));$('brief').append(el('h4',b.title),el('p',`${b.company} · ${b.source}`),ul,el('p',b.conclusion),el('p',b.provenance??'Synthetic first-party report service.'));}
  $('fork-state').textContent = r.evidence?.risk_fork_executed===true?'reference run reported':'illustrated only';
  $('download').disabled=false;
}
async function run() {
  if($('run').disabled)return;
  $('run').disabled=true;$('status').textContent='Inspecting sources…';
  try {
    const input={goal:$('goal').value,budget:Number($('budget').value),scenario:$('scenario').value};
    let r;
    if(runtime?.mode==='local_reference_demo') {
      const response=await fetch('./api/run',{method:'POST',headers:{'Content-Type':'application/json','X-Demo-Token':runtime.token},body:JSON.stringify(input)});
      r=await response.json();if(!response.ok)throw new Error('reference_run_failed');
    } else { r=rehearse(input); }
    render(r);
  } catch {last=null;$('download').disabled=true;$('brief').hidden=true;$('status').textContent='Run failed · no wallet action';}
  finally {$('run').disabled=false;}
}
$('form').addEventListener('submit',e=>{e.preventDefault();run();});
for(const button of document.querySelectorAll('[data-preset]')) button.addEventListener('click',()=>{
  const mode=button.dataset.preset;$('goal').value=mode==='overview'?'overview':'current';$('budget').value='6';$('scenario').value=['attack','revoked'].includes(mode)?mode:'clean';run();
});
$('download').addEventListener('click',()=>{if(!last)return;const url=URL.createObjectURL(new Blob([JSON.stringify(last,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download='agoragentic-demo-evidence.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
await boot();
