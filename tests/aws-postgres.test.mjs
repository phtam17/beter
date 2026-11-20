import test from 'node:test';
import assert from 'node:assert/strict';
const implementation=await import('../server/aws-database.ts');
function fixture({failQuery=false,failCommit=false}={}){
  const calls=[];let releases=0;
  const query=async(sql,values)=>{calls.push({sql,values});if((sql==='commit'&&failCommit)||(sql.startsWith('select')&&failQuery))throw Error('password=private');return{rows:[{n:7}]};};
  const client={query,release:()=>releases++};const pool={query,connect:async()=>client,end:async()=>calls.push({sql:'end'})};
  return{pool,calls,releases:()=>releases};
}
test('direct PostgreSQL binds named values without rewriting casts, literals, comments or function bodies',async()=>{
  assert.equal(typeof implementation.createPostgresDatabase,'function','A direct PostgreSQL executor must exist.');const {pool,calls}=fixture();const db=implementation.createPostgresDatabase({pool});
  await db.query("select :value::text,':literal',:value /* :comment */,$body$:body$body$",{value:"'; drop table auth.users; --"});
  assert.equal(calls[0].sql,"select $1::text,':literal',$1 /* :comment */,$body$:body$body$");assert.deepEqual(calls[0].values,["'; drop table auth.users; --"]);
});
test('direct PostgreSQL transactions release connections after commit and rollback on failure',async()=>{
  assert.equal(typeof implementation.createPostgresDatabase,'function');for(const change of [{},{failQuery:true},{failCommit:true}]){const {pool,calls,releases}=fixture(change);const db=implementation.createPostgresDatabase({pool});if(change.failQuery||change.failCommit)await assert.rejects(()=>db.transaction(tx=>tx.query('select 1')),/database.*unavailable/i);else await db.transaction(tx=>tx.query('select 1'));assert.equal(calls[0].sql,'begin');assert.equal(calls.at(-1).sql,change.failQuery||change.failCommit?'rollback':'commit');assert.equal(releases(),1);}
});
test('insecure direct connections require an explicit loopback-only exemption and verified remote TLS',()=>{
  assert.equal(typeof implementation.createPostgresDatabase,'function');for(const options of [{connectionString:'postgresql://u:p@remote.example/beter',ssl:false},{connectionString:'postgresql://u:p@remote.example/beter',ssl:{rejectUnauthorized:false}},{connectionString:'postgresql://u:p@remote.example/beter',allowLocalInsecure:true,ssl:false},{connectionString:'postgresql://u:p@remote.example/beter?sslmode=disable'},{connectionString:'mysql://u:p@localhost/beter',allowLocalInsecure:true}])assert.throws(()=>implementation.createPostgresDatabase(options),/TLS|secure|PostgreSQL/i);
  const db=implementation.createPostgresDatabase({connectionString:'postgresql://u:p@127.0.0.1/beter',allowLocalInsecure:true});assert.equal(typeof db.query,'function');
});
test('direct PostgreSQL validates parameters and serializes JSON arrays instead of PostgreSQL arrays',async()=>{
  assert.equal(typeof implementation.createPostgresDatabase,'function');const {pool,calls}=fixture();const db=implementation.createPostgresDatabase({pool});await db.query('select :items,:missing',{items:['one'],missing:null});assert.deepEqual(calls[0].values,['["one"]',null]);await assert.rejects(()=>db.query('select :n',{n:Number.MAX_SAFE_INTEGER+1}),/parameter/i);await assert.rejects(()=>db.query('select :missing'),/parameter/i);
});
