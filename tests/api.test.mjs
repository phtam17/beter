import test from 'node:test';
import assert from 'node:assert/strict';
const { createApiHandler } = await import('../server/api.ts').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const calls=[];
const backend={
  async authenticate(token){if(token!=='valid')throw Object.assign(new Error('Sign in to continue.'),{status:401});return{id:'user-1',email:'test@example.com'};},
  async auth(action,body){return{session:{access_token:'valid',refresh_token:'refresh',user:{id:'user-1',email:body.email},expires_at:1999999999}};},
  async rpc(name,args,token){calls.push({name,args,token});if(name==='beter_markets')return[];if(name==='beter_portfolio')return{id:'portfolio-1',balance_cents:1000000};if(name==='beter_health')return{mismatches:0};return{ok:true};}
};
function handler(options={}){assert.equal(typeof createApiHandler,'function','The server API handler must exist.');return createApiHandler({backend,config:{mode:'local',dataMode:'sample',liveOddsConfigured:false},jobSecret:'test-worker-secret',runJobs:async()=>({ingested:1,settled:1}),...options});}
const req=(path,body,token='valid',method)=>new Request('http://localhost/api'+path,{method:method||(body?'POST':'GET'),headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
test('public configuration describes sample mode without exposing secrets',async()=>{
  const response=await handler()(req('/config',undefined,null));assert.equal(response.status,200);const body=await response.json();assert.equal(body.dataMode,'sample');assert.equal('jobSecret' in body,false);assert.match(response.headers.get('Cache-Control'),/no-store/);
});
test('portfolio access requires a verified account',async()=>{
  const response=await handler()(req('/portfolio',undefined,null));assert.equal(response.status,401);
});
test('authenticated portfolio reads call the database using the caller token',async()=>{
  const response=await handler()(req('/portfolio'));assert.equal(response.status,200);assert.equal((await response.json()).balance_cents,1000000);assert.equal(calls.at(-1).token,'valid');
});
test('bet placement passes only quote, stake and idempotency fields',async()=>{
  const response=await handler()(req('/bets',{quoteId:'d474f6c5-c98c-407a-9e3f-261bc88bd530',stakeCents:10000,requestId:'request-123',balance:999999,userId:'attacker',odds:200}));assert.equal(response.status,201);assert.deepEqual(calls.at(-1),{name:'beter_place_bet',args:{p_quote_id:'d474f6c5-c98c-407a-9e3f-261bc88bd530',p_stake_cents:10000,p_request_id:'request-123'},token:'valid'});
});
test('invalid cent amounts and missing idempotency keys are rejected',async()=>{
  for(const stakeCents of [0,-1,1.1,Number.MAX_SAFE_INTEGER,null,'100']){const response=await handler()(req('/bets',{quoteId:'x',stakeCents,requestId:'request'}));assert.equal(response.status,400);}
  assert.equal((await handler()(req('/bets',{quoteId:'x',stakeCents:100}))).status,400);
});
test('quotes accept exactly one server selection id',async()=>{
  assert.equal((await handler()(req('/quotes',{selectionIds:['one']}))).status,201);
  for(const selectionIds of [[],['one','two'],[null]])assert.equal((await handler()(req('/quotes',{selectionIds}))).status,400);
});
test('manual client result changes have no endpoint',async()=>{
  assert.equal((await handler()(req('/settle',{status:'won'}))).status,404);
});
test('job processing rejects ordinary user tokens and missing worker tokens',async()=>{
  assert.equal((await handler()(req('/jobs/process',{}))).status,403);
  assert.equal((await handler()(req('/jobs/process',{},null))).status,403);
  const response=await handler()(req('/jobs/process',{},'test-worker-secret'));assert.equal(response.status,200);assert.equal((await response.json()).settled,1);
});
test('job processing is unavailable when no worker secret is configured',async()=>{
  assert.equal((await handler({jobSecret:''})(req('/jobs/process',{},''))).status,503);
});
test('database failures return safe messages without exposing SQL or credentials',async()=>{
  const response=await handler({backend:{...backend,rpc:async()=>{throw new Error('password=super-secret select * from auth.users');}}})(req('/portfolio'));assert.equal(response.status,500);assert.doesNotMatch(await response.text(),/super-secret|auth.users|select/);
});
test('malformed JSON and excessive request bodies fail cleanly',async()=>{
  const invoke=handler();const invalid=new Request('http://localhost/api/bets',{method:'POST',headers:{Authorization:'Bearer valid'},body:'{'});assert.equal((await invoke(invalid)).status,400);
  assert.equal((await invoke(req('/bets',{padding:'x'.repeat(33000)}))).status,413);
});
test('authentication endpoints validate credentials and preserve confirmation state',async()=>{
  assert.equal((await handler()(req('/auth/signin',{email:'bad',password:'short'},null))).status,400);
  const response=await handler()(req('/auth/signin',{email:'tester@example.com',password:'a-strong-password'},null));assert.equal(response.status,200);assert.equal((await response.json()).session.access_token,'valid');
});
test('health details require the worker secret and use the service database context',async()=>{
  assert.equal((await handler()(req('/health',undefined,null))).status,200);
  const result=await handler()(req('/health/details',undefined,'test-worker-secret'));assert.equal(result.status,200);assert.equal(calls.at(-1).name,'beter_health');
});
test('requests from unapproved browser origins cannot mutate accounts or bets',async()=>{
  const request=new Request('http://localhost/api/bets',{method:'POST',headers:{Origin:'https://untrusted.example',Authorization:'Bearer valid'},body:'{}'});assert.equal((await handler({allowedOrigins:['https://beter.example']})(request)).status,403);
});
test('password changes require a verified recovery or account token',async()=>{
  assert.equal((await handler()(req('/auth/password',{password:'a-new-secure-password'},null))).status,401);
  assert.equal((await handler()(req('/auth/password',{password:'short'}))).status,400);
  assert.equal((await handler()(req('/auth/password',{password:'a-new-secure-password'}))).status,200);
});
test('live betting is unavailable until the provider key is configured',async()=>{
  const invoke=handler({config:{mode:'supabase',dataMode:'live',liveOddsConfigured:false}});
  assert.equal((await invoke(req('/quotes',{selectionIds:['one']}))).status,503);
  assert.equal((await invoke(req('/bets',{quoteId:'quote',stakeCents:100,requestId:'missing-provider'}))).status,503);
});
