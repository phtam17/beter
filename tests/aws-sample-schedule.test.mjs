import test from 'node:test';
import assert from 'node:assert/strict';
import {createSampleProvider} from '../server/provider.ts';
import {readSettings} from '../server/config.ts';
import {createAwsRuntime} from '../server/aws-runtime.ts';
const startsAt=new Date('2026-11-20T20:00:00.000Z');
const env={BETER_BACKEND:'aws',BETER_ENVIRONMENT:'staging',BETER_DATA_MODE:'sample',BETER_SAMPLE_START_AT:startsAt.toISOString(),AWS_REGION:'us-west-2',SITE_URL:'https://staging.example.com',BETER_DATABASE_RESOURCE_ARN:'arn:aws:rds:us-west-2:123456789012:cluster:beter-staging',BETER_DATABASE_SECRET_ARN:'arn:aws:secretsmanager:us-west-2:123456789012:secret:db',BETER_DATABASE_NAME:'beter',BETER_COGNITO_CLIENT_ID:'client123',BETER_COGNITO_USER_POOL_ID:'us-west-2_Pool123',BETER_RUNTIME_SECRET_ARN:'arn:aws:secretsmanager:us-west-2:123456789012:secret:runtime',BETER_SESSION_SECRET:'s'.repeat(48),JOB_SECRET:'j'.repeat(48),BETER_ORIGIN_SECRET:'o'.repeat(48)};
test('separate cold sample factories share one absolute start and final time',async()=>{
  for(const [offset,status,completed] of [[-1,'upcoming',false],[0,'live',false],[119999,'live',false],[120000,'final',true]]){
    const provider=createSampleProvider({startsAt,durationMs:120000,now:()=>new Date(startsAt.getTime()+offset)});const event=(await provider.getEvents())[0],result=(await provider.getResults())[0];assert.equal(event.starts_at,startsAt.toISOString());assert.equal(event.status,status);assert.equal(result.completed,completed);if(completed)assert.equal(result.updated_at,'2026-11-20T20:02:00.000Z');
  }
});
test('explicit sample epochs have stable distinct event IDs and matching result IDs',async()=>{
  for(const sport of ['basketball_nba','americanfootball_nfl','icehockey_nhl']){
    const first=createSampleProvider({startsAt,now:()=>new Date(startsAt)}),same=createSampleProvider({startsAt:new Date(startsAt),now:()=>new Date(startsAt.getTime()+1000)}),next=createSampleProvider({startsAt:new Date(startsAt.getTime()+1),now:()=>new Date(startsAt.getTime()+1000)});
    const a=(await first.getEvents(sport))[0],b=(await same.getEvents(sport))[0],c=(await next.getEvents(sport))[0];assert.equal(a.id,b.id);assert.notEqual(a.id,c.id);assert.equal((await first.getResults(sport))[0].id,a.id);assert.equal((await next.getResults(sport))[0].id,c.id);
  }
  assert.equal((await createSampleProvider({now:()=>new Date(startsAt)}).getEvents())[0].id,'sample-nba-1');
});
test('sample options reject invalid dates, clocks and durations while preserving local defaults',async()=>{
  for(const options of [{startsAt:new Date(NaN)},{startsAt:'2026-11-20'},{durationMs:59999},{durationMs:10800001},{durationMs:NaN},{durationMs:60000.5},{now:()=>new Date(NaN)}])assert.throws(()=>createSampleProvider(options),/sample.*valid|valid.*sample/i);
  const now=new Date('2026-11-20T12:00:00.000Z'),provider=createSampleProvider({now:()=>now});assert.equal((await provider.getEvents())[0].starts_at,'2026-11-20T13:00:00.000Z');assert.equal((await provider.getResults())[0].completed,false);
  const mutable=new Date(startsAt);const fixed=createSampleProvider({startsAt:mutable,now:()=>new Date(startsAt.getTime()-1)});mutable.setUTCFullYear(2030);assert.equal((await fixed.getEvents())[0].starts_at,startsAt.toISOString());
});
test('AWS sample settings require a valid absolute timestamp and bound the explicit duration',()=>{
  const settings=readSettings(env);assert.equal(settings.sampleStartsAt,startsAt.toISOString());assert.equal(settings.sampleDurationMs,10800000);assert.equal(readSettings({...env,BETER_SAMPLE_DURATION_SECONDS:'60'}).sampleDurationMs,60000);assert.equal(readSettings({...env,BETER_SAMPLE_DURATION_SECONDS:'10800'}).sampleDurationMs,10800000);
  for(const value of [undefined,'','not-a-date','2026-02-30T20:00:00.000Z','2026-11-20'])assert.throws(()=>readSettings({...env,BETER_SAMPLE_START_AT:value}),/sample.*start|timestamp/i);
  for(const value of ['0','59','10801','60.5','NaN',''])assert.throws(()=>readSettings({...env,BETER_SAMPLE_DURATION_SECONDS:value}),/sample.*duration/i);
});
test('sample schedule overrides are refused outside explicit AWS staging sample mode',()=>{
  for(const change of [{BETER_BACKEND:'local'},{BETER_ENVIRONMENT:'production',BETER_DATA_MODE:'live',ODDS_API_KEY:'key'},{BETER_DATA_MODE:'live',ODDS_API_KEY:'key'}])assert.throws(()=>readSettings({...env,...change}),/sample.*staging|staging.*sample/i);
  assert.throws(()=>readSettings({BETER_SAMPLE_DURATION_SECONDS:'120'}),/sample.*staging|staging.*sample/i);
});
test('separate AWS runtimes inject the fixed sample timeline into worker ingestion',async()=>{
  const seen=[];const database={query:async()=>({rows:[]}),transaction:async operation=>operation({query:async(sql,parameters)=>{let result={ok:true};if(sql.includes('public.beter_ingest_events'))seen.push(parameters.p_events);else if(sql.includes('public.beter_health'))result={jobs:[]};else if(sql.includes('public.beter_settlement_batch'))result={events:[],nextCursor:null};return{rows:sql.includes(' as part')?[{part:JSON.stringify(result)}]:[]};}})};
  const secretsClient={send:async()=>({SecretString:JSON.stringify({sessionSecret:env.BETER_SESSION_SECRET,jobSecret:env.JOB_SECRET,originSecret:env.BETER_ORIGIN_SECRET,oddsApiKey:''})})};
  for(const offset of [-60000,120000]){const app=await createAwsRuntime({env:{...env,BETER_SAMPLE_DURATION_SECONDS:'120'},secretsClient,cognitoClient:{send:async()=>({})},database,now:()=>new Date(startsAt.getTime()+offset)});const report=await app.runJobs();assert.equal(report.errors,0);await app.close();}
  assert.equal(seen.length,6);assert.ok(seen.every(events=>events[0].starts_at===startsAt.toISOString()));assert.ok(seen.slice(0,3).every(events=>events[0].status==='upcoming'));assert.ok(seen.slice(3).every(events=>events[0].status==='final'));
});
