import test from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient,adaptPortfolio} from '../dist/api-client.js';
import {getStats,resetState} from '../dist/engine.js';
const id='c91df6cc-cd9b-493f-a721-eaf787a98301';
const cursor='d91df6cc-cd9b-493f-a721-eaf787a98302';
const bet=(suffix='1')=>({id:'bet-'+suffix,stake_cents:10000,potential_payout_cents:25000,payout_cents:0,status:'open',created_at:'2026-11-20T12:00:00Z',settled_at:null,odds:2.5,selections:[{id:'pick-'+suffix,event_id:'event-'+suffix,event_name:'Away at Home',team:'Home',market:'Moneyline',line:null,odds:150,starts_at:'2026-11-21T12:00:00Z'}]});
const summary=()=>({total_bets:600,open_bets:2,settled_bets:598,wins:300,losses:280,voids:18,amount_at_risk_cents:20000,total_staked_cents:6000000,settled_staked_cents:5000000});
const portfolio=()=>({id,initial_bankroll_cents:1000000,balance_cents:1000000,bets:[bet()],ledger:[],summary:summary(),history_next_cursor:cursor,ledger_sampled:true,ledger_total_points:700});
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
async function client(fetchImpl){const api=createApiClient({storage:null,fetchImpl:async(url,init)=>url.endsWith('/auth/signin')?json({session:{user:{id:'user'},expires_at:2000000000}}):fetchImpl(url,init)});await api.signin('user@example.com','long-password');return api;}

test('account statistics use complete server totals rather than the recent bet page',()=>{
  const source=portfolio(),original=structuredClone(source),state=adaptPortfolio(source);const stats=getStats(state);
  assert.equal(stats.totalBets,600);assert.equal(stats.openBets,2);assert.equal(stats.settledBets,598);
  assert.equal(stats.bankroll,10200);assert.equal(stats.totalProfit,200);assert.equal(stats.amountAtRisk,200);assert.equal(stats.totalStaked,60000);
  assert.equal(stats.roi,0.4);assert.equal(stats.winRate,300/580*100);assert.equal(stats.wins,300);assert.equal(stats.losses,280);assert.equal(stats.voids,18);
  assert.deepEqual(source,original);stats.totalBets=0;assert.equal(getStats(state).totalBets,600);
});
test('adapted account metadata exposes the bounded history cursor and chart sampling honestly',()=>{
  const state=adaptPortfolio(portfolio());assert.equal(state.historyNextCursor,cursor);assert.equal(state.ledgerSampled,true);assert.equal(state.ledgerTotalPoints,700);
});
test('invalid or partial server summaries are rejected instead of silently showing page totals',()=>{
  for(const changed of [null,{}, {...summary(),wins:NaN},{...summary(),total_bets:'600'},{...summary(),open_bets:-1},{...summary(),total_bets:Number.MAX_SAFE_INTEGER+1},{...summary(),settled_bets:597},{...summary(),wins:299},{...summary(),settled_staked_cents:6000001}])assert.throws(()=>adaptPortfolio({...portfolio(),summary:changed}),/summary|integer|cents/i);
});
test('summary arithmetic rejects unsafe cent addition and preserves audited negative balances',()=>{
  assert.throws(()=>adaptPortfolio({...portfolio(),balance_cents:Number.MAX_SAFE_INTEGER}),/summary|safe|cents/i);
  const state=adaptPortfolio({...portfolio(),balance_cents:-2500});assert.equal(getStats(state).bankroll,175);assert.equal(getStats(state).totalProfit,-9825);
});
test('empty account summaries produce defined zero ratios',()=>{
  const raw=portfolio();raw.summary=Object.fromEntries(Object.keys(summary()).map(key=>[key,0]));raw.bets=[];raw.history_next_cursor=null;raw.ledger_sampled=false;raw.ledger_total_points=0;
  const stats=getStats(adaptPortfolio(raw));assert.equal(stats.totalBets,0);assert.equal(stats.winRate,0);assert.equal(stats.roi,0);
});
test('legacy account fixtures and demo statistics retain their existing calculation path',()=>{
  const raw=portfolio();delete raw.summary;delete raw.history_next_cursor;delete raw.ledger_sampled;delete raw.ledger_total_points;
  const state=adaptPortfolio(raw);assert.equal(state.accountSummary,undefined);assert.equal(getStats(state).totalBets,1);assert.equal(getStats(resetState()).totalBets,0);
});
test('invalid history or sampling metadata fails explicitly',()=>{
  for(const change of [{history_next_cursor:'not-a-cursor'},{ledger_sampled:'yes'},{ledger_sampled:null},{ledger_total_points:null},{ledger_total_points:-1},{ledger_total_points:0,ledger:[{id:'entry',type:'grant',amount_cents:0,balance_cents:0,bankroll_cents:0}]}])assert.throws(()=>adaptPortfolio({...portfolio(),...change}),/history|ledger|cursor|sampling/i);
});
test('history safely encodes cursor/filter queries and adapts newest-first rows without mutation',async()=>{
  let sent;const payload={bets:[bet('new'),bet('old')],nextCursor:cursor},original=structuredClone(payload);
  const api=await client(async(url,init)=>{sent={url,init};return json(payload);});assert.equal(typeof api.history,'function');
  const result=await api.history('account+one&next=bad',{before:cursor,limit:100,status:'won'});
  const url=new URL(sent.url,'https://example.com');assert.equal(url.pathname,'/api/history');assert.equal(url.searchParams.get('portfolioId'),'account+one&next=bad');assert.equal(url.searchParams.get('before'),cursor);assert.equal(url.searchParams.get('limit'),'100');assert.equal(url.searchParams.get('status'),'won');assert.equal(sent.init.method,'GET');assert.equal(sent.init.credentials,'same-origin');
  assert.deepEqual(result.bets.map(item=>item.id),['bet-new','bet-old']);assert.equal(result.bets[0].stake,100);assert.equal(result.bets[0].selections[0].eventName,'Away at Home');assert.equal(result.nextCursor,cursor);assert.deepEqual(payload,original);
});
test('history omits absent cursor/status and propagates lifecycle cancellation',async()=>{
  const controller=new AbortController();let sent;
  const api=await client(async(url,init)=>{sent={url,init};return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));});
  assert.equal(typeof api.history,'function');const result=api.history(id,{signal:controller.signal}).catch(error=>error);controller.abort();assert.equal((await result).code,'REQUEST_ABORTED');
  const url=new URL(sent.url,'https://example.com');assert.equal(url.searchParams.has('before'),false);assert.equal(url.searchParams.has('status'),false);assert.equal(url.searchParams.get('limit'),'100');
});
test('history rejects malformed pages and unsafe row currency',async()=>{
  for(const payload of [{bets:null,nextCursor:null},{bets:[],nextCursor:'bad'}, {bets:[{...bet(),stake_cents:1.5}],nextCursor:null}]){
    const api=await client(async()=>json(payload));assert.equal(typeof api.history,'function');await assert.rejects(api.history(id),/history|currency|cents|response/i);
  }
});
test('invalid history options fail before sending a request',async()=>{
  let calls=0;const api=await client(async()=>{calls++;return json({bets:[],nextCursor:null});});assert.equal(typeof api.history,'function');
  for(const options of [{limit:0},{limit:101},{limit:1.5},{status:'pending'},{before:42}])await assert.rejects(api.history(id,options));
  assert.equal(calls,0);
});
