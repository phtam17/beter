import {createBrowserSessionHandler} from './browser-session.ts';
import {evaluateReadiness} from './operations.ts';
export type Backend = {
  authenticate(token: string): Promise<{ id: string; email?: string }>;
  auth(action: string, body: Record<string, unknown>, token?: string): Promise<unknown>;
  rpc(name: string, args?: Record<string, unknown>, token?: string): Promise<any>;
};
export type ApiOptions = {
  backend: Backend;
  config: { mode: string; dataMode: string; liveOddsConfigured: boolean; [key: string]: unknown };
  jobSecret?: string;
  runJobs?: () => Promise<unknown>;
  allowedOrigins?: string[];
  authLimit?: (request:Request,action:string,email:string)=>Promise<{allowed:boolean;retryAfterSeconds?:number}>;
  onDiagnostic?: (entry:Record<string,unknown>)=>void;
};
export class ApiFault extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status=status; this.code=code; }
}
const json = (data: unknown, status=200, origin?: string) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(origin?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{}) },
});
function publicError(error: unknown): ApiFault {
  if(error instanceof ApiFault)return error;
  const candidate=error as {status?:number;code?:string;message?:string};
  const message=String(candidate?.message||'');
  if(/BETER_RATE_LIMITED/.test(message))return new ApiFault(429,'RATE_LIMITED','Too many requests. Wait a moment, then try again.');
  if(candidate?.status===401||/auth_required|authentication required|sign in|not authenticated|jwt/i.test(message))return new ApiFault(401,'AUTH_REQUIRED','Sign in to continue.');
  if(/insufficient|exceeds.*balance/i.test(message))return new ApiFault(409,'INSUFFICIENT_FUNDS','Your stake exceeds your available virtual balance.');
  if(/quote.*expir|expired.*quote/i.test(message))return new ApiFault(409,'QUOTE_EXPIRED','This quote expired. Review the latest odds and quote again.');
  if(/changed|quote.*price|price.*quote/i.test(message))return new ApiFault(409,'ODDS_CHANGED','The odds changed. Review the new price before placing your bet.');
  if(/stale|unavailable|closed|started|start time|cutoff|suspend/i.test(message))return new ApiFault(409,'MARKET_UNAVAILABLE','This market is temporarily unavailable or has reached its start cutoff.');
  if(/idempot|request.*reuse|request.*different/i.test(message))return new ApiFault(409,'REQUEST_CONFLICT','This request was already used for a different bet.');
  if(/invalid|positive|stake|selection|quote not found|quote.*owner/i.test(message))return new ApiFault(400,'INVALID_REQUEST','Check the selection and stake, then try again.');
  return new ApiFault(500,'SERVER_ERROR','The request could not be completed. Please try again.');
}
async function readBody(request: Request,maxBytes=32768): Promise<Record<string,unknown>> {
  const reader=request.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  if(reader){while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>maxBytes){await reader.cancel();throw new ApiFault(413,'BODY_TOO_LARGE','The request is too large.');}chunks.push(next.value);}}
  try {const body=JSON.parse(chunks.length?new TextDecoder().decode(Uint8Array.from(chunks.flatMap(c=>[...c]))):'{}');if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();return body;}
  catch {throw new ApiFault(400,'INVALID_JSON','Send a valid JSON object.');}
}
export function createApiHandler(options: ApiOptions) {
  const handle=createBrowserSessionHandler({handle:createBearerHandler(options),backend:options.backend,secret:String(options.config.sessionSecret||'')});
  return async(request:Request)=>{
    const headers=new Headers(request.headers);const requestId=crypto.randomUUID();headers.set('X-Beter-Request-ID',requestId);
    const response=await handle(new Request(request,{headers}));const output=new Headers(response.headers);output.set('X-Request-ID',requestId);
    if(response.status===429&&!output.has('Retry-After'))output.set('Retry-After','60');
    return new Response(response.body,{status:response.status,headers:output});
  };
}
function createBearerHandler(options: ApiOptions) {
  const {backend,config,jobSecret='',runJobs,allowedOrigins=[]}=options;
  return async function handle(request: Request): Promise<Response> {
    let responseOrigin: string|undefined;
    try {
      const url=new URL(request.url);
      const origin=request.headers.get('Origin');
      if(origin&&origin!==url.origin){if(!allowedOrigins.includes(origin))throw new ApiFault(403,'ORIGIN_DENIED','This website is not allowed to call the API.');responseOrigin=origin;}
      if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...(responseOrigin?{'Access-Control-Allow-Origin':responseOrigin,'Vary':'Origin'}:{}),'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'600'}});
      const path=url.pathname.replace(/^.*\/api(?=\/|$)/,'').replace(/\/$/,'')||'/';
      const token=request.headers.get('Authorization')?.replace(/^Bearer\s+/i,'')||'';
      const method=request.method;
      if(path==='/config'&&method==='GET')return json({mode:config.mode,dataMode:config.dataMode,liveOddsConfigured:config.liveOddsConfigured,accountEnabled:config.mode!=='unconfigured',supportedMarkets:['Moneyline'],supportedSports:config.supportedSports||['NBA','NFL','NHL'],quoteTtlSeconds:30,bettingCutoffSeconds:60,supportUrl:config.supportUrl||'',privacyUrl:config.privacyUrl||'',accountDeletionUrl:config.accountDeletionUrl||''},200,responseOrigin);
      if(path==='/health'&&method==='GET')return json({ok:true,service:'beter-api'},200,responseOrigin);
      if(['/jobs/process','/health/details','/ready','/ops/resolve','/ops/resume','/ops/maintenance'].includes(path)){
        if(!jobSecret)throw new ApiFault(503,'JOBS_UNCONFIGURED','Background processing is not configured.');
        if(token!==jobSecret)throw new ApiFault(403,'FORBIDDEN','A worker credential is required.');
        if(path==='/health/details'&&method==='GET')return json(await backend.rpc('beter_health',{},'$service'),200,responseOrigin);
        if(path==='/jobs/process'&&method==='POST')return json(await runJobs?.(),200,responseOrigin);
        if(path==='/ready'&&method==='GET'){
          let health:any;
          try{health=await backend.rpc('beter_health',{},'$service');}catch{return json({ready:false,checks:[{name:'database',ok:false,code:'BACKEND_UNAVAILABLE'}]},503,responseOrigin);}
          const result=evaluateReadiness(health);
          const checks=[...result.checks,{name:'schema',ok:Number(health?.schema_version)>=4,code:'SCHEMA_REQUIRED'},
            {name:'configuration',ok:config.mode!=='unconfigured'&&(config.dataMode!=='live'||config.liveOddsConfigured),code:'CONFIGURATION_REQUIRED'},
            {name:'account_support',ok:!config.production||config.environment==='staging'||Boolean(config.supportUrl&&config.privacyUrl&&config.accountDeletionUrl),code:'ACCOUNT_DESTINATIONS_REQUIRED'}];
          const ready=checks.every(check=>check.ok);return json({ready,checks},ready?200:503,responseOrigin);
        }
        if(path.startsWith('/ops/')&&method==='POST'){
          const body=await readBody(request,path==='/ops/resolve'?1048576:32768);
          if(path==='/ops/maintenance'){
            const batch=body.batchSize??1000;if(!Number.isInteger(batch)||Number(batch)<1||Number(batch)>1000)throw new ApiFault(400,'INVALID_BATCH','Choose a batch size from 1 to 1000.');
            return json(await backend.rpc('beter_maintenance',{p_batch_size:batch},'$service'),200,responseOrigin);
          }
          if(typeof body.eventId!=='string'||!body.eventId.trim()||body.eventId.length>500||typeof body.operator!=='string'||body.operator.trim().length<2||body.operator.length>80||typeof body.reason!=='string'||body.reason.trim().length<10||body.reason.length>1000)throw new ApiFault(400,'INVALID_REVIEW','Provide the event, operator, and a clear review reason.');
          const args={p_event_id:body.eventId,p_operator:body.operator.trim(),p_reason:body.reason.trim()};
          if(path==='/ops/resume')return json(await backend.rpc('beter_resume_event',args,'$service'),200,responseOrigin);
          if(typeof body.resultVersion!=='string'||!body.resultVersion.trim()||body.resultVersion.length>128||!body.evidence||typeof body.evidence!=='object'||Array.isArray(body.evidence)||!Array.isArray(body.outcomes)||body.outcomes.length<1||body.outcomes.length>10000||!body.outcomes.every((outcome:any)=>outcome&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(outcome.bet_id)&&['won','lost','void'].includes(outcome.status)))throw new ApiFault(400,'INVALID_REVIEW','Provide verified result evidence, a version, and valid bet outcomes.');
          return json(await backend.rpc('beter_resolve_event',{...args,p_outcomes:body.outcomes.map((outcome:any)=>({bet_id:outcome.bet_id,status:outcome.status})),p_result_version:body.resultVersion,p_evidence:body.evidence},'$service'),200,responseOrigin);
        }
        throw new ApiFault(405,'METHOD_NOT_ALLOWED','This method is not supported.');
      }
      if(path.startsWith('/auth/')&&method==='POST'){
        const action=path.slice(6);if(!['signup','signin','refresh','signout','recover','confirm','password'].includes(action))throw new ApiFault(404,'NOT_FOUND','This endpoint does not exist.');
        const body=await readBody(request);
        if(action==='password'){
          if(!token)throw new ApiFault(401,'AUTH_REQUIRED','A valid recovery or account session is required.');
          await backend.authenticate(token);
          if(typeof body.password!=='string'||body.password.length<10||body.password.length>200)throw new ApiFault(400,'INVALID_PASSWORD','Use a password with 10 to 200 characters.');
        }
        if(['signup','signin','recover','confirm'].includes(action)){
          if(typeof body.email!=='string'||body.email.length>254||!/^\S+@\S+\.\S+$/.test(body.email))throw new ApiFault(400,'INVALID_EMAIL','Enter a valid email address.');
          body.email=body.email.trim().toLowerCase();
          if(action==='confirm'&&(typeof body.code!=='string'||!/^\d{6}$/.test(body.code)))throw new ApiFault(400,'INVALID_CODE','Enter the six-digit verification code from your email.');
          if(action!=='recover'&&(typeof body.password!=='string'||body.password.length<10||body.password.length>200))throw new ApiFault(400,'INVALID_PASSWORD','Use a password with 10 to 200 characters.');
          if(options.authLimit){
            let limit;try{limit=await options.authLimit(request,action,String(body.email));}catch{throw new ApiFault(503,'LIMITS_UNAVAILABLE','Sign-in protection is temporarily unavailable. Please try again.');}
            if(!limit.allowed){const response=json({error:{code:'RATE_LIMITED',message:'Too many attempts. Please wait before trying again.'}},429,responseOrigin);response.headers.set('Retry-After',String(limit.retryAfterSeconds||60));return response;}
          }
        }
        if(action==='refresh'&&(typeof body.refresh_token!=='string'||!body.refresh_token||body.refresh_token.length>8192))throw new ApiFault(400,'INVALID_SESSION','A refresh token is required.');
        return json(await backend.auth(action,body,token),action==='signup'?201:200,responseOrigin);
      }
      if(path==='/markets'&&method==='GET')return json({events:await backend.rpc('beter_markets',{},'')},200,responseOrigin);
      const known=['/portfolio','/portfolios','/quotes','/bets','/history'];
      if(!known.includes(path))throw new ApiFault(404,'NOT_FOUND','This endpoint does not exist.');
      if(!token)throw new ApiFault(401,'AUTH_REQUIRED','Sign in to continue.');
      await backend.authenticate(token);
      if(['/quotes','/bets'].includes(path)&&config.dataMode==='live'&&!config.liveOddsConfigured)throw new ApiFault(503,'ODDS_UNCONFIGURED','Live betting is paused until the odds provider is configured.');
      if(path==='/portfolio'&&method==='GET')return json(await backend.rpc('beter_portfolio',{},token),200,responseOrigin);
      if(path==='/history'&&method==='GET'){
        const id=url.searchParams.get('portfolioId'),before=url.searchParams.get('before'),status=url.searchParams.get('status'),limit=Number(url.searchParams.get('limit')||50);
        if(!id||!/^[0-9a-f-]{36}$/i.test(id)||!Number.isInteger(limit)||limit<1||limit>100||(before&&!/^[0-9a-f-]{36}$/i.test(before))||(status&&!['open','won','lost','void'].includes(status)))throw new ApiFault(400,'INVALID_HISTORY','Choose a valid portfolio, result filter, cursor, and page size up to 100.');
        return json(await backend.rpc('beter_history',{p_portfolio_id:id,p_before:before||null,p_limit:limit,p_status:status||null},token),200,responseOrigin);
      }
      if(method!=='POST')throw new ApiFault(405,'METHOD_NOT_ALLOWED','This method is not supported.');
      const body=await readBody(request);
      if(path==='/portfolios'){
        if(body.name!==undefined&&(typeof body.name!=='string'||body.name.trim().length<1||body.name.length>80))throw new ApiFault(400,'INVALID_NAME','Use a portfolio name with 1 to 80 characters.');
        return json(await backend.rpc('beter_create_portfolio',{p_name:body.name||'My practice'},token),201,responseOrigin);
      }
      if(path==='/quotes'){
        if(!Array.isArray(body.selectionIds)||body.selectionIds.length!==1||typeof body.selectionIds[0]!=='string'||!body.selectionIds[0]||body.selectionIds[0].length>500)throw new ApiFault(400,'INVALID_SELECTIONS','Choose one moneyline selection for the connected beta.');
        return json(await backend.rpc('beter_quote',{p_selection_ids:body.selectionIds},token),201,responseOrigin);
      }
      if(path==='/bets'){
        if(typeof body.stakeCents!=='number'||!Number.isSafeInteger(body.stakeCents)||body.stakeCents<=0||body.stakeCents>1000000000)throw new ApiFault(400,'INVALID_STAKE','Enter a positive stake in whole cents.');
        if(typeof body.quoteId!=='string'||!body.quoteId||body.quoteId.length>100||typeof body.requestId!=='string'||body.requestId.length<6||body.requestId.length>120)throw new ApiFault(400,'INVALID_BET','A quote and unique request ID are required.');
        return json(await backend.rpc('beter_place_bet',{p_quote_id:body.quoteId,p_stake_cents:body.stakeCents,p_request_id:body.requestId},token),201,responseOrigin);
      }
      throw new ApiFault(405,'METHOD_NOT_ALLOWED','This method is not supported.');
    }catch(error){
      const safe=publicError(error);
      if(safe.status>=500){
        const pathname=new URL(request.url).pathname;const route=['portfolio','portfolios','quotes','bets','history','auth','jobs','health','ready','ops'].find(value=>pathname.includes('/api/'+value))||'unknown';
        const entry={event:'beter_api_failure',requestId:request.headers.get('X-Beter-Request-ID'),route,method:request.method,status:safe.status,code:safe.code};
        try{if(options.onDiagnostic)options.onDiagnostic(entry);else console.error(JSON.stringify(entry));}catch{/* Diagnostics must not interrupt the response. */}
      }
      return json({error:{code:safe.code,message:safe.message}},safe.status,responseOrigin);
    }
  };
}
