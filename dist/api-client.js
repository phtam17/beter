// Browser credentials live only in the server-managed HttpOnly cookie.
const LEGACY_SESSION_KEY='beter-session-v1';
const PENDING_LOGOUT_KEY='beter-logout-pending-v1';
export class ApiError extends Error {
  constructor(message,{status=0,code='API_ERROR',cause}={}) {super(message,{cause});this.name='ApiError';this.status=status;this.code=code;}
}
const authRequired=()=>new ApiError('Please sign in again to continue.',{status:401,code:'AUTH_REQUIRED'});
const aborted=()=>new ApiError('This request was cancelled.',{code:'REQUEST_ABORTED'});
function normalizeSession(candidate,fallbackUser) {
  const user=candidate?.user??fallbackUser;
  if(!candidate||!user||typeof user.id!=='string'||!user.id.trim())return null;
  return {user:{id:user.id,...(typeof user.email==='string'?{email:user.email}:{})},...(Number.isFinite(candidate.expires_at)?{expires_at:candidate.expires_at}:{})};
}
function requestSignal(userSignal,timeoutMs) {
  let timer;
  const timeoutController=new AbortController();
  const deadline=typeof AbortSignal.timeout==='function'?AbortSignal.timeout(timeoutMs):timeoutController.signal;
  if(deadline===timeoutController.signal)timer=setTimeout(()=>timeoutController.abort(new DOMException('The request timed out.','TimeoutError')),timeoutMs);
  const signals=userSignal?[userSignal,deadline]:[deadline];
  if(typeof AbortSignal.any==='function')return {signal:AbortSignal.any(signals),cleanup:()=>clearTimeout(timer)};
  const controller=new AbortController();
  const listeners=signals.map(signal=>{const abort=()=>controller.abort(signal.reason);if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});return [signal,abort];});
  return {signal:controller.signal,cleanup:()=>{clearTimeout(timer);for(const [signal,listener]of listeners)signal.removeEventListener('abort',listener);}};
}

