import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {nodeHandler} from '../server/http.ts';
const {createWebHandler}=await import('../server/http.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const handler=()=>{assert.equal(typeof createWebHandler,'function','The web server must expose static assets and the account API.');return createWebHandler({root:new URL('../dist',import.meta.url).pathname,api:async()=>Response.json({ok:true})});};
test('the application is served with content security and MIME headers',async()=>{const res=await handler()(new Request('http://localhost/'));assert.equal(res.status,200);assert.match(res.headers.get('Content-Type'),/text\/html/);assert.match(res.headers.get('Content-Security-Policy'),/script-src 'self'/);assert.match(await res.text(),/Beter/);});
test('the API is delegated without serving filesystem data',async()=>{const res=await handler()(new Request('http://localhost/api/config'));assert.deepEqual(await res.json(),{ok:true});});
test('missing assets and traversal are rejected',async()=>{assert.equal((await handler()(new Request('http://localhost/missing.js'))).status,404);assert.equal((await handler()(new Request('http://localhost/%2e%2e%2fpackage.json'))).status,403);});
test('HEAD serves asset headers without its body and unsafe static methods are refused',async()=>{const res=await handler()(new Request('http://localhost/app.js',{method:'HEAD'}));assert.equal(res.status,200);assert.equal(await res.text(),'');assert.equal((await handler()(new Request('http://localhost/',{method:'POST',body:'x'}))).status,405);});
test('Node transport admits bounded operator evidence and keeps public body limits',async()=>{
  for(const [url,bytes,status] of [['/api/ops/resolve',40000,200],['/api/ops/resolve',1048577,413],['/api/quotes',40000,413]]){
    const input=Readable.from([Buffer.alloc(bytes,32)]);Object.assign(input,{url,method:'POST',headers:{host:'localhost'}});let actual;const output={writeHead(code){actual=code;},end(){}};await nodeHandler(async()=>Response.json({ok:true}))(input,output);assert.equal(actual,status);
  }
});
