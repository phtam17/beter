import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('../aws/provider-check.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const now=new Date('2026-11-20T02:00:00Z'),secretArn='arn:aws:secretsmanager:us-west-2:111111111111:secret:beter-provider-probe-fixture',apiKey='private-provider-fixture-key';
const env=()=>({BETER_PROVIDER_SECRET_ARN:secretArn,BETER_FUNDING_CUTOFF_AT:'2099-01-01T00:00:00'});
const event={source:'beter.operator',task:'verify-provider'};
// Same valid NBA/bookmaker/market shape used by tests/provider.test.mjs.
const raw=()=>({id:'private-provider-event',sport_key:'basketball_nba',commence_time:'2026-11-20T04:00:00Z',home_team:'New York Knicks',away_team:'Boston Celtics',bookmakers:[{key:'draftkings',last_update:'2026-11-20T01:59:45Z',markets:[{key:'h2h',outcomes:[{name:'Boston Celtics',price:-175},{name:'New York Knicks',price:150}]},{key:'spreads',outcomes:[{name:'Boston Celtics',price:-110,point:-4.5},{name:'New York Knicks',price:-110,point:4.5}]},{key:'totals',outcomes:[{name:'Over',price:-110,point:224.5},{name:'Under',price:-110,point:224.5}]}]}]});
const response=(records=[raw()],headers={})=>new Response(JSON.stringify(records),{headers:{'content-type':'application/json','x-requests-remaining':'497','x-requests-used':'3','x-requests-last':'3',...headers}});
function fixture(options={}){
  const secrets=[],requests=[];assert.equal(typeof module.createProviderProbe,'function');
  const probe=module.createProviderProbe({env:env(),now:()=>now,secretClient:{send:async(command,options)=>{secrets.push({command,options});return{SecretString:JSON.stringify({apiKey})};}},fetchImpl:async(url,init)=>{requests.push({url:new URL(url),init});return response();},...options});
  return{probe,secrets,requests};
}
test('operator probe requests live NBA odds once, uses the dedicated secret only, and returns normalized counts plus numeric quota',async()=>{
  const f=fixture(),result=await f.probe(event);assert.deepEqual(result,{ok:true,eventCount:1,moneylineSelections:2,quota:{remaining:497,used:3,lastCost:3},sample:false});
  assert.equal(f.secrets.length,1);assert.equal(f.secrets[0].command.constructor.name,'GetSecretValueCommand');assert.deepEqual(f.secrets[0].command.input,{SecretId:secretArn});assert.ok(f.secrets[0].options.abortSignal instanceof AbortSignal);
  assert.equal(f.requests.length,1);const request=f.requests[0];assert.equal(request.url.origin,'https://api.the-odds-api.com');assert.equal(request.url.pathname,'/v4/sports/basketball_nba/odds');assert.equal(request.url.searchParams.get('apiKey'),apiKey);assert.equal(request.url.searchParams.get('bookmakers'),'draftkings');assert.equal(request.url.searchParams.get('markets'),'h2h,spreads,totals');assert.equal(request.url.searchParams.get('oddsFormat'),'american');assert.equal(request.init.redirect,'error');assert.ok(request.init.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(result),/private|Knicks|Celtics|https|apiKey|secret|draftkings/);
});
test('public/scheduler/malformed invocations and expired cutoff fail before any secret or provider access',async()=>{
  const f=fixture();for(const value of [null,{}, {source:'beter.scheduler',task:'verify-provider'}, {...event,task:'process'}, {...event,version:'2.0',requestContext:{http:{method:'POST'}}}])assert.deepEqual(await f.probe(value),{ok:false,code:'FORBIDDEN'});assert.equal(f.secrets.length,0);assert.equal(f.requests.length,0);
  for(const cutoff of [undefined,'invalid','2020-01-01T00:00:00']){const f=fixture({env:{...env(),BETER_FUNDING_CUTOFF_AT:cutoff}});assert.deepEqual(await f.probe(event),{ok:false,code:'FUNDING_REVIEW_REQUIRED'});assert.equal(f.secrets.length,0);}
});
test('runtime/env keys are never substituted for missing dedicated provider configuration',async()=>{
  for(const extra of [{BETER_PROVIDER_SECRET_ARN:''},{BETER_PROVIDER_SECRET_ARN:'https://unsafe.example'},{BETER_PROVIDER_SECRET_ARN:undefined,ODDS_API_KEY:apiKey,BETER_RUNTIME_SECRET_ARN:secretArn}]){const f=fixture({env:{...env(),...extra}});assert.deepEqual(await f.probe(event),{ok:false,code:'PROBE_UNCONFIGURED'});assert.equal(f.secrets.length,0);assert.equal(f.requests.length,0);}
});
test('secret service failures and malformed dedicated secrets return fixed safe codes without requesting odds',async()=>{
  for(const secret of [null,{}, {SecretString:'not json'}, {SecretString:'[]'}, {SecretString:'{"apiKey":""}'}, {SecretString:JSON.stringify({apiKey,dbPassword:'private'})}]){const f=fixture({secretClient:{send:async()=>secret}});assert.deepEqual(await f.probe(event),{ok:false,code:'SECRET_INVALID'});assert.equal(f.requests.length,0);}
  const f=fixture({secretClient:{send:async()=>{throw Error('private secret '+apiKey);}}});assert.deepEqual(await f.probe(event),{ok:false,code:'SECRET_UNAVAILABLE'});
});
test('only future normalized events with actual moneylines contribute to successful counts',async()=>{
  const live=raw();live.commence_time='2026-11-20T01:00:00Z';const noBook=raw();noBook.bookmakers=[];
  const f=fixture({fetchImpl:async()=>response([raw(),live,noBook])});assert.equal((await f.probe(event)).eventCount,1);
  for(const records of [[],[live],[noBook]]){const f=fixture({fetchImpl:async()=>response(records)});assert.deepEqual(await f.probe(event),{ok:false,code:'NO_FUTURE_MONEYLINES',quota:{remaining:497,used:3,lastCost:3}});}
});
test('malformed odds and upstream failures cannot leak provider responses, errors, URLs, or keys',async()=>{
  const malformed=raw();malformed.bookmakers[0].markets[0].outcomes[0].price=1;
  for(const [fetcher,code,quota]of [[async()=>response([malformed]),'PROVIDER_INVALID_DATA',{remaining:497,used:3,lastCost:3}],[async()=>new Response(apiKey,{status:429}),'PROVIDER_RATE_LIMITED'],[async()=>new Response(apiKey,{status:503}),'PROVIDER_UNAVAILABLE'],[async()=>{throw Error('https://private.example/?apiKey='+apiKey);},'PROVIDER_UNAVAILABLE']]){const f=fixture({fetchImpl:fetcher});assert.deepEqual(await f.probe(event),{ok:false,code,...(quota?{quota}:{})});}
});
test('quota output accepts only nonnegative safe integer header values',async()=>{
  for(const [headers,quota]of [[{'x-requests-remaining':''},{used:3,lastCost:3}],[{'x-requests-used':'-1'},{remaining:497,lastCost:3}],[{'x-requests-last':'0.5'},{remaining:497,used:3}],[{'x-requests-remaining':apiKey},{used:3,lastCost:3}],[{'x-requests-used':'999999999999999999999'},{remaining:497,lastCost:3}]]){const f=fixture({fetchImpl:async()=>response([raw()],headers)});assert.deepEqual(await f.probe(event),{ok:false,code:'QUOTA_INVALID',quota});}
  const f=fixture({fetchImpl:async()=>response([raw()],{'x-requests-remaining':'0'})});assert.equal((await f.probe(event)).quota.remaining,0);
});
test('whole-probe deadline aborts stalled SDK, fetch, and response-body work',async()=>{
  let secretSignal;const secret=fixture({timeoutMs:15,secretClient:{send:async(command,options)=>{secretSignal=options.abortSignal;return new Promise(()=>{});}}});assert.deepEqual(await secret.probe(event),{ok:false,code:'PROBE_TIMEOUT'});assert.equal(secretSignal.aborted,true);
  for(const body of [false,true]){let signal;const f=fixture({timeoutMs:15,fetchImpl:async(url,init)=>{signal=init.signal;return body?new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});}})):new Promise(()=>{});}});assert.deepEqual(await f.probe(event),{ok:false,code:'PROBE_TIMEOUT'});assert.equal(signal.aborted,true);}
});
test('provider probe is an explicit export separate from the public API handler',async()=>{
  const handler=await import('../aws/handler.ts');assert.equal(typeof handler.providerProbeHandler,'function');assert.notEqual(handler.providerProbeHandler,handler.handler);
});
test('provider HTTP failures distinguish invalid key, exhausted quota, denied access and rate limits with numeric quota only',async()=>{
  for(const [status,code]of [[401,'PROVIDER_KEY_INVALID'],[402,'PROVIDER_QUOTA_EXHAUSTED'],[403,'PROVIDER_ACCESS_DENIED'],[429,'PROVIDER_RATE_LIMITED'],[503,'PROVIDER_UNAVAILABLE']]){
    const f=fixture({fetchImpl:async()=>new Response('private provider response '+apiKey,{status,headers:{'x-requests-remaining':'0','x-requests-used':'500','x-requests-last':'3'}})});
    const result=await f.probe(event);assert.deepEqual(result,{ok:false,code,quota:{remaining:0,used:500,lastCost:3}});assert.doesNotMatch(JSON.stringify(result),/private|https|apiKey|secret/);
  }
});
test('failed requests retain partial numeric quota and discard missing or untrusted values',async()=>{
  const f=fixture({fetchImpl:async()=>new Response(apiKey,{status:401,headers:{'x-requests-remaining':'0','x-requests-used':apiKey}})});
  assert.deepEqual(await f.probe(event),{ok:false,code:'PROVIDER_KEY_INVALID',quota:{remaining:0}});
  const absent=fixture({fetchImpl:async()=>new Response(apiKey,{status:401})});assert.deepEqual(await absent.probe(event),{ok:false,code:'PROVIDER_KEY_INVALID'});
});
test('a successful HTTP response with malformed provider data remains an invalid-data failure with captured quota',async()=>{
  const f=fixture({fetchImpl:async()=>new Response('private invalid JSON '+apiKey,{headers:{'x-requests-remaining':'497','x-requests-used':'3','x-requests-last':'3'}})});
  assert.deepEqual(await f.probe(event),{ok:false,code:'PROVIDER_INVALID_DATA',quota:{remaining:497,used:3,lastCost:3}});
});
test('a body deadline preserves already observed numeric quota while aborting provider work',async()=>{
  let signal;
  const f=fixture({timeoutMs:15,fetchImpl:async(url,init)=>{signal=init.signal;return new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});}}),{headers:{'x-requests-remaining':'497','x-requests-used':'3','x-requests-last':'3'}});}});
  assert.deepEqual(await f.probe(event),{ok:false,code:'PROBE_TIMEOUT',quota:{remaining:497,used:3,lastCost:3}});assert.equal(signal.aborted,true);
});
