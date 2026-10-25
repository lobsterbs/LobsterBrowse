/* Build ui first. Requires Playwright + Chromium, optionally configured by
   PLAYWRIGHT_MODULE and CHROMIUM_BIN. Run from any directory. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const ui=fileURLToPath(new URL('../../ui/',import.meta.url));
const vite=fileURLToPath(new URL('../../ui/node_modules/vite/bin/vite.js',import.meta.url));
const port=Number(process.env.LB_TEST_PORT||5178);
const base=`http://127.0.0.1:${port}`;
const content='https://content.test';
const server=spawn(process.execPath,[vite,'preview','--host','127.0.0.1','--port',String(port)],{cwd:ui,stdio:['ignore','pipe','inherit']});
await new Promise((resolve,reject)=>{server.stdout.on('data',chunk=>{if(String(chunk).includes('Local:'))resolve();});server.once('error',reject);server.once('exit',code=>reject(new Error('preview exited '+code)));});
let browser;
try {
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_BIN?{executablePath:process.env.CHROMIUM_BIN}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer']});
 const context=await browser.newContext({viewport:{width:1100,height:800},serviceWorkers:'block'});
 const page=await context.newPage();
 const direct=[];
 page.on('request',request=>{if(['one.test','two.test'].includes(new URL(request.url()).hostname))direct.push(request.url());});
 await page.route('**/build',route=>route.fulfill({json:{ok:true,lb:'test',zeolite:'test',contentOrigin:content,zlQueryRoutes:true}}));
 await page.addInitScript(()=>localStorage.setItem('lobsterbrowse-settings',JSON.stringify({suggestQueries:false,autoHideChrome:false})));
 await page.route(content+'/**',async route=>{
   const u=new URL(route.request().url());
   if(u.pathname==='/zlsw-register'){
     await route.fulfill({contentType:'text/html',body:`<!doctype html><script>
     window.iconFetches=[]; window.iconRequests=[];
     addEventListener('message',e=>{
       const d=e.data;
       if(d?.zlCfg){parent.postMessage({zlCfgAck:true,ok:true},e.origin);return;}
       if(!d?.zlQuery)return;
       const q=d.zlQuery;
       const send=r=>parent.postMessage({zlQueryReply:true,zlId:d.zlId,zlRes:r},e.origin);
       if(q.type==='zl:navHandle'){
         const dest=new URL(q.dest);
         send({ok:true,url:(dest.pathname.endsWith('.png')?'/icon':'/page')+'?which='+dest.hostname.split('.')[0]+'&zlNavh=opaque123456789'});
       } else if(q.type==='zl:decodeRoutes')send({ok:true,dests:['https://one.test/icon.png']});
       else if(q.type==='zl:fetchIcon'){
         const which=new URL(q.href).searchParams.get('which');
         iconFetches.push(which); iconRequests.push({which,id:d.zlId});
         const svg='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="'+(which==='one'?'red':'green')+'"/></svg>';
         setTimeout(()=>send({ok:true,mime:'image/svg+xml',bytes:new TextEncoder().encode(svg).buffer}),which==='one'?1200:20);
       } else send({ok:true});
     });
     parent.postMessage({zlReg:true,ok:true},'*');
     </script>`});
   } else {
     const which=u.searchParams.get('which')||'one';
     await route.fulfill({contentType:'text/html',body:`<!doctype html><title>${which}</title><p>${which} page</p><script>
       const data={url:'https://${which}.test/',title:'${which}',clientId:'client-${which}-123456',favicon:'https://${which}.test/icon.png'};
       setTimeout(()=>parent.postMessage({lb:'nav',data},'*'),20);
     </script>`});
   }
 });
 await page.goto(base);
 await page.locator('#lb-search-input').fill('https://one.test/');
 await page.locator('#lb-search-input').press('Enter');
 await page.locator('.lb-tb-name').filter({hasText:'one'}).waitFor();
 const boot=()=>page.frames().find(frame=>frame.url()===content+'/zlsw-register');
 await page.waitForFunction(()=>!!document.querySelector('iframe[title^="Proxy tab"]'));
 await assert.doesNotReject(async()=>{for(let i=0;i<40;i++){if((await boot().evaluate(()=>window.iconFetches)).includes('one'))return;await page.waitForTimeout(20);}throw new Error('content icon query was not sent');});
 /* A same-origin content page must not impersonate the boot frame's
    control-query reply even if it guesses a pending sequence number. */
 const requestId=await boot().evaluate(()=>window.iconRequests.find(r=>r.which==='one').id);
 const oneFrame=page.frames().find(frame=>frame.url().startsWith(content+'/page'));
 await oneFrame.evaluate(id=>parent.postMessage({zlQueryReply:true,zlId:id,zlRes:{ok:true,mime:'image/svg+xml',bytes:new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').buffer}},'*'),requestId);
 await page.waitForTimeout(100);
 assert.equal(await page.locator('.lb-tb-favicon').count(),0,'a page-forged boot reply must be ignored');
 await page.locator('.lb-tb-name').click();
 await page.locator('.lb-url-input').fill('https://two.test/');
 await page.locator('.lb-url-input').press('Enter');
 await page.locator('.lb-tb-name').filter({hasText:'two'}).waitFor();
 await page.locator('.lb-tb-favicon').waitFor();
 await page.waitForTimeout(1500);
 const icon=await page.locator('.lb-tb-favicon').getAttribute('src');
 assert.ok(icon.startsWith('blob:'),'toolbar must show a validated blob');
 const image=await page.evaluate(async href=>fetch(href).then(r=>r.text()),icon);
 assert.match(image,/fill="green"/,'late previous-document icon must not replace current icon');
 assert.deepEqual(direct,[],'app must never fetch an upstream icon directly');
 await boot().evaluate(()=>parent.postMessage({lb:'nav',data:{url:'https://spoof.test/',title:'spoof',clientId:'spoof-client-1234',favicon:''}},'*'));
 await page.waitForTimeout(50);
 assert.match(await page.locator('.lb-tb-name').textContent(),/two/,'unrelated same-origin frame metadata must be ignored');
 assert.ok((await boot().evaluate(()=>window.iconFetches)).includes('two'));
 console.log('favicons browser: split bridge, source-spoof rejection, actual image decode, no native upstream request and stale-document response passed');
} finally { await browser?.close();server.kill(); }
