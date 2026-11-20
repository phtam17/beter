// Opt-in: use only a new disposable database ending in _test.
import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
const value=process.env.TEST_AWS_DATABASE_URL;
if(!value)throw Error('TEST_AWS_DATABASE_URL is required; select a new disposable PostgreSQL database ending in _test.');
const url=new URL(value),name=decodeURIComponent(url.pathname.slice(1));
if(!['postgres:','postgresql:'].includes(url.protocol)||!name.endsWith('_test')||['postgres','template0','template1'].includes(name))throw Error('AWS auth races require a fresh disposable database ending in _test.');
const pool=new Pool({connectionString:value,max:6,connectionTimeoutMillis:5000,query_timeout:10000});
const user='11111111-1111-4111-8111-111111111111';
const first=()=>({accessHash:'a'.repeat(64),refreshHash:'b'.repeat(64),userId:user,sealedTokens:'private-encrypted-fixture',accessExpiresAt:Date.now()+3600000,refreshExpiresAt:Date.now()+86400000});
const next=old=>({...first(),accessHash:'c'.repeat(64),refreshHash:'d'.repeat(64),previousAccessHash:old.accessHash,previousRefreshHash:old.refreshHash});
before(async()=>{
  const result=await pool.query("select exists(select 1 from pg_tables where schemaname in ('auth','public')) as occupied");if(result.rows[0].occupied)throw Error('Refusing an occupied database. Nothing was changed.');
  await pool.query(await readFile(new URL('../aws/sql/bootstrap.sql',import.meta.url),'utf8'));
});
after(()=>pool.end());
beforeEach(async()=>{await pool.query('truncate auth.aws_session_handles,auth.aws_sessions,auth.users');await pool.query('select auth.beter_user_upsert($1,$2)',[user,'race@example.test']);});
async function insert(session){await pool.query('select auth.beter_session_put($1::jsonb)',[JSON.stringify(session)]);}
async function waitForLocks(pids,count){const end=Date.now()+5000;while(Date.now()<end){await pool.query('select pg_stat_clear_snapshot()');const result=await pool.query("select count(*)::int as count from pg_stat_activity where pid=any($1::int[]) and wait_event_type='Lock'",[pids]);if(result.rows[0].count===count)return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Independent requests did not overlap on the expected locks.');}
async function orderedRace(operations){
  const gate=await pool.connect(),clients=await Promise.all(operations.map(()=>pool.connect()));const pending=[];
  try{
    await gate.query('begin');await gate.query('select 1 from auth.aws_sessions for update');
    const pids=[];for(const client of clients){await client.query('set role service_role');pids.push((await client.query('select pg_backend_pid() as pid')).rows[0].pid);}
    assert.equal(new Set(pids).size,operations.length);
    for(let i=0;i<operations.length;i++){pending.push(operations[i](clients[i]));pending[i].catch(()=>{});await waitForLocks(pids.slice(0,i+1),i+1);}
    const done=Promise.all(pending);await gate.query('commit');return await done;
  }finally{await gate.query('rollback').catch(()=>{});await Promise.allSettled(pending);gate.release();for(const client of clients){await client.query('reset role').catch(()=>{});client.release();}}
}
test('two overlapping refreshes have exactly one database winner',async()=>{
  const old=first(),renewed=next(old);await insert(old);
  const results=await orderedRace([client=>client.query('select auth.beter_session_rotate($1,$2::jsonb) as result',[old.refreshHash,JSON.stringify(renewed)]),client=>client.query('select auth.beter_session_rotate($1,$2::jsonb) as result',[old.refreshHash,JSON.stringify(renewed)])]);
  assert.deepEqual(results.map(result=>result.rows[0].result).sort(),[false,true]);assert.equal((await pool.query('select count(*)::int as count from auth.aws_sessions')).rows[0].count,1);
});
test('a logout waiting behind refresh revokes and returns the winning successor',async()=>{
  const old=first(),renewed=next(old);await insert(old);
  const results=await orderedRace([client=>client.query('select auth.beter_session_rotate($1,$2::jsonb) as result',[old.refreshHash,JSON.stringify(renewed)]),client=>client.query('select auth.beter_session_revoke($1) as result',[old.accessHash])]);
  assert.equal(results[0].rows[0].result,true);assert.equal(results[1].rows[0].result?.accessHash,renewed.accessHash);assert.equal((await pool.query('select count(*)::int as count from auth.aws_sessions')).rows[0].count,0);
});
test('password-recovery revocation cannot miss a concurrently refreshed session',async()=>{
  const old=first(),renewed=next(old);await insert(old);
  await orderedRace([client=>client.query('select auth.beter_session_rotate($1,$2::jsonb) as result',[old.refreshHash,JSON.stringify(renewed)]),client=>client.query('select auth.beter_sessions_revoke_email($1) as result',['race@example.test'])]);
  assert.equal((await pool.query('select count(*)::int as count from auth.aws_sessions')).rows[0].count,0);assert.equal((await pool.query('select count(*)::int as count from auth.aws_session_handles')).rows[0].count,0);
});
