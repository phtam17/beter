import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase,setUser,rpc} from './helpers/database.mjs';
const {createAuthLimiter}=await import('../server/abuse.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const secret='private-throttle-secret-for-tests-only-123456';
test('auth limiter hashes identity and trusts forwarded addresses only on the configured platform',async()=>{
  assert.equal(typeof createAuthLimiter,'function','A durable authentication limiter must exist.');
  const calls=[];const backend={rpc:async(...args)=>{calls.push(args);return{allowed:true,retry_after_seconds:0};}};
  const req=new Request('https://example.com/api/auth/signin',{headers:{'x-forwarded-for':'203.0.113.2'}});
  const limit=createAuthLimiter({backend,secret,trustProxy:false});assert.deepEqual(await limit(req,'signin',' User@Example.com '),{allowed:true,retryAfterSeconds:0});
  const first=calls.at(-1);assert.equal(first[0],'beter_auth_limit');assert.equal(first[2],'$service');assert.equal(first[1].p_buckets.length,2);assert.doesNotMatch(JSON.stringify(first),/User@|user@|203\.0\.113|private-throttle/);
  const trusted=createAuthLimiter({backend,secret,trustProxy:true});await trusted(req,'recover','user@example.com');const buckets=calls.at(-1)[1].p_buckets;assert.equal(buckets.length,3);assert.ok(buckets.some(b=>b.kind==='source'));assert.ok(buckets.some(b=>b.kind==='recovery'));assert.ok(buckets.every(b=>/^[a-f0-9]{64}$/.test(b.key)));
});
test('auth limiter fails closed on malformed quota responses and preserves retry timing',async()=>{
  assert.equal(typeof createAuthLimiter,'function');
  for(const payload of [{},null,{allowed:'yes'}])await assert.rejects(()=>createAuthLimiter({backend:{rpc:async()=>payload},secret})(new Request('https://example.com'),'signin','u@example.com'),/limit|protect/i);
  const limit=createAuthLimiter({backend:{rpc:async()=>({allowed:false,retry_after_seconds:87})},secret});assert.deepEqual(await limit(new Request('https://example.com'),'signin','u@example.com'),{allowed:false,retryAfterSeconds:87});
});
test('database auth quotas are durable, service-only, and retain denied attempts',async()=>{
  const db=await createTestDatabase();try{
    await setUser(db,null,'service_role');const args=[JSON.stringify([{key:'a'.repeat(64),kind:'identity'}])];
    for(let n=0;n<10;n++)assert.equal((await rpc(db,'beter_auth_limit',args,'jsonb')).allowed,true);
    const denied=await rpc(db,'beter_auth_limit',args,'jsonb');assert.equal(denied.allowed,false);assert.ok(denied.retry_after_seconds>0);
    assert.equal((await rpc(db,'beter_auth_limit',args,'jsonb')).allowed,false);
    await setUser(db);await assert.rejects(()=>rpc(db,'beter_auth_limit',args,'jsonb'),/permission/i);
    await db.exec('reset role');const rows=await db.query('select count(*)::int as count from public.beter_auth_buckets');assert.equal(rows.rows[0].count,1);
  }finally{await db.close();}
});
test('auth quota batches validate before changes and expire old windows',async()=>{
  const db=await createTestDatabase();try{
    await setUser(db,null,'service_role');await assert.rejects(()=>rpc(db,'beter_auth_limit',[JSON.stringify([{key:'bad',kind:'identity'}])],'jsonb'),/bucket|invalid/i);
    const args=[JSON.stringify([{key:'b'.repeat(64),kind:'recovery'}])];for(let n=0;n<3;n++)assert.equal((await rpc(db,'beter_auth_limit',args,'jsonb')).allowed,true);assert.equal((await rpc(db,'beter_auth_limit',args,'jsonb')).allowed,false);
    await db.exec('reset role');await db.exec("update public.beter_auth_buckets set window_started_at=clock_timestamp()-interval '2 hours'");await setUser(db,null,'service_role');assert.equal((await rpc(db,'beter_auth_limit',args,'jsonb')).allowed,true);
  }finally{await db.close();}
});
test('denied shared budgets do not create arbitrary identity rows',async()=>{
  const db=await createTestDatabase();try{
    await db.query("insert into public.beter_auth_buckets(kind,key_hash,attempts) values('source',$1,30)",['c'.repeat(64)]);await setUser(db,null,'service_role');
    for(const key of ['d'.repeat(64),'e'.repeat(64)])assert.equal((await rpc(db,'beter_auth_limit',[JSON.stringify([{kind:'identity',key},{kind:'source',key:'c'.repeat(64)}])],'jsonb')).allowed,false);
    await db.exec('reset role');assert.equal((await db.query('select count(*)::int as count from public.beter_auth_buckets')).rows[0].count,1);
  }finally{await db.close();}
});
