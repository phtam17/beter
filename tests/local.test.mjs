import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const module=await import('../server/local.ts').catch(()=>({}));
const {createLocalBackend}=module;
let directory,migrationPath,shared;
let clock=new Date('2026-11-20T02:00:00Z');
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'beter-local-tests-'));migrationPath=join(directory,'fixture.sql');
  await writeFile(migrationPath,`
    create function public.beter_probe(p_value jsonb default null) returns jsonb language sql as $$
      select jsonb_build_object('user',auth.uid(),'role',current_user,'value',p_value)
    $$;
    grant execute on function public.beter_probe(jsonb) to anon,authenticated,service_role;
    create function public.beter_private_probe() returns text language sql as $$ select 'worker-only'::text $$;
    revoke all on function public.beter_private_probe() from public,anon,authenticated;
    grant execute on function public.beter_private_probe() to service_role;
  `);
});
beforeEach(()=>{clock=new Date('2026-11-20T02:00:00Z');});
after(async()=>{if(shared)await shared.close();if(directory)await rm(directory,{recursive:true,force:true});});
async function local(options={}){
  assert.equal(typeof createLocalBackend,'function','The persistent local account backend must exist');
  return createLocalBackend({migrationPath,now:()=>clock,...options});
}
async function backend(){if(!shared)shared=await local();return shared;}
const signup=async(email,extra={})=>(await backend()).auth('signup',{email,password:'correct-horse-2026',...extra});
const fault=status=>error=>{assert.equal(error.status,status);assert.equal(typeof error.code,'string');return true;};

test('local accounts use normalized email and private server-issued sessions',async()=>{
  const data=await signup(' Alice@Example.com ');
  assert.equal(data.user.email,'alice@example.com');assert.equal(data.session.user.id,data.user.id);
  assert.ok(data.session.access_token.length>=40);assert.ok(data.session.refresh_token.length>=40);
  assert.notEqual(data.session.access_token,data.session.refresh_token);
  assert.equal(data.session.expires_at,Math.floor(clock.getTime()/1000)+3600);
  assert.deepEqual(await (await backend()).authenticate(data.session.access_token),data.user);
});
test('wrong password and missing account produce the same generic sign-in failure',async()=>{
  await signup('login@example.com');const instance=await backend();
  let first;
  for(const email of ['login@example.com','absent@example.com']){
    await assert.rejects(instance.auth('signin',{email,password:'wrong-password-2026'}),error=>{
      assert.equal(error.status,401);if(first)assert.equal(error.message,first);else first=error.message;return true;
    });
  }
  const correct=await instance.auth('signin',{email:'LOGIN@EXAMPLE.COM',password:'correct-horse-2026'});assert.equal(correct.user.email,'login@example.com');
});
test('signup rejects duplicate accounts and invalid inputs without creating sessions',async()=>{
  await signup('duplicate@example.com');
  await assert.rejects(signup('DUPLICATE@example.com'),fault(409));
  for(const body of [{email:'bad',password:'valid-password'},{email:'valid@example.com',password:'short'},{email:'valid@example.com',password:'a'.repeat(201)}])await assert.rejects((await backend()).auth('signup',body),fault(400));
});
test('refresh rotates both credentials and invalidates the previous session',async()=>{
  const {session}=await signup('refresh@example.com');const instance=await backend();
  const renewed=await instance.auth('refresh',{refresh_token:session.refresh_token});
  assert.notEqual(renewed.session.access_token,session.access_token);
  assert.notEqual(renewed.session.refresh_token,session.refresh_token);
  await assert.rejects(instance.authenticate(session.access_token),fault(401));
  await assert.rejects(instance.auth('refresh',{refresh_token:session.refresh_token}),fault(401));
  assert.equal((await instance.authenticate(renewed.session.access_token)).email,'refresh@example.com');
});
test('signout revokes access and refresh credentials together',async()=>{
  const {session}=await signup('signout@example.com');const instance=await backend();
  assert.deepEqual(await instance.auth('signout',{},session.access_token),{ok:true});
  await assert.rejects(instance.authenticate(session.access_token),fault(401));
  await assert.rejects(instance.auth('refresh',{refresh_token:session.refresh_token}),fault(401));
});
test('expired access tokens are rejected but refresh remains usable until its own expiry',async()=>{
  const {session}=await signup('expiry@example.com');const instance=await backend();
  clock=new Date(clock.getTime()+3_600_001);
  await assert.rejects(instance.authenticate(session.access_token),fault(401));
  const fresh=await instance.auth('refresh',{refresh_token:session.refresh_token});assert.ok(fresh.session.access_token);
  clock=new Date(clock.getTime()+31*86_400_000);
  await assert.rejects(instance.auth('refresh',{refresh_token:fresh.session.refresh_token}),fault(401));
});
test('unknown and privileged sentinel credentials cannot authenticate as a person',async()=>{
  const instance=await backend();
  for(const token of ['',undefined,'$service','forged-token','x'.repeat(10000)])await assert.rejects(instance.authenticate(token),fault(401));
  await assert.rejects(instance.auth('refresh',{refresh_token:''}),fault(401));
});
test('RPC binds the authenticated subject and restores its role between calls',async()=>{
  const instance=await backend();const a=await signup('rpc-a@example.com'),b=await signup('rpc-b@example.com');
  const value={nested:['a',2],quote:"'); drop schema public cascade; --"};
  const [one,two]=await Promise.all([instance.rpc('beter_probe',{p_value:value},a.session.access_token),instance.rpc('beter_probe',{},b.session.access_token)]);
  assert.equal(one.user,a.user.id);assert.equal(one.role,'authenticated');assert.deepEqual(one.value,value);
  assert.equal(two.user,b.user.id);assert.equal(two.role,'authenticated');
  const anon=await instance.rpc('beter_probe');assert.equal(anon.user,null);assert.equal(anon.role,'anon');
});
test('only the internal worker sentinel can invoke a service-only operation',async()=>{
  const instance=await backend();const account=await signup('worker-check@example.com');
  assert.equal(await instance.rpc('beter_private_probe',{},'$service'),'worker-only');
  await assert.rejects(instance.rpc('beter_private_probe'));
  await assert.rejects(instance.rpc('beter_private_probe',{},account.session.access_token));
});
test('RPC function and parameter names cannot carry SQL or unexpected namespaces',async()=>{
  const instance=await backend();
  for(const name of ['auth.uid','beter_probe(); drop schema public cascade;--','pg_sleep','beter_Probe'])await assert.rejects(instance.rpc(name),fault(400));
  for(const args of [{'p_value)':'bad'},{value:'bad'},null,[]])await assert.rejects(instance.rpc('beter_probe',args),fault(400));
});
test('local recovery explains the missing email service rather than pretending to send mail',async()=>{
  await assert.rejects((await backend()).auth('recover',{email:'any@example.com'}),error=>{assert.equal(error.status,501);assert.match(error.message,/configured Supabase/i);return true;});
  await assert.rejects((await backend()).auth('unknown',{}),fault(400));
});
test('accounts and hashed sessions survive a local database restart',async()=>{
  const dataDir=join(directory,'persistent');let instance=await local({dataDir});
  const account=await instance.auth('signup',{email:'persistent@example.com',password:'persistent-password'});
  await instance.close();
  const inspection=new PGlite(dataDir);
  try {
    const row=(await inspection.query('select c.salt,c.password_hash,s.access_hash,s.refresh_hash from auth.local_credentials c join auth.local_sessions s on s.user_id=c.user_id')).rows[0];
    assert.equal(row.access_hash,createHash('sha256').update(account.session.access_token).digest('hex'));
    assert.equal(row.refresh_hash,createHash('sha256').update(account.session.refresh_token).digest('hex'));
    assert.notEqual(row.access_hash,account.session.access_token);assert.notEqual(row.refresh_hash,account.session.refresh_token);
    assert.equal(row.password_hash.length,128);assert.equal(row.salt.length,64);assert.notEqual(row.password_hash,'persistent-password');
  } finally {await inspection.close();}
  instance=await local({dataDir});
  try{
    assert.equal((await instance.authenticate(account.session.access_token)).id,account.user.id);
    const login=await instance.auth('signin',{email:'persistent@example.com',password:'persistent-password'});assert.equal(login.user.id,account.user.id);
    assert.equal(await instance.rpc('beter_private_probe',{},'$service'),'worker-only');
  }finally{await instance.close();}
});

