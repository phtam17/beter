import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createDataApiDatabase} from '../server/aws-database.ts';
import {bindPostgresParameters} from '../server/sql.ts';
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
test('runtime credentials reach PostgreSQL only as a salted SCRAM verifier after reviewed migrations',async()=>{
  assert.equal(typeof implementation.applyAwsMigrations,'function');const {database,calls}=fakeDatabase();const password='private-runtime-password-1234567890';const result=await implementation.applyAwsMigrations({database,migrations,runtimePassword:password});const call=calls.find(item=>item.sql.includes('beter_runtime_configure'));assert.match(call.parameters.verifier,/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);assert.doesNotMatch(JSON.stringify(calls),/private-runtime-password/);assert.doesNotMatch(JSON.stringify(result),/private-runtime/);assert.equal(result.runtimeConfigured,true);
});
test('the complete AWS migration chain executes through Data API compatible PostgreSQL calls and retries cleanly',async()=>{
  assert.equal(typeof implementation.loadAwsMigrations,'function');const pg=new PGlite();const unsupported=[];
  const client={send:async command=>{
    const name=command.constructor.name;if(name==='BeginTransactionCommand'){await pg.exec('begin');return{transactionId:'local-tx'};}if(name==='CommitTransactionCommand'){await pg.exec('commit');return{};}if(name==='RollbackTransactionCommand'){await pg.exec('rollback');return{};}
    const parameters=Object.fromEntries((command.input.parameters||[]).map(p=>[p.name,p.value.isNull?null:p.typeHint==='JSON'?JSON.parse(p.value.stringValue):p.value.stringValue??p.value.longValue??p.value.doubleValue??p.value.booleanValue]));const bound=bindPostgresParameters(command.input.sql,parameters);const result=await pg.query(bound.sql,bound.values);
    if(result.fields.some(field=>field.dataTypeID===2278)){unsupported.push('void');throw Object.assign(new Error('Unsupported Data API result type'),{name:'DatabaseErrorException'});}
    return{formattedRecords:JSON.stringify(result.rows)};
  }};
  const database=createDataApiDatabase({client,resourceArn:'arn:aws:rds:us-west-2:123456789012:cluster:test',secretArn:'arn:aws:secretsmanager:us-west-2:123456789012:secret:test',database:'beter'});
  try{const migrations=await implementation.loadAwsMigrations();const first=await implementation.applyAwsMigrations({database,migrations});assert.equal(first.applied.length,6);assert.deepEqual(unsupported,[]);const second=await implementation.applyAwsMigrations({database,migrations});assert.equal(second.applied.length,0);assert.equal(second.alreadyApplied.length,6);const result=await pg.query('select public.beter_health() as health');assert.equal(result.rows[0].health.schema_version,4);}finally{await pg.close();}
});
test('migration CLI retrieves runtime credentials privately and never prints a secret value',async()=>{
  assert.equal(typeof implementation.runAwsMigrationCli,'function');const {database,calls}=fakeDatabase();const output=[],password='runtime-private-password-1234567890';let secretReads=0;
  const result=await implementation.runAwsMigrationCli(['--apply'],{database,env:{BETER_DATABASE_RUNTIME_SECRET_ARN:'arn:aws:secretsmanager:us-west-2:123456789012:secret:runtime'},loadMigrations:async()=>migrations,secretsClient:{send:async command=>{secretReads++;assert.equal(command.input.SecretId,'arn:aws:secretsmanager:us-west-2:123456789012:secret:runtime');return{SecretString:JSON.stringify({username:'beter_runtime',password})};}},writeOutput:text=>output.push(JSON.parse(text))});
  assert.equal(result,0);assert.equal(secretReads,1);assert.equal(output[0].runtimeConfigured,true);assert.match(calls.find(item=>item.sql.includes('beter_runtime_configure')).parameters.verifier,/^SCRAM-SHA-256\$/);assert.doesNotMatch(JSON.stringify(calls),/runtime-private-password/);assert.doesNotMatch(JSON.stringify(output),/runtime-private/);
});
test('SCRAM verifier derivation uses independent random salts and refuses unsupported plaintext input',()=>{
  assert.equal(typeof implementation.createScramVerifier,'function');const one=implementation.createScramVerifier('private-runtime-password-1234567890'),two=implementation.createScramVerifier('private-runtime-password-1234567890');assert.notEqual(one,two);assert.match(one,/^SCRAM-SHA-256\$4096:/);
  for(const password of ['short','x'.repeat(129),'unicode-密码-password-12345678901234',null])assert.throws(()=>implementation.createScramVerifier(password),/credential/i);
});
test('migration CLI rejects unsafe input, redacts failures, and leaves check mode read-only',async()=>{
  const output=[];const writeOutput=text=>output.push(JSON.parse(text));assert.equal(await implementation.runAwsMigrationCli([],{writeOutput}),2);assert.equal(await implementation.runAwsMigrationCli(['--apply','--password','private'],{writeOutput}),2);
  const {database,calls}=fakeDatabase();let reads=0;assert.equal(await implementation.runAwsMigrationCli(['--check'],{database,env:{BETER_DATABASE_RUNTIME_SECRET_ARN:'arn:private'},loadMigrations:async()=>migrations,secretsClient:{send:async()=>{reads++;}},writeOutput}),0);assert.equal(reads,0);assert.equal(calls.some(call=>/configure_runtime/.test(call.sql)),false);
  assert.equal(await implementation.runAwsMigrationCli(['--apply'],{database,env:{BETER_DATABASE_RUNTIME_SECRET_ARN:'arn:private'},loadMigrations:async()=>migrations,secretsClient:{send:async()=>({SecretString:'private-malformed'})},writeOutput}),1);assert.doesNotMatch(JSON.stringify(output),/private-malformed|password=/);
  assert.equal(await implementation.runAwsMigrationCli(['--apply'],{database:fakeDatabase({failOn:'create table sample'}).database,loadMigrations:async()=>migrations,writeOutput}),1);assert.equal(output.at(-1).code,'MIGRATION_FAILED');
});
