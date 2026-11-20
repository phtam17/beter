import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SecretsManagerClient} from '@aws-sdk/client-secrets-manager';
const implementation=await import('../server/aws-runtime.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const env={NODE_ENV:'production',BETER_BACKEND:'aws',BETER_ENVIRONMENT:'staging',BETER_DATA_MODE:'sample',AWS_REGION:'us-west-2',SITE_URL:'https://staging.example.com',BETER_DATABASE_RESOURCE_ARN:'arn:aws:rds:us-west-2:123456789012:cluster:beter-staging',BETER_DATABASE_SECRET_ARN:'arn:aws:secretsmanager:us-west-2:123456789012:secret:beter-db-abcdef',BETER_DATABASE_NAME:'beter',BETER_COGNITO_CLIENT_ID:'client123',BETER_COGNITO_USER_POOL_ID:'us-west-2_Pool123',BETER_RUNTIME_SECRET_ARN:'arn:aws:secretsmanager:us-west-2:123456789012:secret:beter-runtime-abcdef'};
const privateValues={sessionSecret:'s'.repeat(48),jobSecret:'j'.repeat(48),originSecret:'o'.repeat(48),oddsApiKey:''};
function fixture({secret=JSON.stringify(privateValues),secretError=false,gate}={}){
  const calls=[];let closed=0;
  const database={query:async()=>({rows:[]}),transaction:async operation=>operation({query:async(sql,parameters)=>{calls.push({sql,parameters});let result={ok:true};if(sql.includes('beter_auth_limit'))result={allowed:true,retry_after_seconds:0};else if(sql.includes('beter_health'))result={schema_version:4,jobs:[]};else if(sql.includes('beter_settlement_batch'))result={events:[],nextCursor:null};else if(sql.includes('beter_markets'))result={events:[]};return{rows:sql.includes(' as part')?[{part:JSON.stringify(result)}]:[]};}}),close:async()=>{closed++;}};
  const secretsCalls=[];const secretsClient={async send(command,options){secretsCalls.push({command,options});if(secretError)throw Error('private-provider-key arn:private password=private');return{SecretString:secret};}};
  const cognitoCalls=[];const cognitoClient={async send(command){cognitoCalls.push(command);return{};}};
  const provider={async getEvents(){if(gate)await gate;return[];},async getResults(){return[];}};
  return{calls,secretsCalls,cognitoCalls,database,secretsClient,cognitoClient,provider,closed:()=>closed};
}
async function runtime(options={}){assert.equal(typeof implementation.createAwsRuntime,'function','The AWS runtime must connect private settings, Cognito, database, API and workers.');return implementation.createAwsRuntime({env,...options});}
test('AWS startup loads trusted private settings before configuration and exposes only public API settings',async()=>{
  const f=fixture();const app=await runtime({...f,env:{...env,BETER_SESSION_SECRET:'wrong',JOB_SECRET:'wrong',ODDS_API_KEY:'untrusted',BETER_ORIGIN_SECRET:'wrong'}});
  assert.equal(app.settings.mode,'aws');assert.equal(app.settings.sessionSecret,privateValues.sessionSecret);assert.equal(app.jobSecret,privateValues.jobSecret);assert.equal(app.originSecret,privateValues.originSecret);assert.equal(app.settings.oddsApiKey,'');
  const call=f.secretsCalls[0];assert.equal(call.command.constructor.name,'GetSecretValueCommand');assert.equal(call.command.input.SecretId,env.BETER_RUNTIME_SECRET_ARN);assert.ok(call.options.abortSignal);
  const response=await app.handle(new Request('https://staging.example.com/api/config'));assert.equal(response.status,200);const text=await response.text();assert.equal(JSON.parse(text).mode,'aws');for(const value of Object.values(privateValues).filter(Boolean))assert.ok(!text.includes(value));assert.doesNotMatch(text,/arn:aws|sessionSecret|originSecret|jobSecret|databaseSecretArn/);await app.close();assert.equal(f.closed(),1);
});
test('AWS startup rejects missing runtime secrets, malformed content and provider failures without private errors',async()=>{
  for(const change of [{secretError:true},{secret:'not json'},{secret:'null'},{secret:'[]'},{secret:JSON.stringify({...privateValues,unexpected:'private'})},{secret:JSON.stringify({...privateValues,sessionSecret:'short'})},{secret:JSON.stringify({...privateValues,oddsApiKey:42})},{secret:undefined,secretError:true}]){
    const f=fixture(change);await assert.rejects(()=>runtime(f),error=>{assert.equal(error.code,'AWS_RUNTIME_UNAVAILABLE');assert.doesNotMatch(error.message,/private-provider-key|arn:private|password=|not json/);return true;});assert.equal(f.calls.length,0);
  }
  for(const change of [{BETER_RUNTIME_SECRET_ARN:undefined},{AWS_REGION:undefined},{BETER_BACKEND:'local'}]){const f=fixture();await assert.rejects(()=>runtime({...f,env:{...env,...change}}));assert.equal(f.secretsCalls.length,0);}
});
test('AWS API composes persistent shared auth limits using only the verified AWS source address',async()=>{
  const f=fixture();const app=await runtime(f);const response=await app.handle(new Request('https://staging.example.com/api/auth/recover',{method:'POST',headers:{'Content-Type':'application/json','x-beter-source-ip':'203.0.113.4','x-forwarded-for':'198.51.100.1'},body:JSON.stringify({email:'member@example.com'})}));
  assert.equal(response.status,200);assert.equal(f.cognitoCalls[0].constructor.name,'ForgotPasswordCommand');const buckets=f.calls.find(call=>call.sql.includes('beter_auth_limit')).parameters.p_buckets;assert.equal(buckets.length,3);assert.deepEqual(buckets.map(bucket=>bucket.kind),['global','recovery','source']);assert.ok(buckets.every(bucket=>/^[a-f0-9]{64}$/.test(bucket.key)));assert.ok(f.calls.some(call=>call.sql==='set local role service_role'));await app.close();
});
test('AWS workers coalesce concurrent processing and close waits for the running pass',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const f=fixture({gate});const app=await runtime(f);const first=app.runJobs(),second=app.runJobs();let finished=false;const close=app.close().then(()=>{finished=true;});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(finished,false);assert.equal(f.closed(),0);release();const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);assert.equal(a.errors,0);assert.equal(f.calls.filter(call=>call.sql.includes('public.beter_ingest_events')).length,3);await close;await app.close();assert.equal(f.closed(),1);await assert.rejects(()=>app.runJobs(),/closed/i);
});
test('AWS runtime uses the SDK-shaped Data API transport when no database is injected',async()=>{
  const f=fixture();const commands=[];const dataApiClient={async send(command){commands.push(command);if(command.constructor.name==='BeginTransactionCommand')return{transactionId:'test-tx'};if(command.constructor.name==='ExecuteStatementCommand')return{formattedRecords:JSON.stringify(command.input.sql.includes(' as part')?[{part:'{"events":[]}'}]:[])};return{};}};
  const app=await runtime({secretsClient:f.secretsClient,cognitoClient:f.cognitoClient,dataApiClient});const response=await app.handle(new Request('https://staging.example.com/api/markets'));assert.equal(response.status,200);assert.ok(commands.some(command=>command.constructor.name==='ExecuteStatementCommand'&&command.input.secretArn===env.BETER_DATABASE_SECRET_ARN));assert.ok(commands.some(command=>command.constructor.name==='CommitTransactionCommand'));await app.close();
});
test('AWS entry stays independent from local database code and TypeScript includes deployment entrypoints',async()=>{
  assert.equal(typeof implementation.createAwsRuntime,'function');const source=await readFile(new URL('../server/aws-runtime.ts',import.meta.url),'utf8');assert.doesNotMatch(source,/['"]\.\/runtime\.ts|pglite|['"]\.\/local\.ts/i);const config=JSON.parse(await readFile(new URL('../tsconfig.json',import.meta.url),'utf8'));assert.ok(config.include.includes('aws/**/*.ts'));
});
test('private settings retrieval has a bounded deadline and aborts stalled AWS calls',async()=>{
  const f=fixture();let signal;const secretsClient={send(_command,options){signal=options.abortSignal;return new Promise(()=>{});}};
  await assert.rejects(()=>runtime({...f,secretsClient,secretTimeoutMs:5}),error=>error.code==='AWS_RUNTIME_UNAVAILABLE');assert.equal(signal.aborted,true);assert.equal(f.calls.length,0);
  for(const secretTimeoutMs of [0,NaN,-1]){const f=fixture();await assert.rejects(()=>runtime({...f,secretTimeoutMs}));assert.equal(f.secretsCalls.length,0);}
});
test('AWS runtime rejects binary-only private settings and incomplete service configuration safely',async()=>{
  const f=fixture();await assert.rejects(()=>runtime({...f,secretsClient:{send:async()=>({SecretBinary:new Uint8Array([1,2])})}}),error=>error.code==='AWS_RUNTIME_UNAVAILABLE');
  await assert.rejects(()=>runtime({...f,env:{...env,BETER_DATABASE_SECRET_ARN:'private invalid secret'}}),error=>error.code==='AWS_RUNTIME_UNAVAILABLE'&&!error.message.includes('private invalid secret'));assert.equal(f.calls.length,0);
});
test('AWS runtime defaults to process settings and owned SDK clients without loading local storage',async t=>{
  const f=fixture({secret:JSON.stringify({...privateValues,oddsApiKey:'live-private-provider-key'})});const previous={};
  const values={...env,BETER_ENVIRONMENT:'production',BETER_DATA_MODE:'live'};
  for(const [key,value]of Object.entries(values)){previous[key]=process.env[key];process.env[key]=value;}
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  t.mock.method(SecretsManagerClient.prototype,'send',f.secretsClient.send);
  assert.equal(typeof implementation.createAwsRuntime,'function');const app=await implementation.createAwsRuntime({database:f.database});assert.equal(app.settings.dataMode,'live');assert.equal(app.settings.oddsApiKey,'live-private-provider-key');assert.equal((await app.handle(new Request('https://staging.example.com/api/health'))).status,200);await app.close();assert.equal(f.closed(),1);
});
