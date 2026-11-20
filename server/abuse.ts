import type {Backend} from './api.ts';
type Options={backend:Pick<Backend,'rpc'>;secret:string;trustProxy?:boolean|'aws'};
/** Limits are shared by instances; raw addresses and email never enter the quota table. */
export function createAuthLimiter({backend,secret,trustProxy=false}:Options){
  if(secret.length<32)throw new Error('Authentication protection requires a private secret.');
  const key=crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',await key,new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');
  return async(request:Request,action:string,email:string)=>{
    const buckets=[{kind:'global',key:await hash('global:auth')},{kind:action==='recover'?'recovery':'identity',key:await hash('identity:'+email.trim().toLowerCase())}];
    // AWS entry verifies the origin secret and replaces the private source header.
    // Vercel overwrites its own forwarding header; direct hosts trust neither.
    const source=trustProxy==='aws'?request.headers.get('x-beter-source-ip'):trustProxy===true?request.headers.get('x-forwarded-for')?.split(',')[0].trim():null;
    if(source&&source.length<=64&&/^[0-9a-f:.]+$/i.test(source))buckets.push({kind:'source',key:await hash('source:'+source)});
    const result=await backend.rpc('beter_auth_limit',{p_buckets:buckets},'$service');
    if(!result||typeof result.allowed!=='boolean'||!Number.isInteger(result.retry_after_seconds)||result.retry_after_seconds<0||result.retry_after_seconds>3600)throw new Error('Authentication protection returned invalid limits.');
    return {allowed:result.allowed,retryAfterSeconds:result.retry_after_seconds};
  };
}
