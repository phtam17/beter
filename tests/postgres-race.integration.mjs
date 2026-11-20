// Opt-in integration target. This file is intentionally outside the *.test.mjs glob.
// Use only an EMPTY, disposable PostgreSQL database. No database is dropped here.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';

const connectionString=process.env.TEST_DATABASE_URL;
if(!connectionString)throw new Error('TEST_DATABASE_URL is required for independent-session PostgreSQL race tests. Use an empty disposable database whose name ends in _test.');
let databaseUrl;
try {databaseUrl=new URL(connectionString);} catch {throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL connection URL.');}
const databaseName=decodeURIComponent(databaseUrl.pathname.slice(1));
if(!['postgres:','postgresql:'].includes(databaseUrl.protocol)||!databaseName||['postgres','template0','template1'].includes(databaseName))throw new Error('Race tests refuse system databases; select an empty disposable test database.');
if(!databaseName.endsWith('_test')&&process.env.BETER_ALLOW_TEST_DATABASE!=='1')throw new Error('Race tests require a database name ending in _test, or explicit BETER_ALLOW_TEST_DATABASE=1 for an empty disposable database.');

const {Pool}=await import('pg');
const pool=new Pool({connectionString,max:6,connectionTimeoutMillis:5000,query_timeout:10000,application_name:'beter-race-tests'});

before(async()=>{
  // Refuse an existing application schema even if its database name looks safe.
  // The target must be fresh; immutable financial history is never cleared.
  const {rows}=await pool.query(`select exists(select 1 from pg_tables where schemaname='public') as occupied,
    exists(select 1 from pg_namespace where nspname='auth') as has_auth`);
  if(rows[0].occupied||rows[0].has_auth)throw new Error('Race tests require an empty disposable database; existing public tables or auth schema were found. Nothing was changed.');
  await pool.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
  end $$;
  create schema auth;
  create table auth.users(id uuid primary key,email text);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth to anon,authenticated,service_role;
  grant execute on function auth.uid() to anon,authenticated,service_role;`);
  const directory=new URL('../supabase/migrations/',import.meta.url);
  for(const name of (await readdir(directory)).filter(name=>/^\d+.*\.sql$/.test(name)).sort())await pool.query(await readFile(new URL(name,directory),'utf8'));
});
after(async()=>{await pool.end();});

async function transaction(identity,operation,role='authenticated') {
  const client=await pool.connect();
  try {await begin(client,identity,role);const result=await operation(client);await client.query('commit');return result;}
  catch(error){await client.query('rollback');throw error;}
  finally {client.release();}
}
async function begin(client,identity,role) {
  assert.ok(['authenticated','service_role'].includes(role));
  await client.query('begin');await client.query(`set local role ${role}`);
  await client.query("select set_config('request.jwt.claim.sub',$1,true)",[identity||'']);
}
async function rpc(client,name,args=[],types=[]) {
  // All names/types originate from constants in this test, never user input.
  const {rows}=await client.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)+(types[i]?'::'+types[i]:'')).join(',')}) as result`,args);
  return rows[0].result;
}
async function user() {
  const id=randomUUID();await pool.query('insert into auth.users(id,email) values($1,$2)',[id,`${id}@example.com`]);return id;
}
async function event() {
  const id=randomUUID(),now=new Date().toISOString();
  const data={id,sport:'Basketball',league:'NBA',home_team:'Example Home',away_team:'Example Away',starts_at:new Date(Date.now()+3600000).toISOString(),status:'upcoming',provider_updated_at:now,fetched_at:now,
    selections:[{id:id+'-home',team:'Example Home',market:'Moneyline',line:null,side:'home',odds:150,bookmaker:'example',provider_updated_at:now,fetched_at:now}]};
  await transaction(null,client=>rpc(client,'beter_ingest_events',[JSON.stringify([data])],['jsonb']),'service_role');return data;
}
async function quote(identity,data) {
  return transaction(identity,client=>rpc(client,'beter_quote',[JSON.stringify([data.selections[0].id])],['jsonb']));
}
function betCall(accepted,stake,key) {
  return client=>rpc(client,'beter_place_bet',[accepted.id,stake,key],['uuid','bigint','text']);
}

async function race(identity,operations,{role='authenticated',lockKey=identity}={}) {
  const gate=await pool.connect();
  const clients=await Promise.all(operations.map(()=>pool.connect()));
  let pending=[];
  try {
    await gate.query('begin');await gate.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[lockKey]);
    const pids=[];
    for(const client of clients){await begin(client,identity,role);pids.push((await client.query('select pg_backend_pid() as pid')).rows[0].pid);}
    assert.equal(new Set(pids).size,operations.length,'race inputs must use independent database sessions');
    pending=clients.map((client,index)=>(async()=>{
      try {const value=await operations[index](client);await client.query('commit');return value;}
      catch(error){await client.query('rollback');throw error;}
    })());
    // Attach rejection handlers before deliberately releasing contending requests.
    const settled=Promise.allSettled(pending);
    const deadline=Date.now()+5000;
    let waiting=0;
    while(Date.now()<deadline){
      await gate.query('select pg_stat_clear_snapshot()');
      const {rows}=await gate.query("select count(*)::integer as n from pg_stat_activity where pid=any($1::integer[]) and wait_event_type='Lock'",[pids]);
      waiting=rows[0].n;if(waiting===operations.length)break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waiting,operations.length,'both independent requests must overlap while waiting for the common lock');
    await gate.query('commit');return await settled;
  } finally {
    await gate.query('rollback').catch(()=>{});
    await Promise.allSettled(pending);
    gate.release();for(const client of clients)client.release();
  }
}

