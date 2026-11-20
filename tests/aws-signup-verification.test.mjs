import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiHandler} from '../server/api.ts';
import {createAuthLimiter} from '../server/abuse.ts';
import {createApiClient} from '../dist/api-client.js';
const email='verify@example.test',code='012345';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function apiFixture(options={}){
  const calls=[],limits=[];
  const backend={authenticate:async()=>{throw Error('Anonymous verification must not require a session');},rpc:async()=>({}),auth:async(action,body)=>{calls.push({action,body});return action==='resend'?{message:'Check your email.'}:{ok:true};}};
  const handle=createApiHandler({backend,config:{mode:'aws',dataMode:'sample'},authLimit:async(request,action,email)=>{limits.push({action,email});return{allowed:true};},...options});
  const post=(action,body)=>handle(new Request('https://beter.example/api/auth/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  return{calls,limits,post};
}
test('anonymous verify and resend normalize email, do not require a password, and use the shared limiter',async()=>{
  const f=apiFixture();for(const action of ['verify','resend']){const response=await f.post(action,{email:' '+email.toUpperCase()+' ',...(action==='verify'?{code}:{})});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');}
  assert.deepEqual(f.calls,[{action:'verify',body:{email,code}},{action:'resend',body:{email}}]);assert.deepEqual(f.limits,[{action:'verify',email},{action:'resend',email}]);
});
test('real browser-cookie signup transport preserves code confirmation method without issuing a cookie or session',async()=>{
  const handle=createApiHandler({backend:{authenticate:async()=>{throw Error('must not authenticate');},rpc:async()=>({}),auth:async()=>({session:null,requiresConfirmation:true,confirmationMethod:'code'})},config:{mode:'aws',dataMode:'sample',sessionSecret:'a-private-browser-envelope-key-1234567890'}});
  const response=await handle(new Request('https://beter.example/api/auth/signup',{method:'POST',headers:{origin:'https://beter.example','x-beter-client':'browser','content-type':'application/json'},body:JSON.stringify({email,password:'a-long-signup-password'})}));
  assert.equal(response.status,201);assert.equal(response.headers.get('set-cookie'),null);assert.deepEqual(await response.json(),{session:null,requiresConfirmation:true,confirmationMethod:'code'});
});
test('verification rejects invalid codes or email before contacting the limiter/provider',async()=>{
  const f=apiFixture();for(const body of [{email,code:'12345'},{email,code:'1234567'},{email,code:123456},{email:'bad',code}])assert.equal((await f.post('verify',body)).status,400);assert.equal(f.calls.length,0);assert.equal(f.limits.length,0);
});
test('signup verification and resend fail closed on limiter denial or outage',async()=>{
  for(const action of ['verify','resend']){for(const outage of [false,true]){const f=apiFixture({authLimit:async()=>{if(outage)throw Error('private');return{allowed:false,retryAfterSeconds:90};}});const response=await f.post(action,{email,code});assert.equal(response.status,outage?503:429);assert.equal(f.calls.length,0);assert.doesNotMatch(await response.text(),/private/);}}
});
test('resend shares the three-attempt recovery bucket with password recovery',async()=>{
  const calls=[],limit=createAuthLimiter({secret:'a-private-limiter-key-with-32-characters',backend:{rpc:async(name,args)=>{calls.push(args.p_buckets);return{allowed:true,retry_after_seconds:0};}}});
  const request=new Request('https://beter.example/api/auth/resend');await limit(request,'resend',email);await limit(request,'recover',email);assert.deepEqual(calls[0],calls[1]);assert.ok(calls[0].some(bucket=>bucket.kind==='recovery'));
});
test('client preserves code confirmation method and sends verification/resend without credentials or persisted codes',async()=>{
  const writes=[],calls=[];const client=createApiClient({storage:{getItem:()=>null,removeItem(){},setItem:(...args)=>writes.push(args)},fetchImpl:async(url,init)=>{calls.push({url,init});return json(url.endsWith('/signup')?{session:null,requiresConfirmation:true,confirmationMethod:'code'}:{ok:true});}});
  assert.equal((await client.signup(email,'a-long-test-password')).confirmationMethod,'code');assert.equal(typeof client.verifySignup,'function');assert.equal(typeof client.resendSignupConfirmation,'function');
  await client.verifySignup(email,code);await client.resendSignupConfirmation(email);assert.deepEqual(calls.slice(1).map(call=>({url:call.url,body:JSON.parse(call.init.body)})),[{url:'/api/auth/verify',body:{email,code}},{url:'/api/auth/resend',body:{email}}]);assert.ok(calls.every(call=>call.init.headers.get('authorization')===null));assert.deepEqual(writes,[]);assert.equal(client.session(),null);
});
for(const method of ['verifySignup','resendSignupConfirmation'])test(`account screen cancellation aborts ${method} and ignores late success`,async()=>{
  let release,signal;const client=createApiClient({storage:null,fetchImpl:async(url,init)=>{signal=init.signal;return new Promise(resolve=>release=()=>resolve(json({ok:true})));}});assert.equal(typeof client[method],'function');const pending=client[method](email,code).catch(error=>error);client.cancelAuthentication();assert.equal(signal.aborted,true);release();assert.equal((await pending).code,'REQUEST_ABORTED');assert.equal(client.session(),null);
});
