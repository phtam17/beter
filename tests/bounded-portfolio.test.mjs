import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase,setUser,rpc,ingest,createQuote,place,sampleEvent,userA,userB} from './helpers/database.mjs';

let db,portfolioId,allIds,firstPoint,lastPoint;
before(async()=>{
  db=await createTestDatabase();
  await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)',[userA,'projection@example.com',userB,'empty@example.com']);
  const groups=[['won',100],['lost',80],['void',50],['open',20]];
  allIds=[];let ordinal=0;
  for(const [status,count] of groups){
    const event=sampleEvent({id:'projection-'+status});event.selections[0].id='projection-pick-'+status;
    await ingest(db,[event]);const quote=await createQuote(db,event.selections[0].id);
    const outcomes=[];
    for(let i=0;i<count;i++){
      if(ordinal%30===0){await db.exec('reset role');await db.exec("update public.beter_bets set created_at=clock_timestamp()-interval '2 minutes'");await setUser(db);}
      const placed=await place(db,quote,1,'projection-'+String(ordinal).padStart(4,'0'));allIds.push(placed.bet.id);outcomes.push({bet_id:placed.bet.id,status});ordinal++;
    }
    if(status!=='open'){await setUser(db,null,'service_role');await rpc(db,'beter_settle',[event.id,JSON.stringify(outcomes),'projection-final-'+status,'{}'],'text,jsonb,text,jsonb');}
  }
  await db.exec('reset role');
  // Stable fixture chronology deliberately places every win outside the latest page.
  await db.exec("update public.beter_bets set created_at=clock_timestamp()-interval '1 day'+make_interval(secs=>substring(request_id from 12)::integer)");
  const rows=(await db.query("select id from public.beter_ledger where type<>'stake' order by created_at,id")).rows;
  firstPoint=rows[0].id;lastPoint=rows.at(-1).id;
  await setUser(db);portfolioId=(await rpc(db,'beter_portfolio')).id;
});
after(async()=>{await db?.close();});

test('canonical portfolio bounds recent bets without losing its exact all-history statistics',async()=>{
  await setUser(db);const portfolio=await rpc(db,'beter_portfolio');
  assert.equal(portfolio.bets.length,100);
  assert.deepEqual(portfolio.bets.map(b=>b.id),allIds.slice(-100));
  assert.deepEqual(portfolio.summary,{total_bets:250,open_bets:20,settled_bets:230,wins:100,losses:80,voids:50,amount_at_risk_cents:20,total_staked_cents:250,settled_staked_cents:180});
  assert.equal(portfolio.balance_cents,1000100);assert.equal(portfolio.history_next_cursor,allIds[150]);
});
test('chart projection is capped and spans first and latest non-stake ledger evidence',async()=>{
  await setUser(db);const portfolio=await rpc(db,'beter_portfolio');
  assert.equal(portfolio.ledger.length,200);assert.equal(portfolio.ledger_sampled,true);assert.equal(portfolio.ledger_total_points,231);
  assert.equal(portfolio.ledger[0].id,firstPoint);assert.equal(portfolio.ledger.at(-1).id,lastPoint);
  assert.ok(portfolio.ledger.every(entry=>entry.type!=='stake'));
  assert.equal(new Set(portfolio.ledger.map(entry=>entry.id)).size,200);
});
test('paging older bets starts immediately before the canonical recent page',async()=>{
  await setUser(db);const portfolio=await rpc(db,'beter_portfolio');
  const older=await rpc(db,'beter_history',[portfolioId,portfolio.history_next_cursor,100,null],'uuid,uuid,integer,text');
  assert.equal(older.bets.length,100);assert.deepEqual(older.bets.map(b=>b.id),allIds.slice(50,150).reverse());assert.equal(older.nextCursor,allIds[50]);
  const oldest=await rpc(db,'beter_history',[portfolioId,older.nextCursor,100,null],'uuid,uuid,integer,text');assert.equal(oldest.bets.length,50);assert.equal(oldest.nextCursor,null);
});
test('history filters match the whole portfolio including results outside the recent page',async()=>{
  await setUser(db);const page=await rpc(db,'beter_history',[portfolioId,null,25,'won'],'uuid,uuid,integer,text');
  assert.equal(page.bets.length,25);assert.ok(page.bets.every(bet=>bet.status==='won'));assert.deepEqual(page.bets.map(b=>b.id),allIds.slice(75,100).reverse());
  const next=await rpc(db,'beter_history',[portfolioId,page.nextCursor,100,'won'],'uuid,uuid,integer,text');assert.equal(next.bets.length,75);assert.equal(next.nextCursor,null);
  await assert.rejects(()=>rpc(db,'beter_history',[portfolioId,null,25,'not-a-status'],'uuid,uuid,integer,text'),/status|filter/);
});
test('bounded reads leave every accepted bet and financial ledger row intact',async()=>{
  await db.exec('reset role');const before=(await db.query('select (select count(*) from public.beter_bets) bets,(select count(*) from public.beter_ledger) ledger,(select sum(amount_cents) from public.beter_ledger) cents')).rows[0];
  await setUser(db);await rpc(db,'beter_portfolio');await rpc(db,'beter_history',[portfolioId,null,100,null],'uuid,uuid,integer,text');
  await db.exec('reset role');assert.deepEqual((await db.query('select (select count(*) from public.beter_bets) bets,(select count(*) from public.beter_ledger) ledger,(select sum(amount_cents) from public.beter_ledger) cents')).rows[0],before);
  assert.equal(Number(before.bets),250);assert.equal(Number(before.ledger),481);
});
test('an empty account receives a complete zero summary and an unsampled grant point',async()=>{
  await setUser(db,userB);const portfolio=await rpc(db,'beter_portfolio');assert.deepEqual(portfolio.bets,[]);assert.equal(portfolio.history_next_cursor,null);
  assert.equal(portfolio.summary.total_bets,0);assert.equal(portfolio.summary.amount_at_risk_cents,0);assert.equal(portfolio.summary.settled_staked_cents,0);
  assert.equal(portfolio.ledger.length,1);assert.equal(portfolio.ledger_sampled,false);assert.equal(portfolio.ledger_total_points,1);
  await setUser(db,null,'service_role');assert.equal((await rpc(db,'beter_health')).schema_version,4);
});
