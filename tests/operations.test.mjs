import test from 'node:test';
import assert from 'node:assert/strict';
const {evaluateReadiness}=await import('../server/operations.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const now=new Date('2026-11-20T12:00:00Z');
const stamp=seconds=>new Date(now.getTime()-seconds*1000).toISOString();
const healthy=()=>({ledger_mismatches:0,unsettled_bets:0,jobs:[
  {name:'pipeline',ok:true,created_at:stamp(30),detail:{nextCursor:null}},
  ...['basketball_nba','americanfootball_nfl','icehockey_nhl'].map(sport=>({name:'odds:'+sport,ok:true,created_at:stamp(30)})),
]});
const evaluate=(health,options={})=>{assert.equal(typeof evaluateReadiness,'function','Readiness must evaluate durable worker and ledger health.');return evaluateReadiness(health,{now:()=>now,...options});};
test('a fresh successful worker with reconciled balances is ready',()=>{
  const result=evaluate(healthy());assert.equal(result.ready,true);assert.ok(result.checks.every(check=>check.ok));
});
test('missing or malformed dependency health cannot report ready',()=>{
  for(const value of [null,{},[],{...healthy(),ledger_mismatches:'0'},{...healthy(),unsettled_bets:-1}])assert.equal(evaluate(value).ready,false);
});
test('a missing successful worker heartbeat blocks readiness',()=>{
  const health=healthy();health.jobs=health.jobs.filter(job=>job.name!=='pipeline');
  const result=evaluate(health);assert.equal(result.ready,false);assert.equal(result.checks.find(check=>check.name==='worker').code,'WORKER_MISSING');
});
test('a worker older than two scheduled intervals becomes unready',()=>{
  const health=healthy();health.jobs[0].created_at=stamp(151);
  const result=evaluate(health);assert.equal(result.ready,false);assert.equal(result.checks.find(check=>check.name==='worker').code,'WORKER_STALE');
});
test('a failed pipeline blocks readiness even when recently run',()=>{
  const health=healthy();health.jobs[0].ok=false;
  const result=evaluate(health);assert.equal(result.ready,false);assert.equal(result.checks.find(check=>check.name==='worker').code,'WORKER_FAILED');
});
test('ledger mismatches and overdue settlements have independent failing checks',()=>{
  const health={...healthy(),ledger_mismatches:1,unsettled_bets:2};const result=evaluate(health);
  assert.equal(result.checks.find(check=>check.name==='ledger').ok,false);assert.equal(result.checks.find(check=>check.name==='settlements').count,2);
});
test('missing, stale, failed, or future feed records block readiness',()=>{
  for(const change of ['missing','stale','failed','future']){
    const health=healthy();const job=health.jobs.find(job=>job.name==='odds:basketball_nba');
    if(change==='missing')health.jobs=health.jobs.filter(item=>item!==job);
    if(change==='stale')job.created_at=stamp(151);
    if(change==='failed')job.ok=false;
    if(change==='future')job.created_at=stamp(-31);
    assert.equal(evaluate(health).checks.find(check=>check.name==='ingestion').ok,false,change);
  }
});
test('recent job failures block readiness without disclosing private job details',()=>{
  const health=healthy();health.jobs.push({name:'maintenance',ok:false,created_at:stamp(20),detail:{error:'apiKey=private-secret',email:'private@example.com'}});
  const result=evaluate(health);assert.equal(result.ready,false);assert.equal(result.checks.find(check=>check.name==='failures').count,1);
  assert.doesNotMatch(JSON.stringify(result),/private-secret|private@example/);
});
test('obsolete transient failures do not permanently block a recovered worker',()=>{
  const health=healthy();health.jobs.push({name:'results:basketball_nba',ok:false,created_at:stamp(1000)});
  assert.equal(evaluate(health).ready,true);
});
test('readiness uses an injectable heartbeat budget and rejects an invalid clock',()=>{
  const health=healthy();health.jobs[0].created_at=stamp(180);
  assert.equal(evaluate(health,{maxHeartbeatAgeMs:240000}).ready,true);
  assert.equal(evaluate(healthy(),{now:()=>new Date('invalid')}).ready,false);
});

test('unresolved review records remain blocking after the transient failure window',()=>{
  const health=healthy();health.jobs.push({name:'review:game',ok:false,created_at:stamp(86400),detail:{private:'hidden'}});
  const result=evaluate(health);assert.equal(result.ready,false);
  assert.deepEqual(result.checks.find(check=>check.name==='reviews'),{name:'reviews',ok:false,code:'UNRESOLVED_REVIEWS',count:1});
  assert.doesNotMatch(JSON.stringify(result),/hidden|game/);
});
test('an explicitly resolved latest review record restores readiness',()=>{
  const health=healthy();health.jobs.push({name:'review:game',ok:true,created_at:stamp(86400)});
  const result=evaluate(health);assert.equal(result.ready,true);assert.equal(result.checks.find(check=>check.name==='reviews').count,0);
});
