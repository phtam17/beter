import test from 'node:test';
import assert from 'node:assert/strict';
const {createAwsHandler,preSignupHandler}=await import('../aws/handler.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const secret='origin-verification-fixture-1234567890';
function fixture(options={}){
  const requests=[],metrics=[];let jobs=0;
  const runtime={settings:{siteUrl:'https://beter.example',jobSecret:'worker-private',originSecret:secret},handle:async request=>{requests.push(request);return Response.json({ok:true});},runJobs:async()=>{jobs++;return{ingested:3,settled:1,errors:0,review:0};},...options.runtime};
  assert.equal(typeof createAwsHandler,'function','An AWS API/scheduler adapter must exist.');
  return{requests,metrics,runtime,get jobs(){return jobs;},handle:createAwsHandler({getRuntime:async()=>runtime,onMetric:metric=>metrics.push(metric),...options})};
}
function event(overrides={}){return{version:'2.0',rawPath:'/api/portfolio',rawQueryString:'a=b%3Dc',headers:{host:'untrusted.execute-api.example','x-forwarded-proto':'http','x-beter-origin-secret':secret,'x-beter-client':'browser',origin:'https://beter.example'},requestContext:{http:{method:'GET',sourceIp:'203.0.113.2'}},...overrides};}

test('AWS API adapter fixes the public origin, carries cookies, and preserves query encoding',async()=>{
  const {handle,requests}=fixture();const response=await handle(event({cookies:['a=1','b=2']}));assert.equal(response.statusCode,200);const request=requests[0];assert.equal(request.url,'https://beter.example/api/portfolio?a=b%3Dc');assert.equal(request.headers.get('cookie'),'a=1; b=2');assert.equal(request.headers.get('x-forwarded-proto'),null);assert.equal(request.headers.get('x-beter-origin-secret'),null);assert.equal(request.headers.get('x-beter-source-ip'),'203.0.113.2');
});
test('direct API calls and spoofed origin headers are rejected before app execution',async()=>{
  const {handle,requests}=fixture();for(const headers of [{},{'x-beter-origin-secret':'wrong'}]){const response=await handle(event({headers}));assert.equal(response.statusCode,403);assert.doesNotMatch(response.body,/origin-verification|worker-private/);}assert.equal(requests.length,0);
});
test('response cookies are separate API Gateway cookies and account responses never cache',async()=>{
  const {handle}=fixture({runtime:{settings:{siteUrl:'https://beter.example',originSecret:secret},handle:async()=>new Response('ok',{headers:[['Content-Type','text/plain'],['Set-Cookie','one=1; HttpOnly; Secure; Path=/'],['Set-Cookie','two=2; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Path=/'],['Cache-Control','public,max-age=100']]})}});const response=await handle(event());assert.equal(response.cookies.length,2);assert.equal(response.headers['set-cookie'],undefined);assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.body,'ok');
});
test('binary request bodies decode correctly and ordinary/privileged limits stay bounded',async()=>{
  const {handle,requests}=fixture();const body=JSON.stringify({email:'fixture@example.test'});assert.equal((await handle(event({rawPath:'/api/auth/signin',requestContext:{http:{method:'POST'}},body:Buffer.from(body).toString('base64'),isBase64Encoded:true}))).statusCode,200);assert.equal(await requests[0].text(),body);
  for(const [path,size,status] of [['/api/quotes',32769,413],['/api/ops/resolve',40000,200],['/api/ops/resolve',1048577,413]])assert.equal((await handle(event({rawPath:path,body:'x'.repeat(size),requestContext:{http:{method:'POST'}}}))).statusCode,status);
  assert.equal((await handle(event({body:'not base64!',isBase64Encoded:true}))).statusCode,400);
});
test('HTTP payloads cannot invoke scheduler processing',async()=>{
  const api=fixture();assert.equal((await api.handle({source:'beter.scheduler',task:'process'})).statusCode,403);assert.equal(api.jobs,0);
  const worker=fixture({workerTask:'process'});assert.equal((await worker.handle(event({body:JSON.stringify({source:'beter.scheduler',task:'process'}),requestContext:{http:{method:'POST'}}}))).statusCode,403);assert.equal(worker.jobs,0);
});
test('dedicated worker accepts only its exact schedule task and emits safe success metrics',async()=>{
  const worker=fixture({workerTask:'process'});assert.equal((await worker.handle({source:'beter.scheduler',task:'other'})).statusCode,403);const response=await worker.handle({source:'beter.scheduler',task:'process'});assert.equal(response.ok,true);assert.equal(worker.jobs,1);assert.equal(worker.metrics[0].name,'WorkerSuccess');assert.equal(worker.metrics[0].value,1);assert.doesNotMatch(JSON.stringify(worker.metrics),/worker-private|origin-verification/);
});
test('worker failures cannot leak upstream exceptions and emit failed metrics',async()=>{
  const worker=fixture({workerTask:'process',runtime:{settings:{siteUrl:'https://beter.example',originSecret:secret},runJobs:async()=>{throw new Error('apiKey=private-email@example.test');}}});await assert.rejects(()=>worker.handle({source:'beter.scheduler',task:'process'}),error=>!/apiKey|private-email/.test(error.message));assert.equal(worker.metrics[0].value,0);
});
test('monitor invokes protected readiness internally without exposing its credential or raw health',async()=>{
  const worker=fixture({workerTask:'monitor',runtime:{settings:{siteUrl:'https://beter.example',originSecret:secret,jobSecret:'worker-private'},handle:async request=>{assert.equal(request.headers.get('Authorization'),'Bearer worker-private');return Response.json({ready:false,private:'secret',checks:[]},{status:503});}}});const response=await worker.handle({source:'beter.scheduler',task:'monitor'});assert.deepEqual(response,{ok:false});assert.deepEqual(worker.metrics[0],{name:'ReadinessSuccess',value:0});
});
test('malformed paths and temporary runtime faults return safe responses',async()=>{
  const {handle}=fixture();assert.equal((await handle(event({rawPath:'https://attacker.example/api/portfolio'}))).statusCode,400);assert.equal((await handle(event({rawPath:'/api/../portfolio'}))).statusCode,400);assert.equal((await handle(event({rawPath:'/assets/index.html'}))).statusCode,404);
  const broken=fixture({getRuntime:async()=>{throw new Error('database-password=private');}});const response=await broken.handle(event());assert.equal(response.statusCode,503);assert.doesNotMatch(response.body,/password|private/);
});
test('Cognito staging signup is default denied and only normalized allowlisted addresses pass',async()=>{
  assert.equal(typeof preSignupHandler,'function','Direct Cognito signups need the same launch gate.');const request=email=>({triggerSource:'PreSignUp_SignUp',request:{userAttributes:{email}},response:{}});
  for(const env of [{},{BETER_LAUNCH_OPEN:'false',BETER_TEST_EMAILS:''}])await assert.rejects(()=>preSignupHandler(request('tester@example.test'),{env}),/not open/i);
  const event=request(' Tester@Example.Test ');assert.equal(await preSignupHandler(event,{env:{BETER_LAUNCH_OPEN:'false',BETER_TEST_EMAILS:'tester@example.test,other@example.test'}}),event);await assert.rejects(()=>preSignupHandler(request('outsider@example.test'),{env:{BETER_TEST_EMAILS:'tester@example.test'}}),/not open/i);
  assert.equal((await preSignupHandler(request('anyone@example.test'),{env:{BETER_LAUNCH_OPEN:'true'}})).request.userAttributes.email,'anyone@example.test');
});
test('verified proxy identity overwrites a spoofed source address',async()=>{
  const {handle,requests}=fixture();await handle(event({headers:{'x-beter-origin-secret':secret,'x-beter-viewer-ip':'198.51.100.7','x-beter-source-ip':'attacker','x-forwarded-for':'attacker'}}));assert.equal(requests[0].headers.get('x-beter-source-ip'),'198.51.100.7');assert.equal(requests[0].headers.get('x-beter-viewer-ip'),null);assert.equal(requests[0].headers.get('x-forwarded-for'),null);
});
test('funding cutoff stops API and scheduled work before secret or database loading',async()=>{
  let loads=0;for(const workerTask of [undefined,'process','monitor']){
    const invoke=fixture({workerTask,env:{BETER_FUNDING_CUTOFF_AT:'2000-01-01T00:00:00'},getRuntime:async()=>{loads++;throw new Error('should not load');}});
    const response=await invoke.handle(workerTask?{source:'beter.scheduler',task:workerTask}:event());assert.equal(response.statusCode,503);assert.equal(JSON.stringify(response).includes('FUNDING_REVIEW_REQUIRED'),true);
  }assert.equal(loads,0);
});
test('Cognito registration cannot outlive the funding cutoff even after launch',async()=>{
  const event={request:{userAttributes:{email:'tester@example.test'}}};for(const value of ['2000-01-01T00:00:00','invalid'])await assert.rejects(()=>preSignupHandler(event,{env:{BETER_LAUNCH_OPEN:'true',BETER_FUNDING_CUTOFF_AT:value}}),/not open/i);
});
test('heartbeat metrics bypass Lambda console JSON wrapping and remain root-level EMF',async t=>{
  const records=[];
  // Lambda JSON logging wraps console output under message; EMF must go straight to stdout.
  t.mock.method(console,'log',value=>records.push({message:value}));
  t.mock.method(process.stdout,'write',value=>{records.push(JSON.parse(String(value)));return true;});
  const handle=createAwsHandler({workerTask:'process',env:{BETER_ENVIRONMENT:'production'},getRuntime:async()=>({runJobs:async()=>({errors:0}),handle:async()=>Response.json({})})});
  assert.equal((await handle({source:'beter.scheduler',task:'process'})).ok,true);
  assert.equal(records.length,1);assert.equal(records[0]._aws?.CloudWatchMetrics[0].Namespace,'Beter');assert.deepEqual(records[0]._aws.CloudWatchMetrics[0].Dimensions,[['Environment']]);assert.equal(records[0].Environment,'production');assert.equal(records[0].WorkerSuccess,1);assert.equal(records[0].message,undefined);
});
