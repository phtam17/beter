import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('../scripts/aws-hosted-checks.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const site='https://fixture.cloudfront.net',api='https://fixture.execute-api.us-west-2.amazonaws.com';
const state=()=>({launchOpen:false,parameters:{LaunchOpen:'false',DataMode:'sample',TestEmailAllowlist:'owner@example.test'},runtime:{jobSecret:'private-job-fixture-value-1234567890123',sessionSecret:'private-session-fixture-value-123456789',originSecret:'private-origin-fixture-value-123456789',oddsApiKey:''},stagingAccess:'Basic '+Buffer.from('beter:private-staging-fixture-value').toString('base64'),outputs:{CloudFrontDomain:'fixture.cloudfront.net',ApiEndpoint:api}});
const security={'strict-transport-security':'max-age=31536000','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'strict-origin-when-cross-origin','content-security-policy':"default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",'permissions-policy':'camera=(), microphone=(), geolocation=()'};
const json=(value,status=200,extra={})=>new Response(JSON.stringify(value),{status,headers:{...security,'content-type':'application/json','cache-control':'no-store',...extra}});
function fixture(override,{gateway=false}={}){
  const calls=[],privateState=state();
  privateState.parameters.FreeGatewayHosting=gateway?'true':'false';
  if(gateway)privateState.outputs.PublicGatewayOrigin=api;
  async function normal(url,init){
    const parsed=new URL(url),path=parsed.pathname,headers=new Headers(init.headers);
    if(parsed.origin===api&&!gateway)return json({error:{code:'FORBIDDEN'}},403);
    if(headers.get('x-beter-staging-access')!==privateState.stagingAccess)return new Response('Closed staging',{status:401,headers:{'cache-control':'no-store'}});
    if(path==='/')return new Response('<!doctype html><title>Beter</title><script type="module" src="./app.js"></script>',{headers:{...security,'content-type':'text/html','cache-control':'no-cache'}});
    if(path==='/app.js')return new Response('import {start} from "./api-client.js"; start();',{headers:{...security,'content-type':'text/javascript; charset=utf-8','cache-control':'no-cache'}});
    if(path==='/api/config')return json({mode:'aws',dataMode:'sample',liveOddsConfigured:false,supabaseConfigured:false});
    if(path==='/api/health')return json({ok:true,service:'beter-api'});
    if(path==='/api/health/details')return headers.get('authorization')==='Bearer '+privateState.runtime.jobSecret?json({schema_version:4,ledger_mismatches:0,unsettled_bets:0,jobs:[]}):json({error:{code:'FORBIDDEN'}},403);
    if(path==='/api/auth/session')return json({session:null},200,headers.has('cookie')?{'set-cookie':'__Host-beter-session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax'}:{});
    if(path==='/api/portfolio')return json({error:{code:'AUTH_REQUIRED',message:'Sign in to continue.'}},401);
    if(path==='/api/auth/signin')return json({error:{code:'AUTH_FAILED',message:'Sign in failed. Check your details or confirm your email.'}},401);
    if(path==='/api/auth/signup')return json({error:{code:'SIGNUP_UNAVAILABLE',message:'Account registration is not available. Contact support or try again later.'}},403);
    throw Error('unexpected test path');
  }
  const fetchImpl=async(url,init)=>{calls.push({url,init});return override?override(url,init,normal,privateState):normal(url,init);};
  const run=options=>module.checkAwsHosted({state:privateState,fetchImpl,now:()=>new Date('2026-11-20T20:00:00Z'),randomId:()=> '00000000-0000-4000-8000-000000000001',...options});
  return{calls,run,state:privateState};
}

test('default hosted checks are read-only, keep credentials at the intended edge routes, and return only safe evidence',async()=>{
  assert.equal(typeof module.checkAwsHosted,'function');const f=fixture(),result=await f.run();
  assert.equal(result.ok,true);assert.equal(result.scope,'closed-staging');assert.equal(result.publicLaunchReady,false);assert.equal(result.authProbes,false);
  assert.equal(result.checks.length,13);assert.ok(result.checks.every(check=>check.ok));assert.ok(f.calls.every(call=>call.init.method==='GET'));
  assert.ok(f.calls.every(call=>call.init.redirect==='manual'&&call.init.signal instanceof AbortSignal));
  const direct=f.calls.find(call=>call.url.startsWith(api));assert.equal(new Headers(direct.init.headers).get('x-beter-staging-access'),null);assert.equal(new Headers(direct.init.headers).get('authorization'),null);
  for(const call of f.calls){const headers=new Headers(call.init.headers);assert.equal(headers.get('x-beter-origin-secret'),null);if(headers.has('authorization'))assert.equal(call.url,site+'/api/health/details');}
  const output=JSON.stringify(result);for(const secret of [f.state.stagingAccess,...Object.values(f.state.runtime).filter(Boolean)])assert.ok(!output.includes(secret));
});

test('explicit auth probes use reserved synthetic email, reject safe failures, and never request recovery or confirmed signup',async()=>{
  assert.equal(typeof module.checkAwsHosted,'function');const f=fixture(),result=await f.run({authProbes:true});
  assert.equal(result.ok,true);assert.equal(result.checks.length,15);
  const posts=f.calls.filter(call=>call.init.method==='POST');assert.equal(posts.length,2);
  assert.deepEqual(posts.map(call=>new URL(call.url).pathname),['/api/auth/signin','/api/auth/signup']);
  for(const call of posts){const body=JSON.parse(call.init.body);assert.match(body.email,/@example\.invalid$/);assert.notEqual(body.email,'owner@example.test');assert.ok(body.password.length>=10);const headers=new Headers(call.init.headers);assert.equal(headers.get('origin'),site);assert.equal(headers.get('x-beter-client'),'browser');}
  assert.ok(!JSON.stringify(result).includes(JSON.parse(posts[0].init.body).password));
});

test('state validation refuses insecure, redirected, incomplete, or opened deployment targets before fetch',async()=>{
  assert.equal(typeof module.checkAwsHosted,'function');
  for(const mutation of [s=>s.outputs.CloudFrontDomain='localhost:8000',s=>s.outputs.CloudFrontDomain='fixture.cloudfront.net/steal',s=>s.outputs.ApiEndpoint='https://evil.example',s=>s.outputs.ApiEndpoint=api+'?secret=1',s=>s.stagingAccess='bad',s=>s.runtime.jobSecret='',s=>s.launchOpen=true,s=>s.parameters.LaunchOpen='true',s=>s.parameters.DataMode='live']){
    const f=fixture();mutation(f.state);await assert.rejects(f.run(),error=>error.message==='Hosted checks require complete closed AWS staging state.');assert.equal(f.calls.length,0);
  }
});

test('opened public gates, missing security headers, and generic provider outages are failures',async()=>{
  assert.equal(typeof module.checkAwsHosted,'function');
  const f=fixture(async(url,init,next)=>{
    if(url===site&&!(new Headers(init.headers)).has('x-beter-staging-access'))return json({ok:true});
    if(url===site+'/')return new Response('<title>Beter</title>',{headers:{'content-type':'text/html'}});
    if(url.endsWith('/auth/signup'))return json({error:{code:'ACCOUNT_UNAVAILABLE',message:'Temporary failure'}},503);
    return next(url,init);
  });
  const result=await f.run({authProbes:true});assert.equal(result.ok,false);
  for(const name of ['public-site-gate','security-headers','closed-signup'])assert.equal(result.checks.find(check=>check.name===name).ok,false);
});

test('unsafe cookies, stale schema and leaked private values fail without exposing response contents',async()=>{
  assert.equal(typeof module.checkAwsHosted,'function');
  const f=fixture(async(url,init,next,s)=>{
    if(url.endsWith('/health/details')&&new Headers(init.headers).has('authorization'))return json({schema_version:3,ledger_mismatches:0,unsettled_bets:0});
    if(url.endsWith('/auth/session')&&new Headers(init.headers).has('cookie'))return json({session:null},200,{'set-cookie':'__Host-beter-session=; Path=/; SameSite=None'});
    if(url.endsWith('/api/config')&&new Headers(init.headers).has('x-beter-staging-access'))return json({mode:'aws',dataMode:'sample',secret:s.runtime.sessionSecret});
    return next(url,init);
  });
  const result=await f.run();assert.equal(result.ok,false);
  for(const name of ['private-health','secure-cookie-clearing','aws-sample-configuration'])assert.equal(result.checks.find(check=>check.name===name).ok,false);
  assert.ok(!JSON.stringify(result).includes(f.state.runtime.sessionSecret));assert.ok(!JSON.stringify(result).includes('SameSite=None'));
});

test('network failures, malformed or oversized bodies, and redirects are bounded and redacted',async()=>{
  assert.equal(typeof module.checkAwsHosted,'function');
  for(const respond of [()=>{throw Error('private-job-fixture-value-1234567890123');},()=>new Response('not-json'),()=>new Response('x'.repeat(140000)),()=>new Response(null,{status:302,headers:{location:'https://steal.example'}})]){
    const f=fixture(async(url,init,next)=>url.endsWith('/api/config')?respond():next(url,init));
    const result=await f.run();assert.equal(result.ok,false);assert.ok(!JSON.stringify(result).includes('private-job'));assert.ok(!JSON.stringify(result).includes('steal.example'));
  }
});

test('a stalled response cannot keep hosted checks pending beyond the configured request deadline',async()=>{
  assert.equal(typeof module.checkAwsHosted,'function');
  const f=fixture(async(url,init,next)=>url.endsWith('/api/config')?new Promise(()=>{}):next(url,init));
  const result=await f.run({timeoutMs:10});assert.equal(result.ok,false);assert.ok(result.checks.some(check=>check.code==='REQUEST_TIMEOUT'));
});

test('private state loading errors are safe and never start a partial check run',async()=>{
  assert.equal(typeof module.checkAwsHostedFromState,'function');
  let calls=0;
  for(const readState of [async()=>{throw Error('private path and account');},async()=>'{"private":"unterminated'])await assert.rejects(()=>module.checkAwsHostedFromState({readState,fetchImpl:async()=>{calls++;}}),error=>error.message==='Private AWS deployment state is unavailable or invalid.');
  assert.equal(calls,0);
});

test('provider diagnostics or unexpected session fields cannot pass safe anonymous auth probes',async()=>{
  const f=fixture(async(url,init,next)=>{
    if(url.endsWith('/auth/signin'))return json({error:{code:'AUTH_FAILED',message:'UserNotFoundException: private provider response'},session:{access_token:'unsafe-provider-token'}},401);
    if(url.endsWith('/auth/signup'))return json({error:{code:'SIGNUP_UNAVAILABLE',message:'UserLambdaValidationException: private allowlist'}},403);
    return next(url,init);
  });
  const result=await f.run({authProbes:true});
  assert.equal(result.checks.find(check=>check.name==='nonexistent-signin').ok,false);
  assert.equal(result.checks.find(check=>check.name==='closed-signup').ok,false);
  assert.ok(!JSON.stringify(result).includes('unsafe-provider-token'));
});

test('free Gateway checks use the public API origin, expect its access gate, and never contact disabled CloudFront',async()=>{
  const f=fixture(undefined,{gateway:true});f.state.outputs.CloudFrontDomain='disabled.invalid';
  const result=await f.run({authProbes:true});assert.equal(result.ok,true);assert.equal(result.topology,'gateway');assert.equal(result.checks.length,15);
  assert.equal(result.checks.find(check=>check.name==='direct-api-gate').status,401);
  assert.ok(f.calls.every(call=>new URL(call.url).origin===api));
  assert.ok(f.calls.every(call=>new Headers(call.init.headers).get('x-beter-origin-secret')===null));
  assert.equal(new Headers(f.calls.find(call=>call.url.endsWith('/health/details')&&new Headers(call.init.headers).has('authorization')).init.headers).get('authorization'),'Bearer '+f.state.runtime.jobSecret);
  assert.equal(JSON.parse(f.calls.find(call=>call.url.endsWith('/auth/signin')).init.body).email.endsWith('@example.invalid'),true);
});

test('free hosting defaults to Gateway and refuses missing or mismatched public endpoint outputs before sending access details',async()=>{
  const f=fixture(undefined,{gateway:true});delete f.state.parameters.FreeGatewayHosting;assert.equal((await f.run()).ok,true);
  for(const value of [undefined,'http://fixture.execute-api.us-west-2.amazonaws.com','https://attacker.execute-api.us-west-2.amazonaws.com','https://evil.example']){
    const bad=fixture(undefined,{gateway:true});bad.state.outputs.PublicGatewayOrigin=value;await assert.rejects(bad.run(),error=>error.message==='Hosted checks require complete closed AWS staging state.');assert.equal(bad.calls.length,0);
  }
});

test('a successful HTML response cannot hide a missing or incorrectly typed script asset',async()=>{
  for(const response of [()=>new Response('<!doctype html><title>Beter</title>',{headers:{'content-type':'text/html'}}),()=>new Response('not found',{status:404}),()=>new Response('export const wrong=true;',{headers:{'content-type':'text/javascript'}})]){
    const f=fixture(async(url,init,next)=>url.endsWith('/app.js')?response():next(url,init),{gateway:true});
    const result=await f.run();assert.equal(result.ok,false);assert.equal(result.checks.find(check=>check.name==='static-app-module')?.ok,false);
  }
});
test('inspection serializes requests for a small AWS account and preserves real service failures',async()=>{
 let active=0,peak=0;const f=fixture(async(url,init,normal)=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,2));return new URL(url).pathname==='/api/health'?json({error:{code:'BACKEND_UNAVAILABLE'}},503):normal(url,init);}finally{active--;}});const result=await f.run({requestIntervalMs:0});assert.equal(peak,1);assert.equal(result.ok,false);assert.equal(result.checks.find(x=>x.name==='public-health').status,503);assert.equal(f.calls.length,12);
});
