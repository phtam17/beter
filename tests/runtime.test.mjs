import test from 'node:test';
import assert from 'node:assert/strict';
const {createRuntime}=await import('../server/runtime.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const unavailable=()=>{assert.equal(typeof createRuntime,'function','The application runtime must connect accounts, data and jobs.');return createRuntime({env:{NODE_ENV:'production'}});};
test('an unconfigured hosted deployment refuses startup before accepting traffic',async()=>{await assert.rejects(unavailable,/production.*configuration/i);});
test('live mode without an odds key cannot silently ingest sample prices',async()=>{assert.equal(typeof createRuntime,'function');const backend={rpc:async()=>[],authenticate:async()=>({id:'x'}),auth:async()=>({})};const runtime=await createRuntime({env:{BETER_DATA_MODE:'live'},backend});await assert.rejects(()=>runtime.runJobs(),/key|configur/i);});
