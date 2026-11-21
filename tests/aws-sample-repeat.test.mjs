import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleProvider} from '../server/provider.ts';
import {readSettings} from '../server/config.ts';
import {createAwsRuntime} from '../server/aws-runtime.ts';
const startsAt=new Date('2026-11-20T20:00:00.000Z'),durationMs=120000,repeatMs=600000;
const provider=offset=>createSampleProvider({startsAt,durationMs,repeatMs,now:()=>new Date(startsAt.getTime()+offset)});
const env={BETER_BACKEND:'aws',BETER_ENVIRONMENT:'staging',BETER_DATA_MODE:'sample',BETER_SAMPLE_START_AT:startsAt.toISOString(),BETER_SAMPLE_DURATION_SECONDS:'120',AWS_REGION:'us-west-2',SITE_URL:'https://staging.example.com',BETER_DATABASE_RESOURCE_ARN:'arn:aws:rds:us-west-2:123456789012:cluster:beter-staging',BETER_DATABASE_SECRET_ARN:'arn:aws:secretsmanager:us-west-2:123456789012:secret:db',BETER_DATABASE_NAME:'beter',BETER_COGNITO_CLIENT_ID:'client123',BETER_COGNITO_USER_POOL_ID:'us-west-2_Pool123',BETER_RUNTIME_SECRET_ARN:'arn:aws:secretsmanager:us-west-2:123456789012:secret:runtime',BETER_SESSION_SECRET:'s'.repeat(48),JOB_SECRET:'j'.repeat(48),BETER_ORIGIN_SECRET:'o'.repeat(48)};
test('repeating samples offer the next future round with stable epoch IDs across cold factories',async()=>{
  for(const [offset,index]of [[-1,0],[0,1],[repeatMs-1,1],[repeatMs,2],[repeatMs*3+1,4]]){
    for(const sport of ['basketball_nba','americanfootball_nfl','icehockey_nhl']){
      const first=(await provider(offset).getEvents(sport))[0],same=(await provider(offset).getEvents(sport))[0];assert.equal(first.starts_at,new Date(startsAt.getTime()+index*repeatMs).toISOString());assert.equal(first.status,'upcoming');assert.equal(first.id,same.id);assert.ok(first.id.endsWith('-'+(startsAt.getTime()+index*repeatMs)));
    }
  }
  assert.equal((await provider(-1).getEvents())[0].id,(await createSampleProvider({startsAt,durationMs,now:()=>new Date(startsAt.getTime()-1)}).getEvents())[0].id);
});
test('repeating results preserve accepted earlier round IDs and finalize only after each duration',async()=>{
  const before=(await provider(-1).getEvents())[0];assert.equal((await provider(-1).getResults())[0].id,before.id);assert.equal((await provider(durationMs-1).getResults())[0].completed,false);assert.equal((await provider(durationMs).getResults())[0].completed,true);
  const results=await provider(repeatMs+durationMs).getResults();assert.equal(results.length,2);assert.equal(results[0].id,'sample-nba-1-'+(startsAt.getTime()+repeatMs));assert.equal(results[1].id,before.id);assert.ok(results.every(result=>result.completed));assert.equal(results[1].updated_at,new Date(startsAt.getTime()+durationMs).toISOString());
});
test('results retain the 72-hour correction boundary and stay bounded for a long-running preview',async()=>{
  const boundary=72*3600000+durationMs,baseId=(await provider(-1).getEvents())[0].id;
  assert.ok((await provider(boundary).getResults()).some(result=>result.id===baseId));assert.ok(!(await provider(boundary+1).getResults()).some(result=>result.id===baseId));
  const offset=repeatMs*1000+durationMs,results=await provider(offset).getResults();assert.ok(results.length>400&&results.length<=434);assert.equal(new Set(results.map(result=>result.id)).size,results.length);assert.ok(results.every(result=>!result.completed||Date.parse(result.updated_at)>=startsAt.getTime()+offset-72*3600000));
});
test('provider repeat bounds require at least ten minutes, at most one day and a minute after duration',()=>{
  for(const repeatMs of [599999,86400001,NaN,600000.5,120000])assert.throws(()=>createSampleProvider({startsAt,durationMs,repeatMs}),/sample.*valid|repeat/i);
  assert.throws(()=>createSampleProvider({startsAt,durationMs:600000,repeatMs:600000}),/sample.*valid|repeat/i);assert.ok(createSampleProvider({startsAt,durationMs:540000,repeatMs:600000}));
});
test('AWS repeating sample configuration is optional, bounded and restricted to staging sample mode',()=>{
  assert.equal(readSettings(env).sampleRepeatMs,undefined);assert.equal(readSettings({...env,BETER_SAMPLE_REPEAT_SECONDS:'600'}).sampleRepeatMs,600000);assert.equal(readSettings({...env,BETER_SAMPLE_REPEAT_SECONDS:'86400'}).sampleRepeatMs,86400000);
  for(const value of ['599','86401','','NaN','600.5'])assert.throws(()=>readSettings({...env,BETER_SAMPLE_REPEAT_SECONDS:value}),/sample.*repeat|repeat.*sample/i);
  assert.throws(()=>readSettings({...env,BETER_SAMPLE_DURATION_SECONDS:'600',BETER_SAMPLE_REPEAT_SECONDS:'600'}),/sample.*repeat|repeat.*sample/i);assert.equal(readSettings({...env,BETER_SAMPLE_DURATION_SECONDS:'600',BETER_SAMPLE_REPEAT_SECONDS:'660'}).sampleRepeatMs,660000);
  assert.throws(()=>readSettings({BETER_SAMPLE_REPEAT_SECONDS:'21600'}),/sample.*staging|staging.*sample/i);assert.throws(()=>readSettings({...env,BETER_DATA_MODE:'live',BETER_SAMPLE_START_AT:undefined,BETER_SAMPLE_DURATION_SECONDS:undefined,BETER_SAMPLE_REPEAT_SECONDS:'21600',ODDS_API_KEY:'key'}),/sample.*staging|staging.*sample/i);
});
test('separate AWS runtimes ingest future rounds while settling accepted bets from the previous round',async()=>{
  const accepted=(await provider(-60000).getEvents())[0],selection=accepted.selections.find(item=>item.market==='Moneyline'&&item.side==='home');let offset=-60000;const ingested=[],settlements=[];
  const database={query:async()=>({rows:[]}),transaction:async operation=>operation({query:async(sql,parameters)=>{let result={ok:true};if(sql.includes('public.beter_ingest_events'))ingested.push(parameters.p_events);else if(sql.includes('public.beter_health'))result={jobs:[]};else if(sql.includes('public.beter_settlement_batch'))result={events:offset>=durationMs?[{...accepted,bets:[{id:'11111111-1111-4111-8111-111111111111',status:'open',selections:[selection]}]}]:[],nextCursor:null};else if(sql.includes('public.beter_settle(')){settlements.push(parameters);result={applied:1};}return{rows:sql.includes(' as part')?[{part:JSON.stringify(result)}]:[]};}})};
  const secretsClient={send:async()=>({SecretString:JSON.stringify({sessionSecret:env.BETER_SESSION_SECRET,jobSecret:env.JOB_SECRET,originSecret:env.BETER_ORIGIN_SECRET,oddsApiKey:''})})};
  for(const instant of [-60000,durationMs+1000]){offset=instant;const app=await createAwsRuntime({env:{...env,BETER_SAMPLE_REPEAT_SECONDS:'600'},database,secretsClient,cognitoClient:{send:async()=>({})},now:()=>new Date(startsAt.getTime()+offset)});const report=await app.runJobs();assert.equal(report.errors,0);await app.close();}
  assert.equal(ingested.length,6);assert.equal(ingested[0][0].id,accepted.id);assert.equal(ingested[3][0].starts_at,new Date(startsAt.getTime()+repeatMs).toISOString());assert.notEqual(ingested[3][0].id,accepted.id);assert.equal(settlements.length,1);assert.equal(settlements[0].p_event_id,accepted.id);assert.equal(settlements[0].p_outcomes[0].status,'won');
});