export function createApiClient(options={}) {
  const {baseUrl='/api',fetchImpl=globalThis.fetch,timeoutMs=15000}=options;
  const endpoint=baseUrl.replace(/\/+$/,'');
  // Existing script-readable sessions deliberately require a fresh, cookie-backed sign-in.
  let storage;
  try {storage='storage'in options?options.storage:globalThis.localStorage;storage?.removeItem(LEGACY_SESSION_KEY);}catch{}
  let activeSession=null,authGeneration=0,authController=null,restoreController=null,logoutRequest=null,pendingLogout=false,persistentLogout=false;
  function logoutState(){
    try{
      const stored=storage?.getItem(PENDING_LOGOUT_KEY);
      if(stored!==null&&stored!==undefined){pendingLogout=true;persistentLogout=true;activeSession=null;}
      else if(persistentLogout&&!logoutRequest){pendingLogout=false;persistentLogout=false;}
    }catch{persistentLogout=false;}
    return {pending:pendingLogout,persistent:pendingLogout&&persistentLogout};
  }
  function cancelAuthentication(){authGeneration++;authController?.abort();restoreController?.abort();authController=null;restoreController=null;}
  async function send(path,method,serializedBody,accessToken,userSignal) {
    const headers=new Headers({Accept:'application/json','X-Beter-Client':'browser'});
    if(serializedBody!==undefined)headers.set('Content-Type','application/json');
    if(accessToken)headers.set('Authorization',`Bearer ${accessToken}`);
    const {signal,cleanup}=requestSignal(userSignal,timeoutMs);
    let response;
    try {
      response=await fetchImpl(`${endpoint}${path}`,{method,headers,credentials:'same-origin',...(serializedBody!==undefined?{body:serializedBody}:{}),signal});
      if(signal.aborted)throw signal.reason;
      if(response.status===204)return {response,payload:null};
      let payload;
      try{payload=await response.json();}
      catch(error){if(signal.aborted||error?.name==='AbortError'||error?.name==='TimeoutError')throw error;if(response.ok)throw new ApiError('Beter returned an invalid response. Please try again.',{status:response.status,code:'INVALID_RESPONSE'});payload=null;}
      if(signal.aborted)throw signal.reason;
      return {response,payload};
    }catch(error){
      if(error instanceof ApiError)throw error;
      if(signal.aborted||error?.name==='AbortError'||error?.name==='TimeoutError'){
        if(signal.reason?.name==='TimeoutError'||error?.name==='TimeoutError')throw new ApiError('The request timed out. Please try again.',{code:'REQUEST_TIMEOUT',cause:error});
        throw aborted();
      }
      throw new ApiError('Unable to reach Beter. Check your connection and try again.',{code:'NETWORK_ERROR',cause:error});
    }finally{cleanup();}
  }
  async function request(path,{method='GET',body,authenticated=false,accessToken,signal}={}) {
    const generation=authGeneration;
    if(accessToken!==undefined&&(typeof accessToken!=='string'||!accessToken.trim()))throw authRequired();
    if(authenticated&&logoutState().pending)throw new ApiError('Sign-out is unfinished. Connect and retry signing out.',{code:'SIGNOUT_PENDING'});
    if(authenticated&&!activeSession)throw authRequired();
    const {response,payload}=await send(path,method,body===undefined?undefined:JSON.stringify(body),accessToken,signal);
    if(authenticated&&response.status===401){if(generation===authGeneration)activeSession=null;throw authRequired();}
    if(!response.ok)throw new ApiError(typeof payload?.error?.message==='string'?payload.error.message:'The request could not be completed. Please try again.',{status:response.status,code:typeof payload?.error?.code==='string'?payload.error.code:'API_ERROR'});
    if(response.status!==204&&(!payload||typeof payload!=='object'||Array.isArray(payload)))throw new ApiError('Beter returned an invalid response. Please try again.',{status:response.status,code:'INVALID_RESPONSE'});
    return payload;
  }
  async function authenticate(path,email,password) {
    if(logoutState().pending||logoutRequest)await signout();
    cancelAuthentication();const generation=authGeneration,controller=new AbortController();authController=controller;
    try{
      const payload=await request(path,{method:'POST',body:{email,password},signal:controller.signal});
      if(generation!==authGeneration)throw aborted();
      if(payload.session){activeSession=normalizeSession(payload.session,payload.user);if(!activeSession)throw new ApiError('Beter returned an invalid account session.',{code:'INVALID_RESPONSE'});}
      return {session:payload.session?structuredClone(activeSession):null,...(payload.user?{user:activeSession?.user??{id:payload.user.id,...(typeof payload.user.email==='string'?{email:payload.user.email}:{})}}:{}),...(payload.requiresConfirmation?{requiresConfirmation:true}:{}),...(payload.confirmationMethod==='code'?{confirmationMethod:'code'}:{})};
    }finally{if(generation===authGeneration)authController=null;}
  }
  async function recoveryRequest(path,body) {
    cancelAuthentication();const generation=authGeneration,controller=new AbortController();authController=controller;
    try{
      const payload=await request(path,{method:'POST',body,signal:controller.signal});
      if(generation!==authGeneration)throw aborted();
      return payload;
    }finally{if(generation===authGeneration)authController=null;}
  }
  function signout(){
    if(logoutRequest)return logoutRequest;
    cancelAuthentication();activeSession=null;pendingLogout=true;persistentLogout=false;
    try{storage?.setItem(PENDING_LOGOUT_KEY,'1');persistentLogout=storage?.getItem(PENDING_LOGOUT_KEY)==='1';}catch{}
    logoutRequest=request('/auth/signout',{method:'POST',body:{}}).then(result=>{
      pendingLogout=false;persistentLogout=false;
      try{storage?.removeItem(PENDING_LOGOUT_KEY);}catch{}
      return result;
    }).finally(()=>{logoutRequest=null;});
    return logoutRequest;
  }
  return {
    config:()=>request('/config'),
    session:()=>!logoutState().pending&&activeSession?structuredClone(activeSession):null,
    logoutState,
    async restoreSession(){if(logoutState().pending){await signout();return null;}const generation=authGeneration,controller=new AbortController();restoreController?.abort();restoreController=controller;try{const payload=await request('/auth/session',{signal:controller.signal});if(generation===authGeneration&&!logoutState().pending)activeSession=normalizeSession(payload.session);return activeSession?structuredClone(activeSession):null;}catch(error){if(generation!==authGeneration&&error.code==='REQUEST_ABORTED')return activeSession?structuredClone(activeSession):null;throw error;}finally{if(restoreController===controller)restoreController=null;}},
    cancelAuthentication,
    signup:(email,password)=>authenticate('/auth/signup',email,password),
    signin:(email,password)=>authenticate('/auth/signin',email,password),
    signout,
    recover:email=>recoveryRequest('/auth/recover',{email}),
    confirmRecovery:(email,code,password)=>recoveryRequest('/auth/confirm',{email,code,password}),
    verifySignup:(email,code)=>recoveryRequest('/auth/verify',{email,code}),
    resendSignupConfirmation:email=>recoveryRequest('/auth/resend',{email}),
    updatePassword:(password,accessToken)=>request('/auth/password',{method:'POST',body:{password},authenticated:accessToken===undefined,accessToken}),
    portfolio:()=>request('/portfolio',{authenticated:true}),
    async history(portfolioId,{before=null,limit=100,status=null,signal}={}){
      if(typeof portfolioId!=='string'||!portfolioId.trim()||portfolioId.length>500||!Number.isInteger(limit)||limit<1||limit>100||(before!==null&&!validCursor(before))||(status!==null&&!['open','won','lost','void'].includes(status)))throw new ApiError('Choose a valid portfolio, history cursor, and page size up to 100.',{code:'INVALID_HISTORY'});
      const params=new URLSearchParams({portfolioId,limit:String(limit)});
      if(before!==null)params.set('before',before);
      if(status!==null)params.set('status',status);
      const payload=await request('/history?'+params,{authenticated:true,signal});
      try{
        if(!Array.isArray(payload.bets)||payload.bets.length>limit||(payload.nextCursor!==null&&!validCursor(payload.nextCursor)))throw new TypeError('Invalid history page.');
        return {bets:payload.bets.map(adaptBet),nextCursor:payload.nextCursor};
      }catch(cause){throw new ApiError('The bet history response is invalid. Please try again.',{code:'INVALID_RESPONSE',cause});}
    },
    newPortfolio:(name='My practice')=>request('/portfolios',{method:'POST',body:{name},authenticated:true}),
    markets:()=>request('/markets',{authenticated:true}),
    quote:(selectionIds,{signal}={})=>request('/quotes',{method:'POST',body:{selectionIds},authenticated:true,signal}),
    placeBet:(quoteId,stakeCents,requestId=globalThis.crypto.randomUUID())=>request('/bets',{method:'POST',body:{quoteId,stakeCents,requestId},authenticated:true}),
  };
}

