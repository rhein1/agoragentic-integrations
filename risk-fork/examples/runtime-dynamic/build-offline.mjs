import {readFile,writeFile} from 'node:fs/promises';
const dir=new URL('./public/',import.meta.url);
const read=n=>readFile(new URL(n,dir),'utf8');
let html=await read('index.html');
html=html.replace('<link rel="stylesheet" href="./style.css">','<style>'+await read('style.css')+'</style>').replace('<script type="module" src="./app.mjs"></script>','');
const agent=(await read('agent.mjs')).replaceAll('export ','');
const app=(await read('app.mjs')).replace("import {rehearse} from './agent.mjs';\n",'').replace('await boot();','');
html=html.replace('</body>','<script>(async()=>{\n'+agent+'\n'+app+'\n})();</script></body>').replace('href="./presentation.html"','href="#boundaries"');
await writeFile(process.argv[2]??'Agoragentic_Risk_Fork_Demo.html',html,{flag:'wx'});
