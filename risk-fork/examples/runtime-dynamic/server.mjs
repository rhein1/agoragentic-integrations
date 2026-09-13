import http from 'node:http'; import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url'; import {randomBytes,timingSafeEqual} from 'node:crypto';
import {prepareAgent,finishPreview} from './core.mjs';
const files=new Map([['/','index.html'],['/index.html','index.html'],['/app.mjs','app.mjs'],['/agent.mjs','agent.mjs'],['/style.css','style.css'],['/presentation.html','presentation.html'],['/presentation.css','presentation.css']]);
const publicDir=new URL('./public/',import.meta.url); let active=false;
export function startServer({port=8787,host='127.0.0.1',inspect,staticOnly=false}={}) {
  const token=randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const json=(code,x)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(x));};
    const requestHost=req.headers.host??'';
    if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(requestHost))return json(403,{error:'invalid_host'});
    if(req.url==='/api/status'&&req.method==='GET')return json(200,{mode:staticOnly?'static_rehearsal':'local_reference_demo',dynamic_contacted:false,production_ready:false,token});
    if(req.url==='/api/run'&&req.method==='POST'){
      if(staticOnly)return json(503,{error:'reference_runtime_not_loaded'});
      if(req.headers.origin!==`http://${requestHost}`)return json(403,{error:'origin_required'});
      const supplied=Buffer.from(String(req.headers['x-demo-token']??'')),expected=Buffer.from(token);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return json(403,{error:'token_required'});
      if(!String(req.headers['content-type']??'').startsWith('application/json'))return json(415,{error:'json_required'});
      if(active)return json(409,{error:'run_already_active'});active=true;
      try {
        let n=0;const chunks=[];
        for await(const c of req){n+=c.length;if(n>2048)throw new Error('body_too_large');chunks.push(c);}
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const result=finishPreview(await prepareAgent(input,{inspect}));json(200,result);
      } catch {json(400,{error:'request_or_reference_run_failed'});}finally{active=false;}
      return;
    }
    if(req.method!=='GET'||!files.has(req.url))return json(404,{error:'not_found'});
    const file=files.get(req.url);try{const body=await readFile(new URL(file,publicDir));res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.mjs')?'text/javascript':'text/html; charset=utf-8'});res.end(body);}catch{json(404,{error:'not_found'});}
  });
  server.requestTimeout=15000;server.headersTimeout=5000;server.maxHeadersCount=30;
  server.listen(port,host);return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const staticOnly=process.argv.includes('--static');
  const inspect=staticOnly?null:(await import('./risk-fork.mjs')).inspectSource;
  const port=Number(process.env.PORT??8787);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('invalid_port');
  const server=startServer({port,inspect,staticOnly});
  console.log(`Agoragentic demo: http://127.0.0.1:${port} (${staticOnly?'browser rehearsal':'real local-reference Risk Fork'}; no Dynamic actions)`);
  process.on('SIGINT',()=>server.close(()=>process.exit(0)));
}
