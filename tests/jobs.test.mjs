import test from 'node:test';
import assert from 'node:assert/strict';
const {runBackgroundJobs}=await import('../server/jobs.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const result={id:'game',completed:true,home_team:'Home',away_team:'Away',home_score:110,away_score:100,updated_at:'2026-11-19T22:00:00Z'};
const bet={id:'bet',selections:[{id:'pick',team:'Home',side:'home',market:'Moneyline',line:null,odds:-110}]};
const event={id:'game',sport:'Basketball',league:'NBA',home_team:'Home',away_team:'Away',bets:[bet]};
const setup=(overrides={})=>{assert.equal(typeof runBackgroundJobs,'function','Automated ingestion and settlement jobs must exist.');const calls=[];return{calls,options:{sports:['basketball_nba'],backend:{rpc:async(name,args,token)=>{calls.push({name,args,token});if(name==='beter_settlement_candidates')return[event];if(name==='beter_health')return{jobs:[]};if(name==='beter_settlement_batch')return{events:[event],nextCursor:null};return{};}},provider:{getEvents:async()=>[],getResults:async()=>[result]},...overrides}};};
test('background jobs ingest markets and grade accepted snapshots by bet id',async()=>{const {calls,options}=setup();const report=await runBackgroundJobs(options);assert.equal(report.errors,0);const settlement=calls.find(c=>c.name==='beter_settle');assert.equal(settlement.token,'$service');assert.deepEqual(settlement.args.p_outcomes,[{bet_id:'bet',status:'won'}]);assert.ok(settlement.args.p_result_version);});
test('incomplete results are never settled',async()=>{const {calls,options}=setup({provider:{getEvents:async()=>[],getResults:async()=>[{...result,completed:false}]}});await runBackgroundJobs(options);assert.equal(calls.some(c=>c.name==='beter_settle'),false);});
test('provider failures are counted and recorded without leaking raw secrets',async()=>{const {calls,options}=setup({provider:{getEvents:async()=>{throw new Error('key=secret');},getResults:async()=>[]}});const report=await runBackgroundJobs(options);assert.ok(report.errors>0);assert.ok(calls.some(c=>c.name==='beter_job_record'));assert.doesNotMatch(JSON.stringify(calls),/key=secret/);});
test('ambiguous score evidence goes to review and does not create a payout',async()=>{const {calls,options}=setup({provider:{getEvents:async()=>[],getResults:async()=>[{...result,home_team:'Wrong team'}]}});const report=await runBackgroundJobs(options);assert.ok(report.errors>0);assert.equal(calls.some(c=>c.name==='beter_settle'),false);});

const instant=new Date('2026-11-20T12:00:00Z');
const pending=(hours,status='open')=>({...event,starts_at:new Date(instant.getTime()-hours*3600000).toISOString(),bets:[{...bet,status}]});
function jobsFixture({events=[pending(100)],results=[],health={jobs:[]},nextCursor=null,failures={}}={}){
  const calls=[];
  return {calls,options:{now:()=>instant,sports:['basketball_nba'],backend:{rpc:async(name,args,token)=>{
    calls.push({name,args:structuredClone(args),token});
    if(failures[name])throw new Error('key=private-secret '+name);
    if(name==='beter_settlement_candidates')return events;
    if(name==='beter_health')return health;
    if(name==='beter_settlement_batch')return{events,nextCursor};
    if(name==='beter_settle')return{applied:1};
    return{};
  }},provider:{getEvents:async()=>[],getResults:async()=>results}}};
}
test('overdue missing results enter review and cannot produce a successful pipeline',async()=>{
  const {calls,options}=jobsFixture();const report=await runBackgroundJobs(options);
  assert.equal(report.review,1);assert.ok(report.errors>0);
  const review=calls.find(c=>c.name==='beter_job_record'&&c.args.p_name==='review:game');
  assert.equal(review.args.p_ok,false);assert.equal(review.args.p_detail.code,'RESULT_MISSING');
  assert.equal(review.args.p_detail.eventId,'game');assert.equal(review.args.p_detail.ageHours,100);
  assert.equal(calls.find(c=>c.name==='beter_job_record'&&c.args.p_name==='pipeline').args.p_ok,false);
  assert.equal(calls.some(c=>c.name==='beter_settle'),false);
});
test('overdue incomplete results enter review without fabricating an outcome',async()=>{
  const {calls,options}=jobsFixture({results:[{...result,completed:false}]});const report=await runBackgroundJobs(options);
  assert.equal(report.review,1);assert.equal(calls.some(c=>c.name==='beter_settle'),false);
  assert.equal(calls.find(c=>c.name==='beter_job_record'&&c.args.p_name==='review:game').args.p_detail.code,'RESULT_INCOMPLETE');
});
test('future games and games at the six-hour threshold are normally pending',async()=>{
  const {calls,options}=jobsFixture({events:[{...pending(-1),id:'future'},{...pending(6),id:'threshold'}]});
  const report=await runBackgroundJobs(options);assert.equal(report.review,0);assert.equal(report.errors,0);
  assert.equal(calls.some(c=>c.args?.p_name?.startsWith('review:')),false);
});
test('missing scores for already settled correction candidates do not create overdue reviews',async()=>{
  const {options}=jobsFixture({events:[pending(100,'won')]});const report=await runBackgroundJobs(options);assert.equal(report.review,0);
});
test('result retrieval failure identifies overdue events without exposing the original exception',async()=>{
  const {calls,options}=jobsFixture();options.provider.getResults=async()=>{throw new Error('key=private-secret');};
  const report=await runBackgroundJobs(options);assert.equal(report.review,1);
  assert.equal(calls.find(c=>c.args?.p_name==='review:game').args.p_detail.code,'RESULT_RETRIEVAL_FAILED');
  assert.doesNotMatch(JSON.stringify(calls),/private-secret/);
});
test('candidate failures record an unsuccessful pipeline instead of losing its heartbeat',async()=>{
  const {calls,options}=jobsFixture({failures:{beter_settlement_batch:true}});const report=await runBackgroundJobs(options);
  assert.ok(report.errors>0);assert.equal(calls.find(c=>c.args?.p_name==='pipeline').args.p_ok,false);
  assert.doesNotMatch(JSON.stringify(calls),/private-secret/);
});
test('bounded passes resume from the durable pipeline cursor and advance for the next invocation',async()=>{
  const {calls,options}=jobsFixture({events:[],health:{jobs:[{name:'pipeline',detail:{nextCursor:'event-100'}}]},nextCursor:'event-200'});
  options.batchSize=100;const report=await runBackgroundJobs(options);
  assert.deepEqual(calls.find(c=>c.name==='beter_settlement_batch').args,{p_after:'event-100',p_limit:100});
  assert.equal(report.nextCursor,'event-200');
  assert.equal(calls.find(c=>c.args?.p_name==='pipeline').args.p_detail.nextCursor,'event-200');
});
test('successful final evidence clears a previously recorded review without adding another payout',async()=>{
  const {calls,options}=jobsFixture({results:[result],health:{jobs:[{name:'review:game',ok:false}]}});
  const report=await runBackgroundJobs(options);assert.equal(report.errors,0);assert.equal(report.settled,1);
  assert.equal(calls.find(c=>c.args?.p_name==='review:game').args.p_ok,true);
});
test('worker performs bounded maintenance and fails visibly when retention cannot run',async()=>{
  const {calls,options}=jobsFixture({events:[],failures:{beter_maintenance:true}});const report=await runBackgroundJobs(options);
  assert.ok(report.errors>0);assert.deepEqual(calls.find(c=>c.name==='beter_maintenance').args,{p_batch_size:1000});
  assert.equal(calls.find(c=>c.args?.p_name==='pipeline').args.p_ok,false);
});

test('long provider event IDs keep review job names within the database limit',async()=>{
  const id='x'.repeat(250);const {calls,options}=jobsFixture({events:[{...pending(100),id}]});
  await runBackgroundJobs(options);const review=calls.find(c=>c.args?.p_name?.startsWith('review:'));
  assert.ok(review);assert.ok(review.args.p_name.length<=100);assert.equal(review.args.p_detail.eventId,id);
});

test('review names use Unicode character boundaries consistently with PostgreSQL',async()=>{
  const id='🏀'.repeat(46);const {calls,options}=jobsFixture({events:[{...pending(100),id}]});
  await runBackgroundJobs(options);assert.equal(calls.find(c=>c.args?.p_name?.startsWith('review:')).args.p_name,'review:'+id);
});