test('real financial migrations work through local account, quote, placement and settlement boundaries',async()=>{
  const instance=await local({migrationPath:new URL('../supabase/migrations/202611200001_beter.sql',import.meta.url).pathname,now:()=>new Date()});
  try {
    const first=await instance.auth('signup',{email:'full-flow@example.com',password:'full-flow-password'});
    const second=await instance.auth('signup',{email:'other-flow@example.com',password:'full-flow-password'});
    const token=first.session.access_token;
    const stamp=new Date().toISOString();
    const event={id:'local-flow',sport:'Basketball',league:'NBA',home_team:'Home',away_team:'Away',starts_at:new Date(Date.now()+3_600_000).toISOString(),status:'upcoming',provider_updated_at:stamp,fetched_at:stamp,selections:[{id:'local-home',team:'Home',market:'Moneyline',side:'home',line:null,odds:150,bookmaker:'sample',provider_updated_at:stamp,fetched_at:stamp}]};
    await instance.rpc('beter_ingest_events',{p_events:[event]},'$service');
    assert.equal((await instance.rpc('beter_portfolio',{},token)).balance_cents,1_000_000);
    const quote=await instance.rpc('beter_quote',{p_selection_ids:['local-home']},token);
    const args={p_quote_id:quote.id,p_stake_cents:10_000,p_request_id:'local-request-1'};
    const placed=await instance.rpc('beter_place_bet',args,token);
    assert.equal(placed.portfolio.balance_cents,990_000);assert.equal(placed.bet.potential_payout_cents,25_000);
    assert.equal((await instance.rpc('beter_place_bet',args,token)).bet.id,placed.bet.id);
    await instance.rpc('beter_settle',{p_event_id:event.id,p_outcomes:[{bet_id:placed.bet.id,status:'won'}],p_result_version:'local-v1',p_evidence:{source:'local-test'}},'$service');
    assert.equal((await instance.rpc('beter_portfolio',{},token)).balance_cents,1_015_000);
    assert.equal((await instance.rpc('beter_portfolio',{},second.session.access_token)).balance_cents,1_000_000);
    assert.equal((await instance.rpc('beter_health',{},'$service')).ledger_mismatches,0);
    await assert.rejects(instance.rpc('beter_portfolio'));
  }finally{await instance.close();}
});
