import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthLimiter} from '../server/abuse.ts';
const {createAwsSupportHandler}=await import('../server/aws-support.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const secret='support-fixture-private-session-secret-over-thirty-two',siteUrl='https://beter.example';
function fixture(options={}){
 assert.equal(typeof createAwsSupportHandler,'function','The AWS support wrapper must exist.');const calls=[],sent=[],delegated=[],counts=new Map();
 const backend={rpc:async(name,args,role)=>{calls.push({name,args,role});for(const bucket of args.p_buckets){const key=bucket.kind+':'+bucket.key,count=(counts.get(key)||0)+1;counts.set(key,count);if(bucket.kind==='recovery'&&count>3)return{allowed:false,retry_after_seconds:3600};}return{allowed:true,retry_after_seconds:0};}};
 const handle=createAwsSupportHandler({handle:async request=>{delegated.push(request);return new Response('delegated',{status:404});},backend,secret,siteUrl,trustProxy:'aws',sendSupport:async value=>{sent.push(value);},...options});return{handle,calls,sent,delegated,backend};
}
const payload={email:' Owner@Example.Test ',topic:'general',message:'Please help me understand my virtual practice history.'};
function request(handle,{method='POST',path='/api/support',origin=siteUrl,contentType='application/json',body=JSON.stringify(payload),headers={}}={}){return handle(new Request(siteUrl+path,{method,headers:{...(origin?{Origin:origin}:{}),...(contentType?{'Content-Type':contentType}:{}),'x-beter-source-ip':'203.0.113.7','x-forwarded-for':'forged',...headers},...(!['GET','HEAD'].includes(method)?{body}:{})}));}
test('support sends normalized plain data and accepts only after the sender succeeds',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});const sent=[];const f=fixture({sendSupport:async value=>{sent.push(value);await pending;}});let resolved=false;const response=request(f.handle).then(value=>{resolved=true;return value;});await new Promise(resolve=>setImmediate(resolve));assert.equal(resolved,false);assert.equal(sent.length,1);assert.equal(sent[0].email,'owner@example.test');assert.equal(sent[0].topic,'general');assert.equal(sent[0].message,payload.message);assert.match(sent[0].reference,/^BTR-[a-f0-9-]{36}$/);release();const accepted=await response;assert.equal(accepted.status,202);const value=await accepted.json();assert.equal(value.accepted,true);assert.equal(value.reference,sent[0].reference);assert.doesNotMatch(JSON.stringify(value),/owner@|understand my|private-session/);assert.equal(accepted.headers.get('cache-control'),'no-store');
});
test('the wrapper delegates every path or method outside POST support without consuming a budget',async()=>{
 const f=fixture();for(const options of [{path:'/api/portfolio'},{method:'GET'},{method:'OPTIONS'},{path:'/api/support/extra'}])assert.equal((await request(f.handle,options)).status,404);assert.equal(f.delegated.length,4);assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});
test('support requires exact same-site origin and JSON before parsing or rate limiting',async()=>{
 const f=fixture();for(const origin of ['', 'null','https://other.example',siteUrl+'/'])assert.equal((await request(f.handle,{origin})).status,403);for(const contentType of ['', 'text/plain','application/x-www-form-urlencoded'])assert.equal((await request(f.handle,{contentType})).status,415);assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);assert.equal((await request(f.handle,{contentType:'application/json; charset=utf-8'})).status,202);
});
test('support validates email topic and bounded message data without exposing rejected payloads',async()=>{
 const f=fixture();for(const body of ['{not-json','null','[]',JSON.stringify({...payload,email:'invalid'}),JSON.stringify({...payload,email:'a'.repeat(250)+'@example.test'}),JSON.stringify({...payload,topic:'other'}),JSON.stringify({...payload,message:'short'}),JSON.stringify({...payload,message:'a'.repeat(4001)}),JSON.stringify({...payload,message:42})]){const response=await request(f.handle,{body});assert.equal(response.status,400);assert.doesNotMatch(await response.text(),/Owner@|not-json|aaaaaaa/);}assert.equal(f.sent.length,0);assert.equal(f.calls.length,0);
});
test('support enforces eight KiB on actual bytes and an oversized declared length',async()=>{
 const f=fixture();for(const options of [{body:JSON.stringify({...payload,message:'界'.repeat(3000)})},{headers:{'Content-Length':'8193'}}])assert.equal((await request(f.handle,options)).status,413);assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});
test('all supported request topics reach the sender with a different reference and no automatic deletion',async()=>{
 const f=fixture();for(const topic of ['general','privacy','delete-account'])assert.equal((await request(f.handle,{body:JSON.stringify({...payload,topic})})).status,202);assert.deepEqual(f.sent.map(value=>value.topic),['general','privacy','delete-account']);assert.equal(new Set(f.sent.map(value=>value.reference)).size,3);assert.ok(f.calls.every(call=>call.name==='beter_auth_limit'&&call.role==='$service'));
});
test('support budgets are durable per identity and independent from authentication budgets',async()=>{
 const f=fixture();for(let attempt=0;attempt<3;attempt++)assert.equal((await request(f.handle)).status,202);const limited=await request(f.handle);assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'3600');assert.equal(f.sent.length,3);const supportBuckets=f.calls[0].args.p_buckets;
 await createAuthLimiter({backend:f.backend,secret,trustProxy:'aws'})(new Request(siteUrl,{headers:{'x-beter-source-ip':'203.0.113.7'}}),'recover','owner@example.test');const authBuckets=f.calls.at(-1).args.p_buckets;assert.ok(supportBuckets.every(bucket=>authBuckets.every(other=>bucket.key!==other.key)));assert.deepEqual(supportBuckets.map(bucket=>bucket.kind),['global','recovery','source']);assert.doesNotMatch(JSON.stringify(f.calls),/owner@example|203\.0\.113|forged|private-session/);
});
test('quota or sender failures are safe and never produce a false acceptance',async()=>{
 const failing=fixture({sendSupport:async()=>{throw new Error('SNS_PRIVATE arn:aws:fixture owner@example.test');}});const response=await request(failing.handle);assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/SNS_PRIVATE|arn:aws|owner@example/);
 const quota=fixture({backend:{rpc:async()=>{throw new Error('DATABASE_PRIVATE');}}});const unavailable=await request(quota.handle);assert.equal(unavailable.status,503);assert.equal(quota.sent.length,0);assert.doesNotMatch(await unavailable.text(),/DATABASE_PRIVATE/);
});
test('support rejects weak setup secrets and malformed canonical origins before serving requests',()=>{
 for(const options of [{secret:'short'},{siteUrl:'https://beter.example/path'},{siteUrl:'https://user:password@beter.example'},{siteUrl:'http://beter.example'}])assert.throws(()=>fixture(options),/support.*config|private secret|origin/i);
});
