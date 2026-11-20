import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalBackend} from '../server/local.ts';
import {createSampleProvider} from '../server/provider.ts';
import {createRuntime} from '../server/runtime.ts';
test('account, quote, accepted bet, automatic final and replay reconcile through the real API',async t=>{
  let clock=new Date();const backend=await createLocalBackend();t.after(()=>backend.close());
  const sample=createSampleProvider({now:()=>clock});
  // Advance the synthetic schedule while keeping provider evidence on the actual
  // database clock; production correctly refuses future-dated final evidence.
  const provider={
    async getEvents(sport){const events=await sample.getEvents(sport);if(clock.getTime()<=Date.now()+3600000)return events;const now=new Date().toISOString();return events.map(e=>({...e,starts_at:new Date(Date.now()-3600000).toISOString(),fetched_at:now,provider_updated_at:now,selections:e.selections.map(s=>({...s,fetched_at:now,provider_updated_at:now}))}));},
    async getResults(sport){const results=await sample.getResults(sport);return results.map(r=>r.completed?{...r,updated_at:new Date().toISOString(),evidence:{...r.evidence,last_update:new Date().toISOString()}}:r);},
  };
  const runtime=await createRuntime({env:{JOB_SECRET:'test-worker-secret'},backend,provider});
  const call=async(path,body,token)=>{const response=await runtime.handle(new Request('http://localhost/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})}));return{status:response.status,data:await response.json()};};
  await runtime.runJobs();
  const signup=await call('/auth/signup',{email:'full-flow@example.com',password:'a-secure-test-password'});assert.equal(signup.status,201);
  const token=signup.data.session.access_token;
  const portfolio=await call('/portfolio',undefined,token);assert.equal(portfolio.data.balance_cents,1000000);
  const markets=await call('/markets');const pick=markets.data.events[0].selections.find(s=>s.market==='Moneyline'&&s.side==='home');
  const quote=await call('/quotes',{selectionIds:[pick.id]},token);assert.equal(quote.status,201);
  const request={quoteId:quote.data.id,stakeCents:10000,requestId:'full-flow-placement'};
  const placed=await call('/bets',request,token);assert.equal(placed.status,201);assert.equal(placed.data.portfolio.balance_cents,990000);
  const duplicate=await call('/bets',request,token);assert.equal(duplicate.data.bet.id,placed.data.bet.id);
  clock=new Date(clock.getTime()+4*3600000);
  const first=await runtime.runJobs();assert.equal(first.settled,1);assert.equal(first.errors,0);
  const final=await call('/portfolio',undefined,token);assert.equal(final.data.balance_cents,1015000);assert.equal(final.data.bets[0].status,'won');
  const replay=await runtime.runJobs();assert.equal(replay.settled,0,'An already applied result must not be reported as a new settlement.');
  const health=await call('/health/details',undefined,'test-worker-secret');assert.equal(health.data.ledger_mismatches,0);
  assert.equal((await call('/settle',{status:'won'},token)).status,404);
});
