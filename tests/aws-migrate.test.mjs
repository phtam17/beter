import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const implementation=await import('../scripts/aws-migrate.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
function fakeDatabase({failOn}={}){
  const history=new Map(),calls=[];
  const query=async(sql,parameters={})=>{calls.push({sql,parameters});if(failOn&&sql.includes(failOn))throw Error('password=private-token select secret');if(sql.includes('to_regclass'))return{rows:[{present:true}]};if(sql.includes('select checksum'))return{rows:history.has(parameters.id)?[{checksum:history.get(parameters.id)}]:[]};if(sql.includes('insert into auth.beter_migrations'))history.set(parameters.id,parameters.checksum);return{rows:[]};};
  return{history,calls,database:{query,transaction:async operation=>{const snapshot=new Map(history);try{return await operation({query});}catch(error){history.clear();for(const [k,v]of snapshot)history.set(k,v);throw error;}}}};
}
const migrations=[{id:'001.sql',sql:'create table sample(id integer);'},{id:'002.sql',sql:'insert into sample values(1);'}];
function splitter(){assert.equal(typeof implementation.splitSql,'function','A PostgreSQL-aware SQL statement splitter must exist.');return implementation.splitSql;}
test('migration splitter keeps function bodies, quoted semicolons and nested comments intact',()=>{
  const source=`-- leading; comment\ncreate function f() returns void language plpgsql as $body$ begin perform ';'; end $body$; /* outer; /* inner; */ end */ select 'can''t; split',E'can\\'t; split',"semi;colon"; -- trailing;`;
  const statements=splitter()(source);assert.equal(statements.length,2);assert.match(statements[0],/perform ';'; end \$body\$/);assert.match(statements[1],/inner;/);assert.match(statements[1],/E'can/);
  assert.deepEqual(splitter()('-- only comments;\n/* nested /* comment */ */'),[]);
});
test('migration splitter rejects unterminated SQL before any migration can execute',()=>{
  for(const source of ["select 'unclosed",'select "unclosed','do $$ begin null; end;','/* unclosed'])assert.throws(()=>splitter()(source),/unterminated|invalid/i);
});
test('migration application is transactional, checksum protected and safe to retry',async()=>{
  assert.equal(typeof implementation.applyAwsMigrations,'function');const {database,history,calls}=fakeDatabase();
  const first=await implementation.applyAwsMigrations({database,migrations});assert.deepEqual(first.applied,['001.sql','002.sql']);assert.equal(history.size,2);assert.ok(calls.some(call=>/advisory_xact_lock/.test(call.sql)));assert.equal(history.get('001.sql'),createHash('sha256').update(migrations[0].sql).digest('hex'));
  const second=await implementation.applyAwsMigrations({database,migrations});assert.deepEqual(second.applied,[]);assert.deepEqual(second.alreadyApplied,['001.sql','002.sql']);
  await assert.rejects(()=>implementation.applyAwsMigrations({database,migrations:[{...migrations[0],sql:'drop table sample;'}]}),error=>error.code==='MIGRATION_DRIFT');
});
test('migration failures roll back their version and disclose neither SQL nor credential-bearing exceptions',async()=>{
  assert.equal(typeof implementation.applyAwsMigrations,'function');const {database,history}=fakeDatabase({failOn:'create table sample'});
  await assert.rejects(()=>implementation.applyAwsMigrations({database,migrations}),error=>error.code==='MIGRATION_FAILED'&&!/private-token|select secret|create table/.test(error.message));assert.equal(history.size,0);
});
test('migration planning is read-only and reports pending files without configuring runtime credentials',async()=>{
  assert.equal(typeof implementation.applyAwsMigrations,'function');const {database,calls}=fakeDatabase();const result=await implementation.applyAwsMigrations({database,migrations,dryRun:true,runtimePassword:'private-runtime-password-1234567890'});assert.deepEqual(result.pending,['001.sql','002.sql']);assert.equal(calls.some(call=>/create|insert|alter|configure_runtime/i.test(call.sql)),false);
});
test('invalid migration identifiers and SQL are refused before connecting',async()=>{
  assert.equal(typeof implementation.applyAwsMigrations,'function');for(const files of [[{id:'../private',sql:'select 1;'}],[{id:'bad.sql',sql:"select 'unclosed"}],[]]){const {database,calls}=fakeDatabase();await assert.rejects(()=>implementation.applyAwsMigrations({database,migrations:files}),/invalid|empty|unterminated/i);assert.equal(calls.length,0);}
});
test('runtime credentials are bound privately after reviewed migrations, with no value in the result',async()=>{
  assert.equal(typeof implementation.applyAwsMigrations,'function');const {database,calls}=fakeDatabase();const password='private-runtime-password-1234567890';const result=await implementation.applyAwsMigrations({database,migrations,runtimePassword:password});const call=calls.find(item=>item.sql.includes('beter_runtime_configure'));assert.equal(call.parameters.password,password);assert.equal(call.sql.includes(password),false);assert.doesNotMatch(JSON.stringify(result),/private-runtime/);assert.equal(result.runtimeConfigured,true);
});
