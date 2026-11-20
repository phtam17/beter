import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createDataApiDatabase,createAwsAuthStore} from '../server/aws-database.ts';
const bootstrap=await readFile(new URL('../aws/sql/bootstrap.sql',import.meta.url),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
const user='11111111-1111-4111-8111-111111111111';
const session=(suffix='a')=>({accessHash:suffix.repeat(64),refreshHash:(suffix==='a'?'b':'d').repeat(64),userId:user,sealedTokens:'v1.private-encrypted-payload',accessExpiresAt:Date.now()+3600000,refreshExpiresAt:Date.now()+86400000});
async function database(){assert.ok(bootstrap,'The AWS-only database bootstrap must exist.');const db=new PGlite();try{await db.exec(bootstrap);return db;}catch(error){await db.close();throw error;}}
async function call(db,name,values=[],types=[]){const rows=await db.query(`select auth.${name}(${values.map((_,i)=>'$'+(i+1)+(types[i]?'::'+types[i]:'')).join(',')}) as result`,values);return rows.rows[0].result;}
test('AWS bootstrap supplies compatible auth roles and applies all four financial migrations unchanged',async()=>{
  const db=await database();try{const dir=new URL('../supabase/migrations/',import.meta.url);for(const name of(await readdir(dir)).filter(n=>/^\d.*\.sql$/.test(n)).sort())await db.exec(await readFile(new URL(name,dir),'utf8'));
    await db.exec('set role service_role');await call(db,'beter_user_upsert',[user,'account@example.test'],['uuid','text']);await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('set role authenticated');const result=await db.query('select public.beter_portfolio() as result');assert.equal(result.rows[0].result.balance_cents,1000000);
  }finally{await db.close();}
});
test('private auth storage is inaccessible to anonymous and authenticated database roles',async()=>{
  const db=await database();try{for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>db.query('select * from auth.aws_sessions'),/permission/i);await assert.rejects(()=>call(db,'beter_session_get',['a'.repeat(64),'access'],['text','text']),/permission/i);await db.exec('reset role');}}
  finally{await db.close();}
});
test('service auth store reads encrypted payloads with user metadata and rotates refresh tokens exactly once',async()=>{
  const db=await database();try{await db.exec('set role service_role');await call(db,'beter_user_upsert',[user,'account@example.test'],['uuid','text']);const first=session();await call(db,'beter_session_put',[JSON.stringify(first)],['jsonb']);const found=await call(db,'beter_session_get',[first.accessHash,'access'],['text','text']);assert.equal(found.sealedTokens,first.sealedTokens);assert.equal(found.user.id,user);assert.equal(found.user.email,'account@example.test');
    const next={...session('c'),previousAccessHash:first.accessHash,previousRefreshHash:first.refreshHash};assert.equal(await call(db,'beter_session_rotate',[first.refreshHash,JSON.stringify(next)],['text','jsonb']),true);assert.equal(await call(db,'beter_session_rotate',[first.refreshHash,JSON.stringify(session('e'))],['text','jsonb']),false);assert.equal(await call(db,'beter_session_get',[first.accessHash,'access'],['text','text']),null);const refreshed=await call(db,'beter_session_get',[next.refreshHash,'refresh'],['text','text']);assert.equal(refreshed.accessHash,next.accessHash);assert.equal(refreshed.previousRefreshHash,first.refreshHash);assert.ok(Number.isSafeInteger(refreshed.createdAt));
  }finally{await db.close();}
});
test('late logout follows hashed session lineage and recovery can revoke by canonical email',async()=>{
  const db=await database();try{await db.exec('set role service_role');await call(db,'beter_user_upsert',[user,'Account@Example.Test'],['uuid','text']);const first=session();await call(db,'beter_session_put',[JSON.stringify(first)],['jsonb']);const next={...session('c'),previousAccessHash:first.accessHash,previousRefreshHash:first.refreshHash};await call(db,'beter_session_rotate',[first.refreshHash,JSON.stringify(next)],['text','jsonb']);const last={...session('e'),refreshHash:'f'.repeat(64),previousAccessHash:next.accessHash,previousRefreshHash:next.refreshHash};await call(db,'beter_session_rotate',[next.refreshHash,JSON.stringify(last)],['text','jsonb']);const revoked=await call(db,'beter_session_revoke',[first.accessHash],['text']);assert.equal(revoked.accessHash,last.accessHash);assert.equal(await call(db,'beter_session_get',[last.refreshHash,'refresh'],['text','text']),null);await call(db,'beter_session_put',[JSON.stringify(first)],['jsonb']);await call(db,'beter_sessions_revoke_email',['account@example.test'],['text']);assert.equal(await call(db,'beter_session_get',[first.accessHash,'access'],['text','text']),null);
  }finally{await db.close();}
});
test('session rotation cannot change account identity and expired tokens cannot be refreshed',async()=>{
  const db=await database();try{await db.exec('set role service_role');await call(db,'beter_user_upsert',[user,'account@example.test'],['uuid','text']);const first=session();await call(db,'beter_session_put',[JSON.stringify(first)],['jsonb']);await assert.rejects(()=>call(db,'beter_session_rotate',[first.refreshHash,JSON.stringify({...session('c'),userId:'22222222-2222-4222-8222-222222222222'})],['text','jsonb']),/identity/i);await db.exec('reset role');await db.exec('update auth.aws_sessions set refresh_expires_at=1');await db.exec('set role service_role');assert.equal(await call(db,'beter_session_rotate',[first.refreshHash,JSON.stringify(session('c'))],['text','jsonb']),false);
  }finally{await db.close();}
});
test('session revocation removes access and refresh handles together without changing financial identity',async()=>{
  const db=await database();try{await db.exec('set role service_role');await call(db,'beter_user_upsert',[user,'account@example.test'],['uuid','text']);const first=session();await call(db,'beter_session_put',[JSON.stringify(first)],['jsonb']);await call(db,'beter_session_revoke',[first.accessHash],['text']);assert.equal(await call(db,'beter_session_get',[first.refreshHash,'refresh'],['text','text']),null);await call(db,'beter_session_put',[JSON.stringify(session('c'))],['jsonb']);await call(db,'beter_sessions_revoke_user',[user],['uuid']);assert.equal(await call(db,'beter_session_get',[session('c').accessHash,'access'],['text','text']),null);
  }finally{await db.close();}
});
function transport(db,{allowDuplicateColumns=false}={}){
  return{send:async command=>{
    const kind=command.constructor.name;if(kind==='BeginTransactionCommand'){await db.exec('begin');return{transactionId:'local-transaction'};}if(kind==='CommitTransactionCommand'){await db.exec('commit');return{};}if(kind==='RollbackTransactionCommand'){await db.exec('rollback');return{};}
    const values=[];const mapping=new Map((command.input.parameters||[]).map(p=>[p.name,p]));
    const sql=command.input.sql.replace(/(?<!:):([a-z][a-z0-9_]*)/g,(match,key)=>{if(!mapping.has(key))return match;const p=mapping.get(key);values.push(p.value.isNull?null:p.value.stringValue??p.value.longValue??p.value.doubleValue??p.value.booleanValue);return'$'+values.length;});
    const result=await db.query(sql,values);const names=result.fields.map(field=>field.name);
    if(!allowDuplicateColumns&&new Set(names).size!==names.length)throw Object.assign(new Error('Duplicate result labels'),{name:'DatabaseErrorException'});
    return{formattedRecords:JSON.stringify(result.rows)};
  }};
}
function dataApi(db,options){return createDataApiDatabase({resourceArn:'arn:aws:rds:us-west-2:123456789012:cluster:test',secretArn:'arn:aws:secretsmanager:us-west-2:123456789012:secret:test',database:'beter',client:transport(db,options)});}
test('Data API compatible auth transactions use unique projection labels',async()=>{
  const db=await database();try{const store=createAwsAuthStore(dataApi(db));const account=await store.upsertUser({id:user,email:'account@example.test'});assert.equal(account.id,user);const original=session();await store.createSession(original);assert.equal((await store.getSessionByAccessHash(original.accessHash)).user.id,user);assert.equal((await store.getSessionByRefreshHash(original.refreshHash)).user.id,user);const renewed={...session('c'),previousAccessHash:original.accessHash,previousRefreshHash:original.refreshHash};assert.equal(await store.rotateSession(original.refreshHash,renewed),true);assert.equal((await store.revokeSessionByAccessHash(original.accessHash)).accessHash,renewed.accessHash);assert.equal(await store.getSessionByAccessHash(renewed.accessHash),null);await store.createSession(original);assert.equal(await store.revokeSessionsByUser(user),1);await store.createSession(original);assert.equal(await store.revokeSessionsByEmail('account@example.test'),1);}finally{await db.close();}
});
test('Data API scalar chunking preserves a missing private session as null',async()=>{
  const db=await database();try{const store=createAwsAuthStore(dataApi(db,{allowDuplicateColumns:true}));assert.equal(await store.getSessionByAccessHash('a'.repeat(64)),null);}finally{await db.close();}
});
