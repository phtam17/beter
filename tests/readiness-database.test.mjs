import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTestDatabase,setUser,rpc,ingest,createQuote,place,sampleEvent,userA,userB} from './helpers/database.mjs';
import {createLocalBackend} from '../server/local.ts';

let db;
before(async()=>{db=await createTestDatabase();});
after(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('begin');await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)',[userA,'one@example.com',userB,'two@example.com']);});
afterEach(async()=>{await db.exec('rollback');});
async function rejects(action,pattern){await db.exec('savepoint expected_failure');try{await assert.rejects(action,pattern);}finally{await db.exec('rollback to savepoint expected_failure');await db.exec('release savepoint expected_failure');}}

test('portfolio creation is limited at the actual authenticated SQL boundary',async()=>{
  await setUser(db);for(let i=0;i<5;i++)await rpc(db,'beter_create_portfolio',['Practice '+i],'text');
  await rejects(()=>rpc(db,'beter_create_portfolio',['One too many'],'text'),/BETER_RATE_LIMITED/);
  assert.equal((await db.query('select count(*)::integer as n from public.beter_portfolios')).rows[0].n,5);
  await setUser(db,userB);assert.equal((await rpc(db,'beter_create_portfolio',['Independent user'],'text')).balance_cents,1000000);
});
test('quote bursts are bounded and cannot consume another account quota',async()=>{
  await ingest(db);for(let i=0;i<30;i++)await createQuote(db);
  await rejects(()=>rpc(db,'beter_quote',['["nba-home"]'],'jsonb'),/BETER_RATE_LIMITED/);
  assert.ok((await createQuote(db,'nba-home',userB)).id);
});
test('placement quotas preserve an accepted idempotent retry',async()=>{
  await ingest(db);const quote=await createQuote(db);let first;
  for(let i=0;i<30;i++){const result=await place(db,quote,1,'rate-request-'+i);if(i===0)first=result;}
  await rejects(()=>place(db,quote,1,'rate-request-31'),/BETER_RATE_LIMITED/);
  assert.equal((await place(db,quote,1,'rate-request-0')).bet.id,first.bet.id);
  assert.equal((await rpc(db,'beter_portfolio')).balance_cents,1000000-30);
});
test('daily portfolio limits still apply when older requests leave the hourly window',async()=>{
  await setUser(db);for(let batch=0;batch<4;batch++){
    for(let i=0;i<5;i++)await rpc(db,'beter_create_portfolio',['Daily '+batch+' '+i],'text');
    await db.exec('reset role');await db.exec("update public.beter_portfolios set created_at=clock_timestamp()-interval '2 hours'");await setUser(db);
  }
  await rejects(()=>rpc(db,'beter_create_portfolio',['Daily overflow'],'text'),/BETER_RATE_LIMITED/);
});
test('daily quote and placement limits survive earlier requests leaving the minute window',async()=>{
  await ingest(db);
  for(let i=0;i<500;i++){
    if(i%30===0){await db.exec('reset role');await db.exec("update public.beter_quotes set created_at=clock_timestamp()-interval '2 minutes'");}
    await createQuote(db);
  }
  await db.exec('reset role');await db.exec("update public.beter_quotes set created_at=clock_timestamp()-interval '2 minutes'");await setUser(db);
  await rejects(()=>rpc(db,'beter_quote',['["nba-home"]'],'jsonb'),/BETER_RATE_LIMITED/);
  const quote=(await db.query('select id from public.beter_quotes limit 1')).rows[0];
  for(let i=0;i<300;i++){
    if(i%30===0){await db.exec('reset role');await db.exec("update public.beter_bets set created_at=clock_timestamp()-interval '2 minutes'");await setUser(db);}
    await place(db,quote,1,'daily-bet-'+i);
  }
  await db.exec('reset role');await db.exec("update public.beter_bets set created_at=clock_timestamp()-interval '2 minutes'");await setUser(db);
  await rejects(()=>place(db,quote,1,'daily-bet-overflow'),/BETER_RATE_LIMITED/);
  assert.equal((await place(db,quote,1,'daily-bet-0')).portfolio.balance_cents,999700);
});
test('maintenance prunes only disposable expired records in bounded batches',async()=>{
  await ingest(db);const accepted=await createQuote(db);await place(db,accepted);
  const disposable=await createQuote(db);await db.exec('reset role');
  await db.exec("update public.beter_quotes set expires_at=clock_timestamp()-interval '2 days'");
  await db.exec("insert into public.beter_jobs(name,ok,created_at) values('pipeline',true,clock_timestamp()-interval '40 days'),('pipeline',true,clock_timestamp()),('old-operation',true,clock_timestamp()-interval '40 days')");
  await setUser(db,null,'service_role');const first=await rpc(db,'beter_maintenance',[1],'integer');
  assert.equal(first.quotesDeleted,1);assert.equal(first.jobsDeleted,1);
  await rpc(db,'beter_maintenance',[100],'integer');await db.exec('reset role');
  assert.deepEqual((await db.query('select id from public.beter_quotes')).rows.map(r=>r.id),[accepted.id]);
  assert.equal((await db.query('select count(*)::integer as n from public.beter_jobs')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::integer as n from public.beter_ledger')).rows[0].n,2);
  assert.notEqual(accepted.id,disposable.id);
});
test('protected maintenance and operator recovery reject ordinary accounts',async()=>{
  await setUser(db);
  for(const [name,args,signature] of [['beter_maintenance',[100],'integer'],['beter_resolve_event',['missing','[]','v1','{}','staff','Verified result'],'text,jsonb,text,jsonb,text,text'],['beter_resume_event',['missing','staff','Resume processing'],'text,text,text']])await rejects(()=>rpc(db,name,args,signature),/permission denied/);
});
test('operator recovery retains an immutable reason and pauses automatic processing until audited resume',async()=>{
  await ingest(db);const placed=await place(db,await createQuote(db));await setUser(db,null,'service_role');
  const evidence={source:'verified archive',last_update:new Date().toISOString()};
  const args=['nba-example',JSON.stringify([{bet_id:placed.bet.id,status:'void'}]),'manual-1',JSON.stringify(evidence),'on-call reviewer','Cancelled game confirmed with source evidence'];
  assert.equal((await rpc(db,'beter_resolve_event',args,'text,jsonb,text,jsonb,text,text')).applied,1);
  assert.equal((await rpc(db,'beter_resolve_event',args,'text,jsonb,text,jsonb,text,text')).duplicate,true);
  assert.deepEqual((await rpc(db,'beter_settlement_batch',[null,100],'text,integer')).events,[]);
  await db.exec('reset role');const records=(await db.query('select * from public.beter_operator_audit')).rows;
  assert.equal(records.length,1);assert.equal(records[0].operator_name,'on-call reviewer');assert.match(records[0].reason,/Cancelled game/);
  await rejects(()=>db.query("update public.beter_operator_audit set reason='changed'"),/append-only/);await setUser(db,null,'service_role');
  await rpc(db,'beter_resume_event',['nba-example','on-call reviewer','Resume after provider evidence verified'],'text,text,text');
  assert.equal((await rpc(db,'beter_settlement_batch',[null,100],'text,integer')).events.length,1);
  await setUser(db);assert.equal((await rpc(db,'beter_portfolio')).balance_cents,1000000);
});
test('operator recovery requires attributable evidence and rejects changed duplicate reasons',async()=>{
  await ingest(db);const placed=await place(db,await createQuote(db));await setUser(db,null,'service_role');
  const outcomes=JSON.stringify([{bet_id:placed.bet.id,status:'lost'}]);
  for(const [evidence,operator,reason] of [['{}','reviewer','A verified correction'],[JSON.stringify({source:'archive',last_update:new Date().toISOString()}),'','A verified correction'],[JSON.stringify({source:'archive',last_update:new Date().toISOString()}),'reviewer','']])await rejects(()=>rpc(db,'beter_resolve_event',['nba-example',outcomes,'manual-invalid',evidence,operator,reason],'text,jsonb,text,jsonb,text,text'),/evidence|operator|reason/);
  const evidence=JSON.stringify({source:'archive',last_update:new Date().toISOString()});
  await rpc(db,'beter_resolve_event',['nba-example',outcomes,'manual-v1',evidence,'reviewer','Verified score correction'],'text,jsonb,text,jsonb,text,text');
  await rejects(()=>rpc(db,'beter_resolve_event',['nba-example',outcomes,'manual-v1',evidence,'reviewer','A different retrospective explanation'],'text,jsonb,text,jsonb,text,text'),/different|conflict/);
});
test('a worker that fetched a candidate before manual resolution cannot undo the operator hold',async()=>{
  await ingest(db);const placed=await place(db,await createQuote(db));await setUser(db,null,'service_role');
  const stamp=new Date().toISOString(),outcomes=JSON.stringify([{bet_id:placed.bet.id,status:'void'}]);
  await rpc(db,'beter_resolve_event',['nba-example',outcomes,'held-v1',JSON.stringify({source:'verified archive',last_update:stamp}),'reviewer','Verified cancellation evidence'],'text,jsonb,text,jsonb,text,text');
  await rejects(()=>rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:placed.bet.id,status:'lost'}]),'late-worker',JSON.stringify({last_update:new Date(Date.now()+1000).toISOString()})],'text,jsonb,text,jsonb'),/held|operator/);
  await rejects(()=>rpc(db,'beter_apply_result',['nba-example',JSON.stringify([{bet_id:placed.bet.id,status:'lost'}]),'private-bypass','{}'],'text,jsonb,text,jsonb'),/permission denied/);
});
test('operator recovery requires all accepted bets and clears the unresolved review heartbeat',async()=>{
  await ingest(db);const quote=await createQuote(db),first=await place(db,quote,1,'manual-first'),second=await place(db,quote,1,'manual-second');await setUser(db,null,'service_role');
  await rpc(db,'beter_job_record',['review:nba-example',false,'{"reason":"Missing final result"}'],'text,boolean,jsonb');
  const evidence=JSON.stringify({source:'verified archive',last_update:new Date().toISOString()});
  await rejects(()=>rpc(db,'beter_resolve_event',['nba-example',JSON.stringify([{bet_id:first.bet.id,status:'void'}]),'incomplete',evidence,'reviewer','Verified cancellation evidence'],'text,jsonb,text,jsonb,text,text'),/all|complete|bet/);
  await rpc(db,'beter_resolve_event',['nba-example',JSON.stringify([{bet_id:first.bet.id,status:'void'},{bet_id:second.bet.id,status:'void'}]),'complete',evidence,'reviewer','Verified cancellation evidence'],'text,jsonb,text,jsonb,text,text');
  const health=await rpc(db,'beter_health');assert.equal(health.jobs.find(j=>j.name==='review:nba-example').ok,true);
});
test('settlement event pages are bounded, stable, and retain every accepted bet for an included event',async()=>{
  for(let i=0;i<3;i++){const event=sampleEvent({id:'batch-'+i});event.selections[0].id='pick-'+i;await ingest(db,[event]);await place(db,await createQuote(db,'pick-'+i),1,'batch-request-'+i);}
  await setUser(db,null,'service_role');const first=await rpc(db,'beter_settlement_batch',[null,2],'text,integer');
  assert.deepEqual(first.events.map(e=>e.id),['batch-0','batch-1']);assert.equal(first.nextCursor,'batch-1');
  const second=await rpc(db,'beter_settlement_batch',[first.nextCursor,2],'text,integer');assert.deepEqual(second.events.map(e=>e.id),['batch-2']);assert.equal(second.nextCursor,null);
  await rejects(()=>rpc(db,'beter_settlement_batch',[null,1001],'text,integer'),/limit|batch/);
});
test('a correction-window page retains older unchanged bets so result replay stays idempotent',async()=>{
  await ingest(db);const quote=await createQuote(db),one=await place(db,quote,1,'old-unchanged'),two=await place(db,quote,1,'recent-corrected');
  await setUser(db,null,'service_role');
  // Match the worker's canonical order, including equal creation timestamps.
  const original=await rpc(db,'beter_settlement_batch',[null,100],'text,integer');
  const outcomes=JSON.stringify(original.events[0].bets.map(b=>({bet_id:b.id,status:b.id===one.bet.id?'won':'lost'})));
  await rpc(db,'beter_settle',['nba-example',outcomes,'stable-result','{}'],'text,jsonb,text,jsonb');
  await db.exec('reset role');await db.query("update public.beter_bets set settled_at=clock_timestamp()-interval '4 days' where id=$1",[one.bet.id]);await setUser(db,null,'service_role');
  const batch=await rpc(db,'beter_settlement_batch',[null,100],'text,integer');assert.equal(batch.events[0].bets.length,2);
  const replay=batch.events[0].bets.map(b=>({bet_id:b.id,status:b.status}));
  assert.equal((await rpc(db,'beter_settle',['nba-example',JSON.stringify(replay),'stable-result','{}'],'text,jsonb,text,jsonb')).duplicate,true);
});
test('long event identifiers resolve their matching hashed review heartbeat',async()=>{
  const id='review-'.repeat(14),event=sampleEvent({id});await ingest(db,[event]);const placed=await place(db,await createQuote(db));await setUser(db,null,'service_role');
  const {createHash}=await import('node:crypto');const name='review:'+createHash('sha256').update(id).digest('hex');
  await rpc(db,'beter_job_record',[name,false,'{"reason":"Missing result"}'],'text,boolean,jsonb');
  await rpc(db,'beter_resolve_event',[id,JSON.stringify([{bet_id:placed.bet.id,status:'void'}]),'long-id',JSON.stringify({source:'verified archive',last_update:new Date().toISOString()}),'reviewer','Verified cancellation evidence'],'text,jsonb,text,jsonb,text,text');
  assert.equal((await rpc(db,'beter_health')).jobs.find(j=>j.name===name).ok,true);
});
test('owner-scoped history pages preserve records without leaking other accounts',async()=>{
  await ingest(db);const quote=await createQuote(db);for(let i=0;i<3;i++)await place(db,quote,1,'history-'+i);
  const portfolio=await rpc(db,'beter_portfolio');const first=await rpc(db,'beter_history',[portfolio.id,null,2],'uuid,uuid,integer');
  assert.equal(first.bets.length,2);assert.ok(first.nextCursor);
  const second=await rpc(db,'beter_history',[portfolio.id,first.nextCursor,2],'uuid,uuid,integer');assert.equal(second.bets.length,1);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.bets,...second.bets].map(b=>b.id)).size,3);
  await setUser(db,userB);await rejects(()=>rpc(db,'beter_history',[portfolio.id,null,2],'uuid,uuid,integer'),/not found|unavailable/);
});
test('health identifies the applied readiness schema',async()=>{
  await setUser(db,null,'service_role');assert.ok((await rpc(db,'beter_health')).schema_version>=2);
});
test('persistent local upgrades apply forward migrations without changing existing balances',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'beter-upgrade-'));
  let backend;
  try{
    backend=await createLocalBackend({dataDir:directory,migrationPath:new URL('../supabase/migrations/202611200001_beter.sql',import.meta.url).pathname});
    const account=await backend.auth('signup',{email:'upgrade@example.com',password:'upgrade-password-2026'});
    const original=await backend.rpc('beter_portfolio',{},account.session.access_token);await backend.close();
    backend=await createLocalBackend({dataDir:directory});
    assert.equal((await backend.rpc('beter_portfolio',{},account.session.access_token)).id,original.id);
    assert.ok((await backend.rpc('beter_health',{},'$service')).schema_version>=2);
  }finally{await backend?.close();await rm(directory,{recursive:true,force:true});}
});
