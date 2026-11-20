import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalBackend} from '../server/local.ts';
import {createRuntime} from '../server/runtime.ts';
import {runOperatorCli} from '../scripts/ops.mjs';

test('operator CLI resolves, reconciles, holds and resumes a real migrated account through the API',async t=>{
  const secret='isolated-operator-flow-secret-1234567890';
  const backend=await createLocalBackend();
  const runtime=await createRuntime({env:{BETER_SESSION_SECRET:secret,JOB_SECRET:secret},backend});
  t.after(()=>runtime.close());
  await runtime.runJobs();
  const call=async(path,body,token)=>{
    const response=await runtime.handle(new Request('http://localhost/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})}));
    assert.ok(response.ok,`API ${path}: ${response.status}`);return response.json();
  };
  const signup=await call('/auth/signup',{email:'operator-flow@example.test',password:'a-private-fixture-password'});
  const token=signup.session.access_token;
  const {events}=await call('/markets');const event=events[0],selection=event.selections.find(pick=>pick.market==='Moneyline');
  const quote=await call('/quotes',{selectionIds:[selection.id]},token);
  const placed=await call('/bets',{quoteId:quote.id,stakeCents:10000,requestId:'operator-flow-request'},token);
  assert.equal(placed.portfolio.balance_cents,990000);
  const output=[];let file;
  const options={env:{BETER_OPS_URL:'http://localhost',JOB_SECRET:secret},fetchImpl:(url,init)=>runtime.handle(new Request(url,init)),readFile:async()=>JSON.stringify(file),writeOutput:text=>output.push(JSON.parse(text))};
  assert.equal(await runOperatorCli(['check'],options),0);
  file={eventId:event.id,operator:'Fixture reviewer',reason:'Cancellation confirmed against retained fixture evidence.',resultVersion:'fixture-cancellation-v1',evidence:{source:'Controlled local cancellation evidence',last_update:new Date().toISOString()},outcomes:[{bet_id:placed.bet.id,status:'void'}]};
  assert.equal(await runOperatorCli(['resolve','--file','/private/fixture.json'],options),0);
  assert.equal(output.at(-1).automationHeld,true);
  assert.equal(await runOperatorCli(['resolve','--file','/private/fixture.json'],options),0);
  assert.equal(output.at(-1).duplicate,true);
  const portfolio=await call('/portfolio',undefined,token);assert.equal(portfolio.balance_cents,1000000);assert.equal(portfolio.summary.voids,1);
  assert.equal(await runOperatorCli(['status'],options),0);assert.equal(output.at(-1).schemaVersion,4);assert.equal(output.at(-1).ledgerMismatches,0);assert.equal(output.at(-1).operatorHolds,1);
  await assert.rejects(()=>backend.rpc('beter_settle',{p_event_id:event.id,p_outcomes:[{bet_id:placed.bet.id,status:'won'}],p_result_version:'late-worker',p_evidence:{last_update:new Date().toISOString()}},'$service'),/held/i);
  file={eventId:event.id,operator:'Fixture reviewer',reason:'Reviewed the provider recovery before releasing automation.'};
  assert.equal(await runOperatorCli(['resume','--file','/private/fixture.json'],options),0);assert.equal(output.at(-1).automationHeld,false);
  assert.equal(await runOperatorCli(['maintenance','--batch-size','10'],options),0);
  assert.equal(await runOperatorCli(['check'],options),0);
  assert.doesNotMatch(JSON.stringify(output),/Fixture reviewer|fixture-password|Controlled local|operator-flow@example/);
});
