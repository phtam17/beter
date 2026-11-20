import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiHandler} from '../server/api.ts';
import {createAuthLimiter} from '../server/abuse.ts';
import {runOperatorCli} from '../scripts/ops.mjs';
const secret='private-aws-test-secret-'.repeat(3);
const request=body=>new Request('https://beter.example/api/auth/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
test('Cognito recovery confirmation validates and normalizes before protected auth dispatch',async()=>{
 const calls=[];const limits=[];const backend={authenticate:async()=>{throw Error('must be anonymous');},rpc:async()=>[],auth:async(...args)=>{calls.push(args);return{message:'Password updated.'};}};
 const handle=createApiHandler({backend,config:{mode:'aws',dataMode:'sample',liveOddsConfigured:false},authLimit:async(...args)=>{limits.push(args);return{allowed:true};}});
 const valid={email:'Person@Example.com',code:'123456',password:'a-long-new-password'};
 const response=await handle(request(valid));assert.equal(response.status,200);assert.equal(calls[0][0],'confirm');assert.deepEqual(calls[0][1],{...valid,email:'person@example.com'});assert.equal(limits[0][1],'confirm');
 for(const body of [{...valid,email:'invalid'},{...valid,code:123456},{...valid,code:'12345a'},{...valid,code:'１２３４５６'},{...valid,password:'short'},{...valid,password:'x'.repeat(201)}])assert.equal((await handle(request(body))).status,400);
 assert.equal(calls.length,1);assert.equal(limits.length,1);
});
test('Cognito confirmation preserves shared throttle retry time and safe provider failures',async()=>{
 let called=0;const backend={authenticate:async()=>({id:'x'}),rpc:async()=>[],auth:async()=>{called++;throw Error('private provider detail');}};
 const options={backend,config:{mode:'aws',dataMode:'sample',liveOddsConfigured:false}};
 const body={email:'person@example.com',code:'123456',password:'a-long-new-password'};
 const denied=await createApiHandler({...options,authLimit:async()=>({allowed:false,retryAfterSeconds:88})})(request(body));assert.equal(denied.status,429);assert.equal(denied.headers.get('retry-after'),'88');assert.equal(called,0);
 const failed=await createApiHandler({...options,onDiagnostic:()=>{}})(request(body));assert.equal(failed.status,500);assert.doesNotMatch(await failed.text(),/private provider/);
});
test('AWS shared authentication limits use only the adapter-minted source address',async()=>{
 const calls=[];const backend={rpc:async(...args)=>{calls.push(args);return{allowed:true,retry_after_seconds:0};}};
 const invoke=createAuthLimiter({backend,secret,trustProxy:'aws'});
 const req=headers=>new Request('https://beter.example',{headers});
 await invoke(req({'x-forwarded-for':'203.0.113.2'}),'confirm','person@example.com');assert.equal(calls.at(-1)[1].p_buckets.length,2);
 await invoke(req({'x-forwarded-for':'203.0.113.2','x-beter-source-ip':'198.51.100.7'}),'confirm','person@example.com');const minted=calls.at(-1)[1].p_buckets.find(x=>x.kind==='source').key;
 await invoke(req({'x-forwarded-for':'203.0.113.99','x-beter-source-ip':'198.51.100.7'}),'confirm','person@example.com');assert.equal(calls.at(-1)[1].p_buckets.find(x=>x.kind==='source').key,minted);
 assert.doesNotMatch(JSON.stringify(calls),/198\.51|203\.0|person@/);
});
test('operator checks pass the private staging gate independently of the worker credential',async()=>{
 const output=[];let headers;
 const result=await runOperatorCli(['check'],{env:{BETER_OPS_URL:'https://beter.example',JOB_SECRET:secret,BETER_STAGING_ACCESS:'Basic cHJpdmF0ZS1nYXRl'},fetchImpl:async(url,init)=>{headers=new Headers(init.headers);return Response.json({ready:true,checks:[{name:'database',ok:true,code:'HEALTH_AVAILABLE'}]});},writeOutput:x=>output.push(x)});
 assert.equal(result,0);assert.equal(headers.get('x-beter-staging-access'),'Basic cHJpdmF0ZS1nYXRl');assert.equal(headers.get('authorization'),'Bearer '+secret);assert.doesNotMatch(output.join(''),/cHJpdmF0|private-aws/);
});
