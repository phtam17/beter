import test from 'node:test';
import assert from 'node:assert/strict';
const implementation=await import('../server/aws-database.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const options={resourceArn:'arn:aws:rds:us-west-2:123456789012:cluster:beter-staging',secretArn:'arn:aws:secretsmanager:us-west-2:123456789012:secret:beter-db',database:'beter'};
function fakeClient({failExecute=false,failCommit=false,records='[{"part":"{\\"ok\\":true}"}]'}={}){
  const calls=[];
  return {calls,client:{async send(command){const name=command.constructor.name;calls.push({name,input:command.input});if(name==='BeginTransactionCommand')return{transactionId:'tx-private'};if(name==='CommitTransactionCommand'){if(failCommit)throw Error('password=private');return{};}if(name==='RollbackTransactionCommand')return{};if(failExecute)throw Error('password=private');return{formattedRecords:records};}}};
}
function database(client){assert.equal(typeof implementation.createDataApiDatabase,'function','The AWS Data API transaction adapter must exist.');return implementation.createDataApiDatabase({...options,client});}
test('Data API query uses bound named values, JSON result formatting and scoped resource credentials',async()=>{
  const {client,calls}=fakeClient({records:'[{"n":7}]'});const db=database(client);
  assert.deepEqual(await db.query('select :name as n',{name:7}),{rows:[{n:7}]});
  const call=calls[0];assert.equal(call.name,'ExecuteStatementCommand');assert.equal(call.input.resourceArn,options.resourceArn);assert.equal(call.input.secretArn,options.secretArn);assert.equal(call.input.formatRecordsAs,'JSON');assert.equal(call.input.includeResultMetadata,false);assert.deepEqual(call.input.parameters,[{name:'name',value:{longValue:7}}]);assert.equal('schema'in call.input,false);
});
test('Data API transactions commit only after successful work and roll back on query or commit failure',async()=>{
  for(const change of [{},{failExecute:true},{failCommit:true}]){
    const {client,calls}=fakeClient(change);const db=database(client);const work=()=>db.transaction(async tx=>{await tx.query('select 1');return'complete';});
    if(change.failExecute||change.failCommit)await assert.rejects(work,/database.*unavailable/i);else assert.equal(await work(),'complete');
    assert.equal(calls[0].name,'BeginTransactionCommand');assert.equal(calls[1].input.transactionId,'tx-private');assert.equal(calls.at(-1).name,change.failExecute||change.failCommit?'RollbackTransactionCommand':'CommitTransactionCommand');
  }
});
test('Data API maps JSON, null, strings and booleans without interpolating values into SQL',async()=>{
  const {client,calls}=fakeClient({records:'[]'});const db=database(client);
  await db.query('select :payload,:empty,:flag,:label',{payload:{user:'private'},empty:null,flag:true,label:"'; drop table auth.users; --"});
  const call=calls[0].input;assert.equal(call.sql,'select :payload,:empty,:flag,:label');assert.equal(call.parameters[0].typeHint,'JSON');assert.deepEqual(call.parameters[1].value,{isNull:true});assert.deepEqual(call.parameters[2].value,{booleanValue:true});assert.equal(call.parameters[3].value.stringValue,"'; drop table auth.users; --");
  await assert.rejects(()=>db.query('select 1',{'bad-name':1}),/parameter/i);
  await assert.rejects(()=>db.query('select :n',{n:Infinity}),/parameter/i);
});
test('Data API malformed and oversized responses fail without exposing raw credentials',async()=>{
  for(const records of ['not-json','{}','[null]','[{"a":"'+ 'x'.repeat(10*1024*1024)+'"}]']){
    const {client}=fakeClient({records});await assert.rejects(()=>database(client).query('select 1'),error=>!/password|not-json|x{50}/.test(error.message));
  }
});
test('authenticated RPC verifies the caller before binding transaction-local identity and role',async()=>{
  assert.equal(typeof implementation.createAwsDatabaseBackend,'function','An AWS caller-scoped RPC adapter must exist.');const calls=[];
  const db={transaction:async fn=>fn({query:async(sql,params)=>{calls.push({sql,params});return{rows:sql.includes(' as part')?[{part:'{"balance_cents":1000000}'}]:[]};}})};
  const auth={authenticate:async token=>{assert.equal(token,'opaque-user-token');return{id:'11111111-1111-4111-8111-111111111111',email:'private@example.com'};},auth:async()=>({})};
  const backend=implementation.createAwsDatabaseBackend({database:db,...auth});const result=await backend.rpc('beter_portfolio',{},'opaque-user-token');assert.equal(result.balance_cents,1000000);
  assert.match(calls[0].sql,/set_config/);assert.equal(calls[0].params.subject,'11111111-1111-4111-8111-111111111111');assert.equal(calls[1].sql,'set local role authenticated');assert.match(calls[2].sql,/substr.*4096/s);assert.match(calls[2].sql,/beter_portfolio/);assert.doesNotMatch(calls[2].sql,/private@example/);
});
test('RPC rejects namespace injection and auth failures before starting a database transaction',async()=>{
  assert.equal(typeof implementation.createAwsDatabaseBackend,'function');let called=0;
  const backend=implementation.createAwsDatabaseBackend({database:{transaction:async()=>{called++;}},authenticate:async()=>{throw Error('Authentication required');},auth:async()=>({})});
  for(const [name,args] of [['beter_x;drop table auth.users',{}],['other_function',{}],['beter_portfolio',{'p_bad;':1}]])await assert.rejects(()=>backend.rpc(name,args,'user'),/invalid/i);
  await assert.rejects(()=>backend.rpc('beter_portfolio',{},'bad-user'),/authentication/i);assert.equal(called,0);
});
test('anonymous and service RPCs use only their fixed server-selected role, including chunk reassembly',async()=>{
  assert.equal(typeof implementation.createAwsDatabaseBackend,'function');const calls=[];const text=JSON.stringify({data:'x'.repeat(90000)});
  const db={transaction:async fn=>fn({query:async(sql,params)=>{calls.push({sql,params});return{rows:sql.includes(' as part')?Array.from({length:Math.ceil(text.length/4096)},(_,i)=>({part:text.slice(i*4096,(i+1)*4096)})):[]};}})};
  const backend=implementation.createAwsDatabaseBackend({database:db,authenticate:async()=>{throw Error('should not authenticate internal worker');},auth:async()=>({})});
  assert.equal((await backend.rpc('beter_health',{},'$service')).data.length,90000);assert.equal(calls[1].sql,'set local role service_role');calls.length=0;await backend.rpc('beter_markets');assert.equal(calls[1].sql,'set local role anon');
});
test('private auth-store queries preserve a missing session as JSON null and never put hashes in SQL',async()=>{
  assert.equal(typeof implementation.createAwsAuthStore,'function');const calls=[];
  const db={transaction:async fn=>fn({query:async(sql,parameters)=>{calls.push({sql,parameters});return{rows:sql.includes(' as part')?[{part:'null'}]:[]};}})};
  const store=implementation.createAwsAuthStore(db);assert.equal(await store.getSessionByAccessHash('a'.repeat(64)),null);assert.doesNotMatch(calls.at(-1).sql,/a{64}/);assert.equal(calls[1].sql,'set local role service_role');
});