function dollars(cents, { signed = false } = {}) {
  if (!Number.isSafeInteger(cents) || (!signed && cents < 0)) throw new TypeError('Portfolio currency must use valid integer cents.');
  return cents / 100;
}

const validCursor=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function adaptBet(bet) {
  if(!bet||typeof bet.id!=='string'||!Array.isArray(bet.selections)||bet.selections.length===0||!['open','won','lost','void'].includes(bet.status))throw new TypeError('The bet history response is invalid.');
  return {
    id:bet.id,
    selections:bet.selections.map(selection=>({
      ...selection,
      eventId:selection.eventId??selection.event_id,
      eventName:selection.eventName??selection.event_name??selection.eventId??selection.event_id,
      startsAt:selection.startsAt??selection.starts_at,
    })),
    stake:dollars(bet.stake_cents),
    odds:bet.odds,
    potentialPayout:dollars(bet.potential_payout_cents),
    payout:dollars(bet.payout_cents),
    status:bet.status,
    createdAt:bet.created_at,
    settledAt:bet.settled_at,
    type:bet.selections.length>1?'parlay':'single',
    mode:bet.selections.length>1?'parlay':'single',
  };
}
function adaptSummary(summary,portfolio) {
  const keys=['total_bets','open_bets','settled_bets','wins','losses','voids','amount_at_risk_cents','total_staked_cents','settled_staked_cents'];
  if(!summary||typeof summary!=='object'||Array.isArray(summary)||!keys.every(key=>Number.isSafeInteger(summary[key])&&summary[key]>=0))throw new TypeError('The portfolio summary must contain complete nonnegative integer counts and cents.');
  const add=(left,right)=>{const value=left+right;if(!Number.isSafeInteger(value))throw new TypeError('Portfolio summary arithmetic must use safe integer cents.');return value;};
  const decided=add(summary.wins,summary.losses);
  if(summary.total_bets!==add(summary.open_bets,summary.settled_bets)||summary.settled_bets!==add(decided,summary.voids)||summary.total_bets<portfolio.bets.length||summary.amount_at_risk_cents>summary.total_staked_cents||summary.settled_staked_cents>summary.total_staked_cents-summary.amount_at_risk_cents)throw new TypeError('The portfolio summary counts and stakes are inconsistent.');
  const bankroll=add(portfolio.balance_cents,summary.amount_at_risk_cents);
  const profit=add(bankroll,-portfolio.initial_bankroll_cents);
  return Object.freeze({
    bankroll:dollars(bankroll,{signed:true}),
    totalProfit:dollars(profit,{signed:true}),
    roi:summary.settled_staked_cents?profit/summary.settled_staked_cents*100:0,
    winRate:decided?summary.wins/decided*100:0,
    totalBets:summary.total_bets,
    openBets:summary.open_bets,
    amountAtRisk:dollars(summary.amount_at_risk_cents),
    totalStaked:dollars(summary.total_staked_cents),
    settledBets:summary.settled_bets,
    wins:summary.wins,losses:summary.losses,voids:summary.voids,
  });
}

