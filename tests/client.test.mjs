import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, ApiError, adaptPortfolio } from '../dist/api-client.js';
const key='beter-session-v1';
const user={id:'user-1',email:'practice@example.com'};
const publicSession=(overrides={})=>({user,expires_at:Math.floor(Date.now()/1000)+3600,...overrides});
const jsonResponse=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
function memoryStorage(initial={}) {const entries=new Map(Object.entries(initial));return {getItem:key=>entries.get(key)??null,setItem:(key,value)=>entries.set(key,value),removeItem:key=>entries.delete(key)};}
const makeClient=options=>createApiClient(options);
const canonical = () => ({
  id:'portfolio-1', initial_bankroll_cents:1000000, balance_cents:990000,
  bets:[{id:'bet-1',stake_cents:10000,potential_payout_cents:25000,payout_cents:0,status:'open',created_at:'2026-11-19T20:00:00Z',settled_at:null,odds:2.5,selections:[{id:'pick-1',event_id:'event-1',event_name:'BOS at NYK',team:'New York Knicks',market:'Moneyline',line:null,odds:150,starts_at:'2026-11-20T01:00:00Z'}]}],
  ledger:[{id:'entry-1',type:'stake',amount_cents:-10000,balance_cents:990000,bankroll_cents:1000000,created_at:'2026-11-19T20:00:00Z',bet_id:'bet-1'}],
});
async function signedIn(fetchImpl,options={}) {const client=makeClient({...options,fetchImpl:async(url,init)=>url.endsWith('/auth/signin')?jsonResponse({session:publicSession()}):fetchImpl(url,init)});await client.signin(user.email,'correct-horse-battery');return client;}

