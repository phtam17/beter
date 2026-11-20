import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiHandler} from '../server/api.ts';
import {readSettings} from '../server/config.ts';
import {createRuntime} from '../server/runtime.ts';

const configured={NODE_ENV:'production',SUPABASE_URL:'https://accounts.example.com',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'s'.repeat(48),JOB_SECRET:'w'.repeat(40),ODDS_API_KEY:'provider',SITE_URL:'https://beter.example.com',BETER_SUPPORT_URL:'https://beter.example.com/help',BETER_PRIVACY_URL:'https://beter.example.com/privacy',BETER_ACCOUNT_DELETION_URL:'https://beter.example.com/delete'};
const healthy=()=>({schema_version:4,ledger_mismatches:0,unsettled_bets:0,open_bets:0,jobs:['pipeline','odds:basketball_nba','odds:americanfootball_nfl','odds:icehockey_nhl'].map(name=>({name,ok:true,created_at:new Date().toISOString(),detail:{}}))});
function fixture(overrides={}){
  const calls=[],diagnostics=[];
  const backend={authenticate:async token=>{if(token!=='user')throw Object.assign(new Error('jwt'),{status:401});return{id:'u'};},auth:async()=>({ok:true}),rpc:async(name,args,token)=>{calls.push({name,args,token});return name==='beter_health'?healthy():{ok:true};},...overrides.backend};
  return{calls,diagnostics,handle:createApiHandler({backend,config:{mode:'supabase',dataMode:'live',liveOddsConfigured:true,production:true,supportUrl:configured.BETER_SUPPORT_URL,privacyUrl:configured.BETER_PRIVACY_URL,accountDeletionUrl:configured.BETER_ACCOUNT_DELETION_URL,...overrides.config},jobSecret:'worker',onDiagnostic:entry=>diagnostics.push(entry),...overrides,backend})};
}
const request=(path,{body,token='worker',method=body===undefined?'GET':'POST'}={})=>new Request('https://beter.example.com/api'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});

