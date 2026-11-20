import {GetSecretValueCommand,SecretsManagerClient} from '@aws-sdk/client-secrets-manager';
import {createOddsProvider} from '../server/provider.ts';

type Client={send(command:GetSecretValueCommand,options:{abortSignal:AbortSignal}):Promise<any>};
type Options={env:Record<string,string|undefined>;secretClient?:Client;fetchImpl?:(url:string|URL,init?:RequestInit)=>Promise<Response>;now?:()=>Date;timeoutMs?:number};
type Quota={remaining:number;used:number;lastCost:number};
type Code='FORBIDDEN'|'FUNDING_REVIEW_REQUIRED'|'PROBE_UNCONFIGURED'|'SECRET_INVALID'|'SECRET_UNAVAILABLE'|'NO_FUTURE_MONEYLINES'|'PROVIDER_INVALID_DATA'|'PROVIDER_RATE_LIMITED'|'PROVIDER_UNAVAILABLE'|'QUOTA_INVALID'|'PROBE_TIMEOUT';
const fail=(code:Code)=>({ok:false as const,code});
function quotaValue(value:string|null):number|null{
  if(value===null||!/^\d+$/.test(value))return null;
  const number=Number(value);return Number.isSafeInteger(number)?number:null;
}

/** Operator-only temporary Lambda: one live request, public counts only, no database imports or access. */
export function createProviderProbe({env,secretClient,fetchImpl=fetch,now=()=>new Date(),timeoutMs=14000}:Options){
  return async(event:unknown)=>{
    const input=event as {source?:unknown;task?:unknown;version?:unknown;requestContext?:unknown}|null;
    if(!input||input.source!=='beter.operator'||input.task!=='verify-provider'||input.version!==undefined||input.requestContext!==undefined)return fail('FORBIDDEN');
    let clock:Date;
    try{clock=now();}catch{return fail('FUNDING_REVIEW_REQUIRED');}
    const value=env.BETER_FUNDING_CUTOFF_AT,time=clock?.getTime();
    const cutoff=typeof value==='string'?Date.parse(value.endsWith('Z')?value:value+'Z'):NaN;
    if(!Number.isFinite(time)||!Number.isFinite(cutoff)||time>=cutoff)return fail('FUNDING_REVIEW_REQUIRED');
    const arn=env.BETER_PROVIDER_SECRET_ARN;
    if(typeof arn!=='string'||!/^arn:aws(?:-us-gov|-cn)?:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(arn)||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>15000)return fail('PROBE_UNCONFIGURED');
    const controller=new AbortController(),deadlineAt=Date.now()+timeoutMs;
    let ownedClient:SecretsManagerClient|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const deadline=new Promise<ReturnType<typeof fail>>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(fail('PROBE_TIMEOUT'));},timeoutMs);});
    const run=(async()=>{
      let stage:'secret'|'provider'='secret';
      try{
        const client=secretClient||(ownedClient=new SecretsManagerClient({region:arn.split(':')[3],maxAttempts:1}));
        const secret=await client.send(new GetSecretValueCommand({SecretId:arn}),{abortSignal:controller.signal});
        let payload:unknown;
        try{if(typeof secret?.SecretString!=='string'||secret.SecretString.length>4096)return fail('SECRET_INVALID');payload=JSON.parse(secret.SecretString);}catch{return fail('SECRET_INVALID');}
        const key=payload as {apiKey?:unknown}|null;
        if(!key||Array.isArray(key)||Object.keys(key).length!==1||typeof key.apiKey!=='string'||!key.apiKey.length||key.apiKey.length>256||/[^\x21-\x7e]/.test(key.apiKey))return fail('SECRET_INVALID');
        if(controller.signal.aborted)return fail('PROBE_TIMEOUT');
        stage='provider';let quota:Quota|null=null;
        const provider=createOddsProvider({apiKey:key.apiKey,bookmaker:'draftkings',now:()=>clock,timeoutMs:Math.max(1,deadlineAt-Date.now()),fetchImpl:async(url,init)=>{
          const signal=init?.signal?AbortSignal.any([init.signal,controller.signal]):controller.signal;
          const response=await fetchImpl(url,{...init,signal,redirect:'error'});
          const remaining=quotaValue(response.headers.get('x-requests-remaining')),used=quotaValue(response.headers.get('x-requests-used')),lastCost=quotaValue(response.headers.get('x-requests-last'));
          if(remaining!==null&&used!==null&&lastCost!==null)quota={remaining,used,lastCost};
          return response;
        }});
        const events=await provider.getEvents('basketball_nba');
        const eligible=events.filter(item=>item.status==='upcoming'&&Date.parse(item.starts_at)>time&&item.selections.some(selection=>selection.market==='Moneyline'));
        const moneylineSelections=eligible.reduce((count,item)=>count+item.selections.filter(selection=>selection.market==='Moneyline').length,0);
        if(!eligible.length||!moneylineSelections)return fail('NO_FUTURE_MONEYLINES');
        if(!quota)return fail('QUOTA_INVALID');
        return{ok:true as const,eventCount:eligible.length,moneylineSelections,quota,sample:false as const};
      }catch(error){
        if(controller.signal.aborted)return fail('PROBE_TIMEOUT');
        if(stage==='secret')return fail('SECRET_UNAVAILABLE');
        const code=(error as {code?:unknown})?.code;
        return fail(code==='provider_timeout'?'PROBE_TIMEOUT':code==='provider_invalid_data'?'PROVIDER_INVALID_DATA':code==='provider_rate_limited'?'PROVIDER_RATE_LIMITED':'PROVIDER_UNAVAILABLE');
      }
    })();
    try{return await Promise.race([run,deadline]);}
    finally{clearTimeout(timer);controller.abort();ownedClient?.destroy();}
  };
}

export const providerProbeHandler=createProviderProbe({env:process.env});
