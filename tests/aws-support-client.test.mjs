import test from 'node:test';
import assert from 'node:assert/strict';
import {sendSupportRequest} from '../dist/support.js';
const payload={email:'reader@example.test',topic:'general',message:'Please explain my virtual practice history.'},reference='BTR-12345678-1234-4234-8234-123456789abc';
test('standalone support sends only same-origin JSON and accepts an explicit 202 reference',async()=>{
 let call;const result=await sendSupportRequest(payload,{fetchImpl:async(url,options)=>{call={url,options};return Response.json({accepted:true,reference},{status:202});}});assert.deepEqual(result,{ok:true,reference});assert.equal(call.url,'/api/support');assert.equal(call.options.method,'POST');assert.equal(call.options.credentials,'same-origin');assert.equal(call.options.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(call.options.body),payload);assert.ok(call.options.signal instanceof AbortSignal);
});
test('support never mistakes another status malformed response or untrusted text for acceptance',async()=>{
 for(const [status,body] of [[200,{accepted:true,reference}],[202,{accepted:false,reference}],[202,{accepted:true,reference:'<script>PRIVATE_SERVER_VALUE</script>'}],[500,{error:{message:'PRIVATE_SERVER_VALUE'}}]]){const result=await sendSupportRequest(payload,{fetchImpl:async()=>Response.json(body,{status})});assert.equal(result.ok,false);assert.doesNotMatch(result.message,/PRIVATE_SERVER_VALUE|<script>/);}
 const invalid=await sendSupportRequest(payload,{fetchImpl:async()=>new Response('PRIVATE_INVALID_JSON',{status:202})});assert.equal(invalid.ok,false);assert.doesNotMatch(invalid.message,/PRIVATE_INVALID_JSON/);
});
test('rate limits validation and network failures preserve a truthful retry message',async()=>{
 for(const status of [400,413,429]){const result=await sendSupportRequest(payload,{fetchImpl:async()=>Response.json({error:{}},{status})});assert.equal(result.ok,false);assert.match(result.message,status===429?/wait/i:/check.*email|shorten/i);}
 const failed=await sendSupportRequest(payload,{fetchImpl:async()=>{throw Error('PRIVATE_NETWORK_DETAIL');}});assert.equal(failed.ok,false);assert.match(failed.message,/not been confirmed/);assert.doesNotMatch(failed.message,/PRIVATE_NETWORK_DETAIL/);
});