test('production startup refuses missing required hosted settings',()=>{
  for(const key of ['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','JOB_SECRET','ODDS_API_KEY','SITE_URL']){const env={...configured};delete env[key];assert.throws(()=>readSettings(env),/production|configure|required|https/i,key);}
});
test('production rejects insecure redirects and weak dedicated session keys',()=>{
  for(const SITE_URL of ['http://beter.example.com','http://localhost:4173','https://user:password@beter.example.com','https://beter.example.com/path'])assert.throws(()=>readSettings({...configured,SITE_URL}),/origin|https|site/i);
  assert.throws(()=>readSettings({...configured,BETER_SESSION_SECRET:'short'}),/secret/i);
});
test('sample hosted data requires an explicit staging environment',()=>{
  assert.throws(()=>readSettings({...configured,BETER_DATA_MODE:'sample'}),/sample|staging/i);
  assert.equal(readSettings({...configured,BETER_ENVIRONMENT:'staging',BETER_DATA_MODE:'sample'}).dataMode,'sample');
});
test('public destinations must be safe HTTPS links and never expose private settings',async()=>{
  for(const value of ['javascript:alert(1)','https://user:password@example.com','http://example.com/help'])assert.throws(()=>readSettings({...configured,BETER_SUPPORT_URL:value}),/url|https|support/i);
  const settings=readSettings(configured);assert.equal(settings.supportUrl,configured.BETER_SUPPORT_URL);
  const {handle}=fixture({config:settings});const response=await handle(request('/config',{token:'user'}));const data=await response.json();assert.equal(data.supportUrl,configured.BETER_SUPPORT_URL);assert.equal(data.privacyUrl,configured.BETER_PRIVACY_URL);assert.equal(data.accountDeletionUrl,configured.BETER_ACCOUNT_DELETION_URL);assert.equal('sessionSecret'in data,false);
});
test('readiness is protected separately from process liveness',async()=>{
  const {handle}=fixture();assert.equal((await handle(request('/health',{token:'user'}))).status,200);assert.equal((await handle(request('/ready',{token:'user'}))).status,403);const response=await handle(request('/ready'));assert.equal(response.status,200);assert.equal((await response.json()).ready,true);
});
test('readiness fails when database, schema, or public account destinations are missing',async()=>{
  for(const backend of [{rpc:async()=>{throw new Error('password=private');}},{rpc:async()=>({...healthy(),schema_version:1})}]){const {handle}=fixture({backend});const res=await handle(request('/ready'));assert.equal(res.status,503);assert.doesNotMatch(await res.text(),/private|password/);}
  const {handle}=fixture({config:{mode:'supabase',dataMode:'live',liveOddsConfigured:true,production:true}});assert.equal((await handle(request('/ready'))).status,503);
});
test('worker operator routes deny user credentials before any database operation',async()=>{
  const {handle,calls}=fixture();for(const path of ['/ops/resolve','/ops/resume','/ops/maintenance'])assert.equal((await handle(request(path,{body:{},token:'user'}))).status,403);assert.equal(calls.length,0);
});
test('manual resolution validates and forwards only audited operator fields',async()=>{
  const {handle,calls}=fixture();const body={eventId:'event-one',outcomes:[{bet_id:'11111111-1111-4111-8111-111111111111',status:'void'}],resultVersion:'case-123',evidence:{source:'verified incident evidence',last_update:new Date().toISOString()},operator:'on-call',reason:'Game cancellation verified',balance:9999};
  const res=await handle(request('/ops/resolve',{body}));assert.equal(res.status,200);assert.deepEqual(calls.at(-1),{name:'beter_resolve_event',args:{p_event_id:body.eventId,p_outcomes:body.outcomes,p_result_version:body.resultVersion,p_evidence:body.evidence,p_operator:body.operator,p_reason:body.reason},token:'$service'});
  for(const change of [{reason:''},{operator:''},{outcomes:[{bet_id:'bad',status:'won'}]},{outcomes:[{bet_id:body.outcomes[0].bet_id,status:'pending'}]},{evidence:[]},{eventId:''}])assert.equal((await handle(request('/ops/resolve',{body:{...body,...change}}))).status,400);
});
test('resuming automated settlement requires an operator and reason',async()=>{
  const {handle,calls}=fixture();assert.equal((await handle(request('/ops/resume',{body:{eventId:'e',operator:'on-call',reason:'Provider correction verified'}}))).status,200);assert.equal(calls.at(-1).name,'beter_resume_event');assert.equal((await handle(request('/ops/resume',{body:{eventId:'e'}}))).status,400);
});
test('maintenance is bounded and history is owner authenticated',async()=>{
  const {handle,calls}=fixture();assert.equal((await handle(request('/ops/maintenance',{body:{batchSize:100}}))).status,200);assert.deepEqual(calls.at(-1),{name:'beter_maintenance',args:{p_batch_size:100},token:'$service'});assert.equal((await handle(request('/ops/maintenance',{body:{batchSize:999999}}))).status,400);
  assert.equal((await handle(request('/history?portfolioId=11111111-1111-4111-8111-111111111111&limit=25',{token:'user'}))).status,200);assert.equal(calls.at(-1).name,'beter_history');assert.equal(calls.at(-1).token,'user');assert.equal((await handle(request('/history?limit=10001',{token:'user'}))).status,400);
});
test('durable database quota rejections have a safe retryable response',async()=>{
  const {handle}=fixture({backend:{rpc:async()=>{throw new Error('BETER_RATE_LIMITED internal details');}}});const res=await handle(request('/quotes',{token:'user',body:{selectionIds:['one']}}));assert.equal(res.status,429);assert.equal((await res.json()).error.code,'RATE_LIMITED');assert.ok(Number(res.headers.get('Retry-After'))>0);
});
test('authentication limiter prevents provider calls and fails closed on unavailable limits',async()=>{
  let called=0;for(const authLimit of [async()=>({allowed:false,retryAfterSeconds:37}),async()=>{throw new Error('private');}]){const {handle}=fixture({authLimit,backend:{auth:async()=>{called++;return{};}}});const response=await handle(request('/auth/signin',{body:{email:'user@example.com',password:'long-strong-password'},token:''}));assert.ok([429,503].includes(response.status));assert.doesNotMatch(await response.text(),/private/);}assert.equal(called,0);
});
test('private error diagnostics correlate requests without capturing credentials or personal data',async()=>{
  const {handle,diagnostics}=fixture({backend:{rpc:async()=>{throw new Error('secret password user@example.com');}}});const response=await handle(request('/portfolio',{token:'user'}));assert.equal(response.status,500);assert.ok(response.headers.get('X-Request-ID'));assert.equal(diagnostics.length,1);const serialized=JSON.stringify(diagnostics);assert.doesNotMatch(serialized,/password|secret|user@example.com|Bearer/);assert.equal(diagnostics[0].requestId,response.headers.get('X-Request-ID'));
});
test('operator review accepts provider event identifiers beyond 200 characters',async()=>{
  const {handle}=fixture();const body={eventId:'e'.repeat(350),operator:'operator',reason:'Reviewed source evidence',outcomes:[{bet_id:'11111111-1111-4111-8111-111111111111',status:'void'}],resultVersion:'case',evidence:{source:'review',last_update:new Date().toISOString()}};assert.equal((await handle(request('/ops/resolve',{body}))).status,200);
});
test('history accepts a UUID keyset cursor and rejects invalid cursor values',async()=>{
  const {handle,calls}=fixture();const portfolio='11111111-1111-4111-8111-111111111111',cursor='22222222-2222-4222-8222-222222222222';assert.equal((await handle(request(`/history?portfolioId=${portfolio}&before=${cursor}`,{token:'user'}))).status,200);assert.equal(calls.at(-1).args.p_before,cursor);assert.equal((await handle(request(`/history?portfolioId=${portfolio}&before=yesterday`,{token:'user'}))).status,400);
});
test('runtime wires durable protection before invoking authentication',async()=>{
  let authCalls=0;const runtime=await createRuntime({env:{BETER_SESSION_SECRET:'x'.repeat(40)},backend:{authenticate:async()=>({id:'u'}),auth:async()=>{authCalls++;return{};},rpc:async name=>name==='beter_auth_limit'?{allowed:false,retry_after_seconds:60}:{}}});try{const response=await runtime.handle(request('/auth/signin',{body:{email:'user@example.com',password:'long-strong-password'},token:''}));assert.equal(response.status,429);assert.equal(authCalls,0);}finally{await runtime.close();}
});
test('verified operators can resolve larger events while public request bodies stay capped',async()=>{
  const {handle}=fixture();const body={eventId:'large-event',operator:'operator',reason:'Reviewed source evidence',outcomes:Array.from({length:600},()=>({bet_id:crypto.randomUUID(),status:'void'})),resultVersion:'case',evidence:{source:'review',last_update:new Date().toISOString()}};assert.equal((await handle(request('/ops/resolve',{body}))).status,200);assert.equal((await handle(request('/quotes',{token:'user',body:{padding:'x'.repeat(40000)}}))).status,413);
});
test('history filters apply on the server before pagination',async()=>{
  const {handle,calls}=fixture();const portfolio='11111111-1111-4111-8111-111111111111';assert.equal((await handle(request(`/history?portfolioId=${portfolio}&status=lost`,{token:'user'}))).status,200);assert.equal(calls.at(-1).args.p_status,'lost');assert.equal((await handle(request(`/history?portfolioId=${portfolio}&status=unknown`,{token:'user'}))).status,400);
});
test('readiness requires the bounded portfolio migration',async()=>{
  const older=fixture({backend:{rpc:async()=>({...healthy(),schema_version:3})}});assert.equal((await older.handle(request('/ready'))).status,503);
});