test('concurrent first visits issue one portfolio and one grant',async()=>{
  const identity=await user();const results=await race(identity,[client=>rpc(client,'beter_portfolio'),client=>rpc(client,'beter_portfolio')]);
  assert.ok(results.every(result=>result.status==='fulfilled'));
  assert.equal(results[0].value.id,results[1].value.id);
  const {rows}=await pool.query("select (select count(*)::integer from public.beter_portfolios where owner_id=$1) portfolios,(select count(*)::integer from public.beter_ledger where owner_id=$1 and type='grant') grants",[identity]);
  assert.deepEqual(rows[0],{portfolios:1,grants:1});
});

test('two concurrent stakes cannot spend the same virtual balance',async()=>{
  const identity=await user(),data=await event(),one=await quote(identity,data),two=await quote(identity,data);
  const results=await race(identity,[betCall(one,600000,randomUUID()),betCall(two,600000,randomUUID())]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.match(results.find(result=>result.status==='rejected').reason.message,/insufficient.*balance/i);
  const portfolio=await transaction(identity,client=>rpc(client,'beter_portfolio'));
  assert.equal(portfolio.balance_cents,400000);assert.equal(portfolio.bets.length,1);assert.equal((await pool.query("select count(*)::integer as n from public.beter_ledger where owner_id=$1 and type='stake'",[identity])).rows[0].n,1);
});

test('concurrent duplicate requests create one bet and one stake entry',async()=>{
  const identity=await user(),data=await event(),accepted=await quote(identity,data),key=randomUUID();
  const results=await race(identity,[betCall(accepted,10000,key),betCall(accepted,10000,key)]);
  assert.ok(results.every(result=>result.status==='fulfilled'));assert.equal(results[0].value.bet.id,results[1].value.bet.id);
  const portfolio=await transaction(identity,client=>rpc(client,'beter_portfolio'));
  assert.equal(portfolio.balance_cents,990000);assert.equal(portfolio.bets.length,1);assert.equal((await pool.query("select count(*)::integer as n from public.beter_ledger where owner_id=$1 and type='stake'",[identity])).rows[0].n,1);
});

test('a simultaneous fresh start cannot charge an old quote to the new portfolio',async()=>{
  const identity=await user(),data=await event(),accepted=await quote(identity,data);
  const old=await transaction(identity,client=>rpc(client,'beter_portfolio'));
  const results=await race(identity,[client=>rpc(client,'beter_create_portfolio',['New season'],['text']),betCall(accepted,10000,randomUUID())]);
  assert.equal(results[0].status,'fulfilled');
  const fresh=await transaction(identity,client=>rpc(client,'beter_portfolio'));
  assert.notEqual(fresh.id,old.id);assert.equal(fresh.balance_cents,1000000);assert.equal(fresh.bets.length,0);
  if(results[1].status==='fulfilled')assert.equal(results[1].value.bet.portfolio_id,old.id);
  else assert.match(results[1].reason.message,/quote unavailable/i);
});

test('concurrent duplicate settlement workers credit the accepted bet once',async()=>{
  const identity=await user(),data=await event(),accepted=await quote(identity,data);
  const {bet}=await transaction(identity,betCall(accepted,10000,randomUUID()));
  const outcomes=JSON.stringify([{bet_id:bet.id,status:'won'}]);
  const call=client=>rpc(client,'beter_settle',[data.id,outcomes,'final-v1','{"source":"race-test"}'],['text','jsonb','text','jsonb']);
  const results=await race(null,[call,call],{role:'service_role',lockKey:'result:'+data.id});
  assert.ok(results.every(result=>result.status==='fulfilled'));
  assert.equal(results.reduce((sum,result)=>sum+result.value.applied,0),1);
  const portfolio=await transaction(identity,client=>rpc(client,'beter_portfolio'));
  assert.equal(portfolio.balance_cents,1015000);assert.equal((await pool.query("select count(*)::integer as n from public.beter_ledger where owner_id=$1 and type='won'",[identity])).rows[0].n,1);
  const health=await transaction(null,client=>rpc(client,'beter_health'),'service_role');assert.equal(health.ledger_mismatches,0);
});

test('overlapping provider snapshots cannot roll a newer event price backwards',async()=>{
  const identity=await user(),data=await event();
  const older=structuredClone(data),newer=structuredClone(data);
  older.fetched_at=new Date(Date.now()+1000).toISOString();older.selections[0].fetched_at=older.fetched_at;older.selections[0].odds=130;
  newer.fetched_at=new Date(Date.now()+2000).toISOString();newer.selections[0].fetched_at=newer.fetched_at;newer.selections[0].provider_updated_at=new Date(Date.now()+1000).toISOString();newer.selections[0].odds=180;
  const ingest=snapshot=>client=>rpc(client,'beter_ingest_events',[JSON.stringify([snapshot])],['jsonb']);
  const results=await race(null,[ingest(newer),ingest(older)],{role:'service_role',lockKey:'event:'+data.id});
  assert.ok(results.every(result=>result.status==='fulfilled'));
  const accepted=await quote(identity,data);assert.equal(accepted.selections[0].odds,180);
});

test('overlapping final results keep the newest provider correction',async()=>{
  const identity=await user(),data=await event(),accepted=await quote(identity,data);
  const {bet}=await transaction(identity,betCall(accepted,10000,randomUUID()));
  const settlement=(status,version,secondsAgo)=>client=>rpc(client,'beter_settle',[data.id,JSON.stringify([{bet_id:bet.id,status}]),version,JSON.stringify({last_update:new Date(Date.now()-secondsAgo*1000).toISOString()})],['text','jsonb','text','jsonb']);
  const results=await race(null,[settlement('lost','new-correction',60),settlement('won','old-final',120)],{role:'service_role',lockKey:'result:'+data.id});
  assert.ok(results.every(result=>result.status==='fulfilled'));
  const portfolio=await transaction(identity,client=>rpc(client,'beter_portfolio'));
  assert.equal(portfolio.balance_cents,990000);assert.equal(portfolio.bets[0].status,'lost');
  const health=await transaction(null,client=>rpc(client,'beter_health'),'service_role');assert.equal(health.ledger_mismatches,0);
});

test('overlapping portfolio creation cannot exceed a durable user quota',async()=>{
  const identity=await user();for(let i=0;i<4;i++)await transaction(identity,client=>rpc(client,'beter_create_portfolio',['Existing '+i],['text']));
  const results=await race(identity,[client=>rpc(client,'beter_create_portfolio',['Concurrent one'],['text']),client=>rpc(client,'beter_create_portfolio',['Concurrent two'],['text'])]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.match(results.find(result=>result.status==='rejected').reason.message,/BETER_RATE_LIMITED/);
  assert.equal((await pool.query('select count(*)::integer as n from public.beter_portfolios where owner_id=$1',[identity])).rows[0].n,5);
});

test('an overlapping worker cannot reverse audited operator recovery',async()=>{
  const identity=await user(),data=await event(),accepted=await quote(identity,data);
  const {bet}=await transaction(identity,betCall(accepted,10000,randomUUID()));
  const manual=client=>rpc(client,'beter_resolve_event',[data.id,JSON.stringify([{bet_id:bet.id,status:'void'}]),'verified-cancellation',JSON.stringify({source:'verified archive',last_update:new Date().toISOString()}),'test-reviewer','Verified cancellation from archived evidence'],['text','jsonb','text','jsonb','text','text']);
  const automatic=client=>rpc(client,'beter_settle',[data.id,JSON.stringify([{bet_id:bet.id,status:'lost'}]),'late-worker',JSON.stringify({last_update:new Date(Date.now()-60000).toISOString()})],['text','jsonb','text','jsonb']);
  const results=await race(null,[manual,automatic],{role:'service_role',lockKey:'result:'+data.id});
  assert.equal(results[0].status,'fulfilled');
  if(results[1].status==='rejected')assert.match(results[1].reason.message,/held|operator/);
  const portfolio=await transaction(identity,client=>rpc(client,'beter_portfolio'));
  assert.equal(portfolio.bets[0].status,'void');assert.equal(portfolio.balance_cents,1000000);
  assert.equal((await pool.query('select count(*)::integer as n from public.beter_operator_audit where event_id=$1',[data.id])).rows[0].n,1);
});
