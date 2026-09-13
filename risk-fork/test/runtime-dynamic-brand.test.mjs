import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=new URL('../examples/runtime-dynamic/',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
test('Runtime branding uses Agoragentic palette and original mark treatment',()=>{
 const css=read('public/style.css'),html=read('public/index.html');
 for(const token of ['#0c1222','#e8613a','#f5f1e9','Space Grotesk','Inter','JetBrains Mono'])assert.ok(css.includes(token),token);
 assert.ok(html.includes('site-nav-mark'));assert.ok(html.includes('agora<span>gentic</span>'));
 assert.ok(!/Georgia|#bcdec6|#14231f|letter-spacing:\s*-|font-size:[^;}]*vw/i.test(css));
});
test('Public demo names simulation and does not import a wallet SDK',()=>{
 const html=read('public/index.html'),app=read('public/app.mjs');
 assert.ok(html.includes('Browser rehearsal'));assert.ok(html.includes('Dynamic calls:'));
 assert.ok(html.includes('No Risk Fork backend execution'));assert.ok(html.includes('deterministic'));
 assert.ok(!app.includes('@dynamic-labs'));assert.ok(app.includes('127.0.0.1'));
});
test('Presenter guide and slides disclose unqualified wallet and actual reference limits',()=>{
 const guide=read('public/presenter.html'),slides=read('public/presentation.html');
 assert.ok(guide.includes('runtime-dynamic-reference.test.mjs'));
 assert.ok(guide.includes('Revoked, tampered, unknown cleanup'));
 assert.ok(slides.includes('provider execution remain unqualified'));
 assert.equal((slides.match(/class="slide /g)||[]).length,8);
});
test('Loopback server exposes presentation assets without adding a wallet route',()=>{
 const server=read('server.mjs');
 for(const file of ['presenter.html','presenter.css','presentation.mjs'])assert.ok(server.includes(file));
 assert.ok(!/api\/(pay|sign|wallet)/.test(server));assert.ok(server.includes("host='127.0.0.1'"));
});
