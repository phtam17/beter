import test from 'node:test';
import assert from 'node:assert/strict';
const {runOperatorCli}=await import('../scripts/ops.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const secret='worker-secret-'.repeat(4);
const env={BETER_OPS_URL:'https://staging.example.com',JOB_SECRET:secret};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function fixture(options={}){
  const calls=[],output=[];
  return {calls,output,options:{env,writeOutput:text=>output.push(JSON.parse(text)),fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return response({ready:true,checks:[{name:'worker',ok:true,code:'WORKER_CURRENT'}]});},...options}};
}
async function run(args,options){assert.equal(typeof runOperatorCli,'function','A protected operator CLI must exist.');return runOperatorCli(args,options);}
test('monitor check sends the worker secret only as a header and returns safe readiness status',async()=>{
  const {calls,output,options}=fixture();assert.equal(await run(['check'],options),0);
  assert.equal(calls[0].url,'https://staging.example.com/api/ready');assert.equal(calls[0].init.headers.Authorization,'Bearer '+secret);
  assert.equal(calls[0].init.method,'GET');assert.equal(output[0].ready,true);assert.doesNotMatch(JSON.stringify(output),new RegExp(secret));
});
test('monitor check returns nonzero for an unready release with safe check results',async()=>{
  const {output,options}=fixture({fetchImpl:async()=>response({ready:false,checks:[{name:'worker',ok:false,code:'WORKER_STALE',ageSeconds:500}],private:'apiKey=private'},503)});
  assert.equal(await run(['check'],options),1);assert.equal(output[0].checks[0].code,'WORKER_STALE');assert.doesNotMatch(JSON.stringify(output),/apiKey|private/);
});
test('status summarizes durable health without printing private job details or event IDs',async()=>{
  const {output,options}=fixture({fetchImpl:async()=>response({schema_version:3,ledger_mismatches:0,open_bets:2,unsettled_bets:1,operator_holds:1,jobs:[{name:'pipeline',ok:true,created_at:'2026-11-20T12:00:00Z',detail:{token:'private-secret'}},{name:'review:private-event',ok:false,detail:{email:'person@example.com'}}]})});
  assert.equal(await run(['status'],options),0);assert.equal(output[0].overdueBets,1);assert.equal(output[0].pendingReviews,1);assert.doesNotMatch(JSON.stringify(output),/private-secret|private-event|person@example/);
});
const review={eventId:'game',operator:'On-call operator',reason:'Confirmed the final score using attributable evidence.',outcomes:[{bet_id:'c91df6cc-cd9b-493f-a721-eaf787a98301',status:'won'}],resultVersion:'review-2026-11-20-1',evidence:{source:'https://example.org/results/game',last_update:'2026-11-20T12:00:00Z'}};
test('resolve reads a reviewed JSON file and posts a protected audited result',async()=>{
  let readPath;const {calls,output,options}=fixture({readFile:async path=>{readPath=path;return JSON.stringify(review);},fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return response({applied:1,duplicate:false,automationHeld:true});}});
  assert.equal(await run(['resolve','--file','/tmp/review.json'],options),0);assert.equal(readPath,'/tmp/review.json');assert.equal(calls[0].url,'https://staging.example.com/api/ops/resolve');assert.deepEqual(JSON.parse(calls[0].init.body),review);assert.equal(output[0].automationHeld,true);assert.doesNotMatch(JSON.stringify(output),/On-call operator|attributable/);
});
test('resume requires an explicit audited input file',async()=>{
  const payload={eventId:'game',operator:'On-call operator',reason:'Provider correction verified; resume automatic processing.'};
  const {calls,options}=fixture({readFile:async()=>JSON.stringify(payload),fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return response({automationHeld:false});}});
  assert.equal(await run(['resume','--file','/tmp/resume.json'],options),0);assert.equal(calls[0].url,'https://staging.example.com/api/ops/resume');assert.deepEqual(JSON.parse(calls[0].init.body),payload);
});
test('maintenance uses a bounded explicit batch size',async()=>{
  const {calls,output,options}=fixture({fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return response({quotesDeleted:2,jobsDeleted:3});}});
  assert.equal(await run(['maintenance','--batch-size','20'],options),0);assert.deepEqual(JSON.parse(calls[0].init.body),{batchSize:20});assert.equal(output[0].jobsDeleted,3);
});
test('invalid arguments and unsafe configuration fail before any network request',async()=>{
  for(const [args,change] of [
    [['unknown'],{}],[['check','--secret','private'],{}],[['resolve'],{}],[['maintenance','--batch-size','1001'],{}],
    [['check'],{JOB_SECRET:''}],[['check'],{BETER_OPS_URL:'http://public.example.com'}],[['check'],{BETER_OPS_URL:'https://user:pass@example.com'}],[['check'],{BETER_OPS_URL:'https://example.com/?key=private'}],
  ]){
    const {calls,output,options}=fixture({env:{...env,...change}});assert.equal(await run(args,options),2);assert.equal(calls.length,0);assert.doesNotMatch(JSON.stringify(output),/private|pass@example/);
  }
});
test('loopback HTTP is available for local operational checks',async()=>{
  const {calls,options}=fixture({env:{...env,BETER_OPS_URL:'http://127.0.0.1:4173'}});assert.equal(await run(['check'],options),0);assert.equal(calls[0].url,'http://127.0.0.1:4173/api/ready');
});
test('invalid, oversized, or incomplete review files are refused before network access',async()=>{
  for(const text of ['{broken','[]','x'.repeat(1024*1024+1),JSON.stringify({...review,operator:''}),JSON.stringify({...review,password:'private'})]){
    const {calls,output,options}=fixture({readFile:async()=>text});assert.equal(await run(['resolve','--file','/tmp/review.json'],options),2);assert.equal(calls.length,0);assert.doesNotMatch(JSON.stringify(output),/broken|private/);
  }
});
test('network errors and unexpected response bodies never print raw exception or response content',async()=>{
  for(const fetchImpl of [async()=>{throw new Error('apiKey=private-secret');},async()=>new Response('private-secret',{status:500}),async()=>new Response('private-secret',{status:200}),async()=>response({ready:true,checks:[],secret:'private-secret'})]){
    const {output,options}=fixture({fetchImpl});assert.equal(await run(['check'],options),1);assert.doesNotMatch(JSON.stringify(output),/private-secret|apiKey/);
  }
});
test('deadlines include a stalled response body and return an actionable safe timeout code',async()=>{
  const {output,options}=fixture({timeoutMs:10,fetchImpl:async()=>({ok:true,status:200,json:()=>new Promise(()=>{})})});
  assert.equal(await run(['check'],options),1);assert.equal(output[0].code,'REQUEST_TIMEOUT');
});

test('the monitor reports unresolved reviews even when the worker is otherwise current',async()=>{
  const {output,options}=fixture({fetchImpl:async()=>response({ready:false,checks:[{name:'reviews',ok:false,code:'UNRESOLVED_REVIEWS',count:1}]},503)});
  assert.equal(await run(['check'],options),1);assert.equal(output[0].checks[0].code,'UNRESOLVED_REVIEWS');assert.equal(output[0].checks[0].count,1);
});
