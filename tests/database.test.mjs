import test,{before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase,setUser,rpc,ingest,createQuote,place,sampleEvent,userA,userB } from './helpers/database.mjs';

let db;
before(async()=>{db=await createTestDatabase();});
after(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('begin');await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)',[userA,'one@example.com',userB,'two@example.com']);});
afterEach(async()=>{await db.exec('rollback');});

// Errors roll back only the statement; each test uses savepoints to remain independent.
async function rejects(action,pattern) {
  await db.exec('savepoint expected_failure');
  try {await assert.rejects(action,pattern);} finally {await db.exec('rollback to savepoint expected_failure');await db.exec('release savepoint expected_failure');}
}

test('account initialization issues one durable virtual grant',async()=>{
  await setUser(db);const first=await rpc(db,'beter_portfolio');const second=await rpc(db,'beter_portfolio');
  assert.equal(first.id,second.id);assert.equal(first.balance_cents,1000000);assert.equal(first.initial_bankroll_cents,1000000);assert.equal(first.ledger.length,1);assert.deepEqual(first.bets,[]);
});
test('account portfolios and ledger reads are isolated',async()=>{
  await setUser(db);const one=await rpc(db,'beter_portfolio');await setUser(db,userB);const two=await rpc(db,'beter_portfolio');
  assert.notEqual(one.id,two.id);assert.equal((await db.query('select * from public.beter_portfolios')).rows.length,1);assert.equal((await db.query('select * from public.beter_ledger')).rows.length,1);
});
test('missing authenticated identity cannot create a portfolio',async()=>{
  await setUser(db,null);await rejects(()=>rpc(db,'beter_portfolio'),/auth|sign in/i);
});
test('starting fresh preserves the old portfolio and its audit trail',async()=>{
  await setUser(db);const one=await rpc(db,'beter_portfolio');const two=await rpc(db,'beter_create_portfolio',['New season'],'text');
  assert.notEqual(one.id,two.id);assert.equal(two.balance_cents,1000000);assert.equal(two.name,'New season');assert.equal((await db.query('select * from public.beter_portfolios')).rows.length,2);
});
test('normalised markets are readable and retain their provider identity',async()=>{
  assert.equal((await ingest(db)).events,1);await setUser(db,null,'anon');const events=await rpc(db,'beter_markets');
  assert.equal(events[0].id,'nba-example');assert.equal(events[0].selections[0].odds,150);assert.equal(events[0].selections[0].event_name,'Boston Celtics at New York Knicks');
});
test('provider live and final aliases normalize to closed canonical statuses',async()=>{
  await ingest(db,[sampleEvent({status:'live'})]);await db.exec('reset role');assert.equal((await db.query('select status from public.beter_events')).rows[0].status,'inplay');await ingest(db,[sampleEvent({status:'final'})]);await db.exec('reset role');assert.equal((await db.query('select status from public.beter_events')).rows[0].status,'completed');
});
test('only a service identity can ingest markets or grade results',async()=>{
  await setUser(db);await rejects(()=>rpc(db,'beter_ingest_events',['[]'],'jsonb'),/permission denied/i);await rejects(()=>rpc(db,'beter_settle',['nba-example','[]','v1','{}'],'text,jsonb,text,jsonb'),/permission denied/i);
});
test('quote creation snapshots exactly one available pregame selection',async()=>{
  await ingest(db);const quote=await createQuote(db);assert.equal(quote.selections[0].odds,150);assert.equal(quote.total_decimal_odds,2.5);assert.ok(Date.parse(quote.expires_at)>Date.now());
  await rejects(()=>rpc(db,'beter_quote',['[]'],'jsonb'),/one|single|selection/i);await rejects(()=>rpc(db,'beter_quote',['["missing"]'],'jsonb'),/unavailable|not found/i);
});
test('stale feeds and imminent game starts refuse quote creation',async()=>{
  const stale=new Date(Date.now()-300000).toISOString();await ingest(db,[sampleEvent({fetched_at:stale,selections:[{...sampleEvent().selections[0],fetched_at:stale}]})]);
  await setUser(db);await rejects(()=>rpc(db,'beter_quote',['["nba-home"]'],'jsonb'),/stale|expired|unavailable/i);
  await ingest(db,[sampleEvent({starts_at:new Date(Date.now()+30000).toISOString()})]);await setUser(db);await rejects(()=>rpc(db,'beter_quote',['["nba-home"]'],'jsonb'),/start|closed|unavailable/i);
});
test('connected beta rejects spreads and totals at the quote boundary',async()=>{
  for(const [market,line,side] of [['Spread',3.5,'home'],['Total',220.5,'over']]) {
    const event=sampleEvent();event.selections[0]={...event.selections[0],market,line,side};await ingest(db,[event]);await setUser(db);await rejects(()=>rpc(db,'beter_quote',['["nba-home"]'],'jsonb'),/moneyline|supported/i);
  }
});
test('future event timestamps fail closed even with a current selection',async()=>{
  await ingest(db,[sampleEvent({fetched_at:new Date(Date.now()+120000).toISOString()})]);await setUser(db);await rejects(()=>rpc(db,'beter_quote',['["nba-home"]'],'jsonb'),/timestamp|invalid/i);
});
test('placement atomically records the stake and immutable accepted price',async()=>{
  await ingest(db);const quote=await createQuote(db);const placed=await place(db,quote);
  assert.equal(placed.bet.stake_cents,10000);assert.equal(placed.bet.potential_payout_cents,25000);assert.equal(placed.bet.status,'open');assert.equal(placed.portfolio.balance_cents,990000);assert.equal(placed.portfolio.ledger.at(-1).bankroll_cents,1000000);
});
test('repeated request IDs have one effect and reject changed payloads',async()=>{
  await ingest(db);const quote=await createQuote(db);const one=await place(db,quote);const two=await place(db,quote);
  assert.equal(one.bet.id,two.bet.id);assert.equal(two.portfolio.bets.length,1);assert.equal(two.portfolio.balance_cents,990000);await rejects(()=>place(db,quote,20000),/request|idempot|payload/i);
});
test('stakes cannot exceed funds and exact full-balance stake succeeds',async()=>{
  await ingest(db);const quote=await createQuote(db);await rejects(()=>place(db,quote,1000001),/balance|funds/i);await rejects(()=>place(db,quote,0),/stake|positive/i);
  const bet=await place(db,quote,1000000);assert.equal(bet.portfolio.balance_cents,0);const second=await createQuote(db);await rejects(()=>place(db,second,1,'next'),/balance|funds/i);
});
test('users cannot spend another account quote',async()=>{
  await ingest(db);const quote=await createQuote(db);await setUser(db,userB);await rejects(()=>place(db,quote),/quote|not found|unavailable/i);
});
test('expired and changed quotes are rejected without debiting funds',async()=>{
  await ingest(db);const quote=await createQuote(db);await db.exec('reset role');await db.query("update public.beter_quotes set expires_at=clock_timestamp()-interval '1 second' where id=$1",[quote.id]);await setUser(db);
  await rejects(()=>place(db,quote),/expired/i);const newer=await createQuote(db);const event=sampleEvent();event.selections[0].odds=160;await ingest(db,[event]);await setUser(db);await rejects(()=>place(db,newer),/changed|price/i);assert.equal((await rpc(db,'beter_portfolio')).balance_cents,1000000);
});
test('financial tables reject direct authenticated writes',async()=>{
  await setUser(db);const portfolio=await rpc(db,'beter_portfolio');await rejects(()=>db.query('update public.beter_portfolios set balance_cents=2000000 where id=$1',[portfolio.id]),/permission denied/i);await rejects(()=>db.query('delete from public.beter_ledger'),/permission denied/i);
});
test('removed selections are retired and cannot be accepted from an older quote',async()=>{
  await ingest(db);const quote=await createQuote(db);await ingest(db,[sampleEvent({selections:[]})]);await setUser(db);await rejects(()=>place(db,quote),/unavailable|closed|changed/i);assert.equal((await rpc(db,'beter_markets'))[0].selections.length,0);
});
test('half-cent payouts round up exactly and settle once',async()=>{
  const event=sampleEvent();event.selections[0].odds=101;await ingest(db,[event]);const quote=await createQuote(db);const bet=await place(db,quote,5050);assert.equal(bet.bet.potential_payout_cents,10151);
  await setUser(db,null,'service_role');const args=['nba-example','[{"selection_id":"nba-home","status":"won"}]','v1','{"source":"test"}'];await rpc(db,'beter_settle',args,'text,jsonb,text,jsonb');await rpc(db,'beter_settle',args,'text,jsonb,text,jsonb');await setUser(db);const state=await rpc(db,'beter_portfolio');assert.equal(state.balance_cents,1005101);assert.equal(state.bets[0].status,'won');assert.equal((await db.query('select count(*)::integer as n from public.beter_ledger')).rows[0].n,3);
});
test('negative repeating American odds round a three-cent half-cent return up',async()=>{
  const event=sampleEvent();event.selections[0].odds=-120;await ingest(db,[event]);const {bet}=await place(db,await createQuote(db),3,'negative-three-cents');assert.equal(bet.potential_payout_cents,6);
});
test('negative repeating American odds retain half-cent accuracy for larger stakes',async()=>{
  const event=sampleEvent();event.selections[0].odds=-120;await ingest(db,[event]);const {bet}=await place(db,await createQuote(db),5055,'negative-half-cent');assert.equal(bet.potential_payout_cents,9268);
});
test('void returns original stake and corrections append an adjustment',async()=>{
  await ingest(db);const quote=await createQuote(db);await place(db,quote);await setUser(db,null,'service_role');await rpc(db,'beter_settle',['nba-example','[{"selection_id":"nba-home","status":"void"}]','v1','{}'],'text,jsonb,text,jsonb');await setUser(db);assert.equal((await rpc(db,'beter_portfolio')).balance_cents,1000000);
  await setUser(db,null,'service_role');await rpc(db,'beter_settle',['nba-example','[{"selection_id":"nba-home","status":"won"}]','v2','{}'],'text,jsonb,text,jsonb');await setUser(db);const state=await rpc(db,'beter_portfolio');assert.equal(state.balance_cents,1015000);assert.equal(state.ledger.at(-1).type,'adjustment');assert.equal(state.ledger.at(-1).amount_cents,15000);
});
test('service health reports reconciled balances and durable job heartbeats',async()=>{
  await setUser(db);await rpc(db,'beter_portfolio');await setUser(db,null,'service_role');await rpc(db,'beter_job_record',['odds',true,'{"events":1}'],'text,boolean,jsonb');const health=await rpc(db,'beter_health');assert.equal(health.ledger_mismatches,0);assert.equal(health.jobs[0].name,'odds');
});
test('settlement uses each bet identity and candidates retain accepted prices and old portfolios',async()=>{
  const one=sampleEvent();one.selections[0].odds=130;await ingest(db,[one]);const first=await place(db,await createQuote(db));
  const two=sampleEvent();two.selections[0].odds=150;await ingest(db,[two]);const second=await place(db,await createQuote(db),10000,'second');await rpc(db,'beter_create_portfolio',['New portfolio'],'text');await setUser(db,null,'service_role');
  const candidates=await rpc(db,'beter_settlement_candidates');assert.equal(candidates[0].bets.length,2);assert.equal(candidates[0].bets[0].selections[0].odds,130);assert.equal(candidates[0].bets[1].selections[0].odds,150);
  await rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:first.bet.id,status:'lost'},{bet_id:second.bet.id,status:'won'}]),'different-lines','{}'],'text,jsonb,text,jsonb');await db.exec('reset role');const rows=(await db.query('select id,status from public.beter_bets order by created_at,id')).rows;assert.equal(rows.find(row=>row.id===first.bet.id).status,'lost');assert.equal(rows.find(row=>row.id===second.bet.id).status,'won');
});
test('replaying an earlier recorded result never reverses a later correction',async()=>{
  await ingest(db);const {bet}=await place(db,await createQuote(db));await setUser(db,null,'service_role');const one=['nba-example',JSON.stringify([{bet_id:bet.id,status:'won'}]),'v1','{}'];await rpc(db,'beter_settle',one,'text,jsonb,text,jsonb');await rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:bet.id,status:'lost'}]),'v2','{}'],'text,jsonb,text,jsonb');await rpc(db,'beter_settle',one,'text,jsonb,text,jsonb');await setUser(db);const state=await rpc(db,'beter_portfolio');assert.equal(state.bets[0].status,'lost');assert.equal(state.balance_cents,990000);
});
test('conflicting duplicate outcomes and unknown bet identities fail atomically',async()=>{
  await ingest(db);const {bet}=await place(db,await createQuote(db));await setUser(db,null,'service_role');await rejects(()=>rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:bet.id,status:'won'},{bet_id:bet.id,status:'lost'}]),'v1','{}'],'text,jsonb,text,jsonb'),/duplicate|multiple|conflict/i);await rejects(()=>rpc(db,'beter_settle',['nba-example','[{"bet_id":"99999999-9999-4999-8999-999999999999","status":"won"}]','v2','{}'],'text,jsonb,text,jsonb'),/outcome|bet.*not found|unknown/i);
});
test('identical result-version keys reject different grading evidence',async()=>{
  await ingest(db);const {bet}=await place(db,await createQuote(db));await setUser(db,null,'service_role');await rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:bet.id,status:'won'}]),'v1','{}'],'text,jsonb,text,jsonb');await rejects(()=>rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:bet.id,status:'lost'}]),'v1','{}'],'text,jsonb,text,jsonb'),/version.*different/i);
});
test('financial audit entries cannot be rewritten even through a service table grant',async()=>{
  await setUser(db);await rpc(db,'beter_portfolio');await setUser(db,null,'service_role');await rejects(()=>db.query('update public.beter_ledger set amount_cents=0'),/append-only/i);
});
test('an older provider poll cannot roll back a newer price',async()=>{
  await ingest(db);const stale=sampleEvent({fetched_at:new Date(Date.now()-30000).toISOString()});stale.selections[0].odds=180;await ingest(db,[stale]);await setUser(db);const quote=await rpc(db,'beter_quote',['["nba-home"]'],'jsonb');assert.equal(quote.selections[0].odds,150);
});
test('a later retrieval cannot replace a price with older provider evidence',async()=>{
  await ingest(db);const older=sampleEvent({fetched_at:new Date(Date.now()+1000).toISOString()});older.selections[0].odds=180;older.selections[0].provider_updated_at=new Date(Date.now()-30000).toISOString();older.selections[0].fetched_at=older.fetched_at;await ingest(db,[older]);await setUser(db);const quote=await rpc(db,'beter_quote',['["nba-home"]'],'jsonb');assert.equal(quote.selections[0].odds,150);
});
test('an unseen older result version cannot reverse a newer correction',async()=>{
  await ingest(db);const {bet}=await place(db,await createQuote(db));await setUser(db,null,'service_role');
  await rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:bet.id,status:'lost'}]),'newer-correction',JSON.stringify({updated_at:new Date(Date.now()-60000).toISOString()})],'text,jsonb,text,jsonb');
  const ignored=await rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:bet.id,status:'won'}]),'unseen-old-final',JSON.stringify({last_update:new Date(Date.now()-120000).toISOString()})],'text,jsonb,text,jsonb');assert.equal(ignored.applied,0);assert.equal(ignored.stale,true);await setUser(db);const portfolio=await rpc(db,'beter_portfolio');assert.equal(portfolio.balance_cents,990000);assert.equal(portfolio.bets[0].status,'lost');
});
test('conflicting results with an equal provider timestamp require review',async()=>{
  await ingest(db);const {bet}=await place(db,await createQuote(db));await setUser(db,null,'service_role');const evidence=JSON.stringify({last_update:new Date(Date.now()-60000).toISOString()});await rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:bet.id,status:'lost'}]),'first-version',evidence],'text,jsonb,text,jsonb');await rejects(()=>rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:bet.id,status:'won'}]),'unorderable-correction',evidence],'text,jsonb,text,jsonb'),/conflicting|timestamp|review/i);
});
test('reversing spent winnings records debt and blocks additional stakes',async()=>{
  await ingest(db);const first=await place(db,await createQuote(db),1000000,'first-full-stake');await setUser(db,null,'service_role');await rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:first.bet.id,status:'won'}]),'first-win','{}'],'text,jsonb,text,jsonb');
  const next=sampleEvent({id:'next-game'});next.selections[0].id='next-home';await ingest(db,[next]);await place(db,await createQuote(db,'next-home'),2000000,'spent-winnings');await setUser(db,null,'service_role');await rpc(db,'beter_settle',['nba-example',JSON.stringify([{bet_id:first.bet.id,status:'lost'}]),'corrected-loss','{}'],'text,jsonb,text,jsonb');await setUser(db);
  const state=await rpc(db,'beter_portfolio');assert.equal(state.balance_cents,-2000000);assert.equal(state.ledger.at(-1).amount_cents,-2500000);const quote=await createQuote(db,'next-home');await rejects(()=>place(db,quote,1,'after-debt'),/balance|funds/i);await setUser(db,null,'service_role');assert.equal((await rpc(db,'beter_health')).ledger_mismatches,0);
});