test('client exposes public memory session restore and cancellation contracts',()=>{const c=makeClient({fetchImpl:async()=>jsonResponse({})});for(const name of ['restoreSession','cancelAuthentication','session','quote'])assert.equal(typeof c[name],'function');assert.equal(c.session(),null);});
test('legacy script-readable credentials are removed without being loaded',()=>{const storage=memoryStorage({[key]:JSON.stringify({access_token:'secret',refresh_token:'secret-refresh',user})});const c=makeClient({storage,fetchImpl:async()=>jsonResponse({})});assert.equal(c.session(),null);assert.equal(storage.getItem(key),null);});
test('signin sends cookie transport and never persists tokens or personal data',async()=>{const storage=memoryStorage();let request;const c=makeClient({storage,fetchImpl:async(url,init)=>{request={url,init};return jsonResponse({session:{...publicSession(),access_token:'hidden',refresh_token:'hidden-refresh'},user});}});const result=await c.signin(user.email,'correct-horse-battery');assert.equal(request.url,'/api/auth/signin');assert.equal(request.init.credentials,'same-origin');assert.equal(request.init.headers.get('x-beter-client'),'browser');assert.equal(request.init.headers.get('authorization'),null);assert.deepEqual(JSON.parse(request.init.body),{email:user.email,password:'correct-horse-battery'});assert.equal(storage.getItem(key),null);assert.deepEqual(c.session(),publicSession());assert.equal(result.session.access_token,undefined);const snapshot=c.session();snapshot.user.email='changed';assert.equal(c.session().user.email,user.email);});
test('restore uses the HttpOnly cookie through a public endpoint',async()=>{let request;const c=makeClient({fetchImpl:async(url,init)=>{request={url,init};return jsonResponse({session:publicSession()});}});await c.restoreSession();assert.equal(request.url,'/api/auth/session');assert.equal(request.init.method,'GET');assert.equal(request.init.credentials,'same-origin');assert.equal(c.session().user.id,user.id);});
test('signed-out and invalid restored sessions remain signed out',async()=>{for(const session of [null,{}, {user:{}}, {user:{id:''}}]){const c=makeClient({fetchImpl:async()=>jsonResponse({session})});await c.restoreSession();assert.equal(c.session(),null);}});
test('stale restore cannot overwrite a newer successful signin',async()=>{let release;const c=makeClient({fetchImpl:async url=>url.endsWith('/auth/session')?new Promise(resolve=>release=()=>resolve(jsonResponse({session:null}))):jsonResponse({session:publicSession()})});const restoring=c.restoreSession();await c.signin(user.email,'correct-horse-battery');release();await restoring;assert.equal(c.session().user.id,user.id);});
test('a late older signin never replaces a newer public session',async()=>{let release;const c=makeClient({fetchImpl:async(url,init)=>JSON.parse(init.body).email==='old@example.test'?new Promise(resolve=>release=()=>resolve(jsonResponse({session:publicSession({user:{id:'old',email:'old@example.test'}})}))):jsonResponse({session:publicSession()})});const old=c.signin('old@example.test','correct-horse-battery').catch(e=>e);await c.signin(user.email,'correct-horse-battery');release();assert.equal((await old).code,'REQUEST_ABORTED');assert.equal(c.session().user.id,user.id);});
test('cancelAuthentication aborts a pending request and prevents a late commit',async()=>{let signal,release;const c=makeClient({fetchImpl:async(url,init)=>{signal=init.signal;return new Promise(resolve=>release=()=>resolve(jsonResponse({session:publicSession()})));}});const result=c.signin(user.email,'correct-horse-battery').catch(e=>e);c.cancelAuthentication();assert.equal(signal.aborted,true);release();assert.equal((await result).code,'REQUEST_ABORTED');assert.equal(c.session(),null);});
test('signup confirmation and invalid session responses cannot fabricate a signed-in account',async()=>{const c=makeClient({fetchImpl:async()=>jsonResponse({session:null,user,requiresConfirmation:true})});assert.equal((await c.signup(user.email,'long-password')).requiresConfirmation,true);assert.equal(c.session(),null);const bad=makeClient({fetchImpl:async()=>jsonResponse({session:{user:{}}})});await assert.rejects(bad.signin(user.email,'long-password'),e=>e.code==='INVALID_RESPONSE');});
test('authenticated cookie requests preserve payloads and never send browser bearer tokens',async()=>{const requests=[];const c=await signedIn(async(url,init)=>{requests.push({url,init});return jsonResponse(url.endsWith('/markets')?{events:[]}:{id:'ok'});});await c.portfolio();await c.newPortfolio('Second');await c.markets();await c.quote(['pick-1']);await c.placeBet('quote-1',2500,'request-1');assert.deepEqual(requests.map(r=>r.url),['/api/portfolio','/api/portfolios','/api/markets','/api/quotes','/api/bets']);assert.ok(requests.every(r=>r.init.headers.get('authorization')===null&&r.init.credentials==='same-origin'));assert.deepEqual(JSON.parse(requests[1].init.body),{name:'Second'});assert.deepEqual(JSON.parse(requests[3].init.body),{selectionIds:['pick-1']});assert.deepEqual(JSON.parse(requests[4].init.body),{quoteId:'quote-1',stakeCents:2500,requestId:'request-1'});});
test('anonymous protected operations fail before network access',async()=>{let calls=0;const c=makeClient({fetchImpl:async()=>{calls++;return jsonResponse({});}});await assert.rejects(c.portfolio(),e=>e instanceof ApiError&&e.code==='AUTH_REQUIRED');assert.equal(calls,0);});
test('401 clears public session without replaying a state-changing request',async()=>{let calls=0;const c=await signedIn(async()=>{calls++;return jsonResponse({error:{code:'AUTH_REQUIRED',message:'Sign in again.'}},401);});await assert.rejects(c.placeBet('quote',100,'request'),e=>e.code==='AUTH_REQUIRED');assert.equal(c.session(),null);assert.equal(calls,1);});
test('network errors never replay placement or leak internal diagnostics',async()=>{let calls=0;const c=await signedIn(async()=>{calls++;throw new Error('upstream key=secret');});await assert.rejects(c.placeBet('quote',100,'request'),e=>e.code==='NETWORK_ERROR'&&!e.message.includes('secret'));assert.equal(calls,1);});
test('body consumption remains bounded by the request timeout',async()=>{let requestSignal;const c=makeClient({timeoutMs:25,fetchImpl:async(url,init)=>{requestSignal=init.signal;return new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});}}),{headers:{'content-type':'application/json'}});}});const result=await Promise.race([c.config().catch(e=>e),new Promise(resolve=>setTimeout(()=>resolve('still-pending'),100))]);assert.equal(result.code,'REQUEST_TIMEOUT');assert.equal(requestSignal.aborted,true);});
test('caller abort cancels a quote separately from deadline expiry',async()=>{const controller=new AbortController();const c=await signedIn(async(url,init)=>new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})));const result=c.quote(['pick-1'],{signal:controller.signal}).catch(e=>e);controller.abort();assert.equal((await result).code,'REQUEST_ABORTED');});
test('manual timeout fallback covers stalled response bodies',async()=>{const timeout=AbortSignal.timeout,any=AbortSignal.any;try{AbortSignal.timeout=undefined;AbortSignal.any=undefined;const c=makeClient({timeoutMs:10,fetchImpl:async(url,init)=>new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(init.signal.reason),{once:true});}}))});await assert.rejects(c.config(),e=>e.code==='REQUEST_TIMEOUT');}finally{AbortSignal.timeout=timeout;AbortSignal.any=any;}});
test('malformed response bodies and scalar envelopes fail safely',async()=>{for(const body of ['bad','null','[]','3']){const c=makeClient({fetchImpl:async()=>new Response(body)});await assert.rejects(c.config(),e=>e.code==='INVALID_RESPONSE');}const c=makeClient({fetchImpl:async()=>new Response('upstream password=secret',{status:503})});await assert.rejects(c.config(),e=>e.status===503&&!e.message.includes('secret'));});
test('validation errors preserve safe public codes and messages',async()=>{const c=await signedIn(async()=>jsonResponse({error:{code:'QUOTE_EXPIRED',message:'Review a fresh quote.'}},409));await assert.rejects(c.quote(['p']),e=>e.code==='QUOTE_EXPIRED'&&e.message==='Review a fresh quote.');});
test('logout clears memory even when its request fails',async()=>{const c=await signedIn(async()=>{throw new Error('offline');});await assert.rejects(c.signout(),e=>e.code==='NETWORK_ERROR');assert.equal(c.session(),null);});
test('logout cancels earlier auth and accepts an empty successful response',async()=>{const c=await signedIn(async()=>new Response(null,{status:204}));assert.equal(await c.signout(),null);assert.equal(c.session(),null);});
test('recovery token is sent only explicitly and never becomes a session',async()=>{let request;const c=makeClient({fetchImpl:async(url,init)=>{request={url,init};return jsonResponse({ok:true});}});await c.updatePassword('new-strong-password','recovery-only');assert.equal(request.init.headers.get('authorization'),'Bearer recovery-only');assert.equal(c.session(),null);await c.recover(user.email);assert.equal(request.init.headers.get('authorization'),null);await assert.rejects(c.updatePassword('new-password'),e=>e.code==='AUTH_REQUIRED');await assert.rejects(c.updatePassword('new-password',''),e=>e.code==='AUTH_REQUIRED');});
test('cookie-session passwords do not expose an authorization header',async()=>{let headers;const c=await signedIn(async(url,init)=>{headers=init.headers;return jsonResponse({ok:true});});await c.updatePassword('new-password');assert.equal(headers.get('authorization'),null);});
test('denied browser storage does not prevent memory-only session metadata',async()=>{const storage={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');},removeItem(){throw Error('blocked');}};const c=makeClient({storage,fetchImpl:async()=>jsonResponse({session:publicSession()})});await c.signin(user.email,'long-password');assert.equal(c.session().user.id,user.id);});

test('portfolio adapter converts cents and accepted selections without mutating records',()=>{
  assert.equal(typeof adaptPortfolio,'function');
  const source=canonical();const before=structuredClone(source);const state=adaptPortfolio(source);
  assert.equal(state.version,1);assert.equal(state.portfolioId,'portfolio-1');assert.equal(state.id,'portfolio-1');
  assert.equal(state.initialBankroll,10000);assert.equal(state.balance,9900);
  assert.equal(state.bets[0].stake,100);assert.equal(state.bets[0].potentialPayout,250);assert.equal(state.bets[0].payout,0);assert.equal(state.bets[0].mode,'single');
  assert.equal(state.bets[0].createdAt,'2026-11-19T20:00:00Z');assert.equal(state.bets[0].selections[0].eventId,'event-1');assert.equal(state.bets[0].selections[0].eventName,'BOS at NYK');
  assert.equal(state.bets[0].selections[0].startsAt,'2026-11-20T01:00:00Z');
  assert.equal(state.ledger[0].amount,-100);assert.equal(state.ledger[0].balance,9900);assert.equal(state.ledger[0].bankroll,10000);
  assert.equal(state.ledger[0].at,'2026-11-19T20:00:00Z');assert.equal(state.ledger[0].createdAt,'2026-11-19T20:00:00Z');
  assert.deepEqual(source,before);
});

test('adapter handles empty fresh portfolios and preserves camel-case selection fields',()=>{
  assert.equal(typeof adaptPortfolio,'function');
  const data=canonical();data.bets[0].selections[0]={...data.bets[0].selections[0],eventId:'camel-id',eventName:'Camel event',startsAt:'future'};
  assert.equal(adaptPortfolio(data).bets[0].selections[0].eventId,'camel-id');
  data.bets=[];data.ledger=[];
  assert.deepEqual(adaptPortfolio(data).bets,[]);
});

test('adapter rejects invalid and unsafe currency fields instead of rendering NaN',()=>{
  assert.equal(typeof adaptPortfolio,'function');
  for(const bad of [NaN,Infinity,1.1,'100',Number.MAX_SAFE_INTEGER+1]) {
    const data=canonical();data.balance_cents=bad;
    assert.throws(()=>adaptPortfolio(data),/portfolio|currency|cents/i);
  }
  const data=canonical();data.ledger[0].amount_cents=0.5;assert.throws(()=>adaptPortfolio(data),/cents/i);
  const badBet=canonical();badBet.bets[0].potential_payout_cents=-1;assert.throws(()=>adaptPortfolio(badBet),/cents/i);
});

test('audited corrections can expose a negative available balance without altering nonnegative stakes',()=>{
  const data=canonical();data.balance_cents=-2500;data.ledger[0].balance_cents=-2500;data.ledger[0].bankroll_cents=-2500;
  const state=adaptPortfolio(data);
  assert.equal(state.balance,-25);assert.equal(state.ledger[0].balance,-25);assert.equal(state.ledger[0].bankroll,-25);
  assert.equal(state.bets[0].stake,100);
});

test('an older protected request cannot clear a newer signed-in account',async()=>{let release;const c=makeClient({fetchImpl:async(url,init)=>{if(url.endsWith('/auth/signin'))return jsonResponse({session:publicSession({user:{id:JSON.parse(init.body).email}})});return new Promise(resolve=>release=()=>resolve(jsonResponse({error:{code:'AUTH_REQUIRED'}},401)));}});await c.signin('old@example.test','long-password');const pending=c.portfolio().catch(e=>e);await c.signin('new@example.test','long-password');release();assert.equal((await pending).status,401);assert.equal(c.session().user.id,'new@example.test');});

test('an older logout response cannot clear a newer signed-in account',async()=>{let release;const c=makeClient({fetchImpl:async(url,init)=>url.endsWith('/auth/signout')?new Promise(resolve=>release=()=>resolve(jsonResponse({ok:true}))):jsonResponse({session:publicSession({user:{id:JSON.parse(init.body).email}})})});await c.signin('old@example.test','long-password');const pending=c.signout();const next=c.signin('new@example.test','long-password');release();await pending;await next;assert.equal(c.session().user.id,'new@example.test');});