/** Adapt database cents to the existing presentation model; persisted values stay integral. */
export function adaptPortfolio(portfolio) {
  if(!portfolio||typeof portfolio.id!=='string'||!Array.isArray(portfolio.bets)||!Array.isArray(portfolio.ledger))throw new TypeError('The portfolio response is invalid.');
  const historyNextCursor=portfolio.history_next_cursor??null;
  const ledgerSampled=portfolio.ledger_sampled===undefined?false:portfolio.ledger_sampled;
  const ledgerTotalPoints=portfolio.ledger_total_points===undefined?portfolio.ledger.length:portfolio.ledger_total_points;
  if(historyNextCursor!==null&&!validCursor(historyNextCursor))throw new TypeError('The history cursor is invalid.');
  if(typeof ledgerSampled!=='boolean'||!Number.isSafeInteger(ledgerTotalPoints)||ledgerTotalPoints<portfolio.ledger.length)throw new TypeError('The ledger sampling metadata is invalid.');
  return {
    version:1,
    id:portfolio.id,
    portfolioId:portfolio.id,
    initialBankroll:dollars(portfolio.initial_bankroll_cents),
    balance:dollars(portfolio.balance_cents,{signed:true}),
    bets:portfolio.bets.map(adaptBet),
    ledger:portfolio.ledger.map(entry=>({
      id:entry.id,
      type:entry.type,
      amount:dollars(entry.amount_cents,{signed:true}),
      balance:dollars(entry.balance_cents,{signed:true}),
      bankroll:dollars(entry.bankroll_cents,{signed:true}),
      at:entry.created_at,
      createdAt:entry.created_at,
      betId:entry.bet_id,
    })),
    ...(portfolio.summary!==undefined?{accountSummary:adaptSummary(portfolio.summary,portfolio)}:{}),
    historyNextCursor,ledgerSampled,ledgerTotalPoints,
  };
}
