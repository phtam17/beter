import type {Backend} from './api.ts';

type User = {id:string;email?:string};
type Session = {access_token:string;refresh_token:string;expires_at:number;user:User};
const LIFETIME=30*86400;
const encoder=new TextEncoder();
const responseJson=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function normalize(value:unknown,fallback?:unknown):Session|null {
  const input=value as Partial<Session>|null,user=(input?.user||fallback) as User|undefined;
  if(!input||typeof input.access_token!=='string'||!input.access_token||input.access_token.length>8192||typeof input.refresh_token!=='string'||!input.refresh_token||input.refresh_token.length>8192||!Number.isFinite(input.expires_at)||!user||typeof user.id!=='string'||!user.id||user.id.length>200)return null;
  return {access_token:input.access_token,refresh_token:input.refresh_token,expires_at:input.expires_at!,user:{id:user.id,...(typeof user.email==='string'?{email:user.email.slice(0,254)}:{})}};
}
const publicSession=(session:Session)=>({user:session.user,expires_at:session.expires_at});
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const decode=(value:string)=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));

/** Browser transport keeps credentials in an authenticated HttpOnly envelope; bearer clients remain independent. */
export function createBrowserSessionHandler({handle,backend,secret}:{handle:(request:Request)=>Promise<Response>;backend:Backend;secret:string}) {
  const key=typeof secret==='string'&&secret.length>=32?crypto.subtle.digest('SHA-256',encoder.encode(`beter-browser-session-v1:${secret}`)).then(bytes=>crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt'])):null;
  const refreshes=new Map<string,{promise:Promise<Session>;expires:number}>();
  async function seal(session:Session) {
    if(!key)throw new Error('Session encryption is not configured.');
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const bytes=await crypto.subtle.encrypt({name:'AES-GCM',iv},await key,encoder.encode(JSON.stringify({v:1,expires:Date.now()+LIFETIME*1000,session})));
    const value=`v1.${encode(iv)}.${encode(new Uint8Array(bytes))}`;
    if(value.length>3800)throw new Error('The account session is too large.');
    return value;
  }
  async function open(value:string):Promise<Session|null> {
    try{
      if(!key||value.length>3800)return null;
      const [version,iv,data,...extra]=value.split('.');if(version!=='v1'||!iv||!data||extra.length)return null;
      const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(iv)},await key,decode(data));
      const payload=JSON.parse(new TextDecoder().decode(bytes));
      return payload.v===1&&Number.isFinite(payload.expires)&&payload.expires>Date.now()?normalize(payload.session):null;
    }catch{return null;}
  }
  function refresh(session:Session):Promise<Session> {
    const now=Date.now();
    for(const [token,entry] of refreshes)if(entry.expires<=now)refreshes.delete(token);
    let pending=refreshes.get(session.refresh_token);
    if(!pending){
      const promise=(async()=>{const result=await backend.auth('refresh',{refresh_token:session.refresh_token}) as {session?:unknown;user?:unknown};const renewed=normalize(result?.session,result?.user);if(!renewed)throw new Error('Authentication required');return renewed;})().catch(error=>{refreshes.delete(session.refresh_token);throw error;});
      pending={promise,expires:now+10000};refreshes.set(session.refresh_token,pending);
      if(refreshes.size>128)refreshes.delete(refreshes.keys().next().value!);
    }
    return pending.promise;
  }
  return async(request:Request):Promise<Response>=>{
    if(request.headers.get('X-Beter-Client')!=='browser')return handle(request);
    const url=new URL(request.url),origin=request.headers.get('Origin');
    if((origin&&origin!==url.origin)||(!['GET','HEAD'].includes(request.method)&&origin!==url.origin)||request.headers.get('Sec-Fetch-Site')==='cross-site')return responseJson({error:{code:'ORIGIN_DENIED',message:'This website is not allowed to call the account service.'}},403);
    const secure=url.protocol==='https:',local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(!secure&&!local)return responseJson({error:{code:'HTTPS_REQUIRED',message:'Use a secure connection to sign in.'}},503);
    const cookieName=secure?'__Host-beter-session':'beter-session-dev';
    const cookie=(value:string,age:number)=>`${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure?'; Secure':''}`;
    let setCookie:string|undefined;
    const finish=(response:Response)=>{if(!setCookie)return response;const headers=new Headers(response.headers);headers.set('Set-Cookie',setCookie);return new Response(response.body,{status:response.status,headers});};
    const path=url.pathname.replace(/^.*\/api(?=\/|$)/,'').replace(/\/$/,'')||'/';
    if(['/config','/health','/markets'].includes(path)&&request.method==='GET')return handle(request);
    const logout=path==='/auth/signout'&&request.method==='POST';
    try {
      const stored=(request.headers.get('Cookie')||'').split(';').map(item=>item.trim()).find(item=>item.startsWith(cookieName+'='))?.slice(cookieName.length+1);
      let session=stored?await open(stored):null;
      if(stored&&!session)setCookie=cookie('',0);
      if(path==='/auth/session'&&request.method==='GET'){
        if(session){try{if(session.expires_at*1000<=Date.now()+5000){session=await refresh(session);setCookie=cookie(await seal(session),LIFETIME);}session.user=await backend.authenticate(session.access_token);}catch{session=null;setCookie=cookie('',0);}}
        return finish(responseJson({session:session?publicSession(session):null}));
      }
      if(path==='/auth/refresh')return responseJson({error:{code:'INVALID_REQUEST',message:'Account sessions refresh automatically.'}},400);
      const authenticating=['/auth/signin','/auth/signup'].includes(path);
      if(authenticating&&!key)return responseJson({error:{code:'SESSION_UNCONFIGURED',message:'Account sessions are not configured.'}},503);
      if(session&&!authenticating&&session.expires_at*1000<=Date.now()+5000){try{session=await refresh(session);setCookie=cookie(await seal(session),LIFETIME);}catch{session=null;setCookie=cookie('',0);}}
      const headers=new Headers(request.headers);
      // Recovery credentials are intentionally supplied once and never placed in the persistent cookie.
      const recovery=path==='/auth/password'&&headers.has('Authorization');
      if(!recovery){headers.delete('Authorization');if(session)headers.set('Authorization',`Bearer ${session.access_token}`);}
      const retry=request.clone();
      let response=await handle(new Request(request,{headers}));
      if(response.status===401&&session&&!authenticating&&!logout&&!recovery){try{session=await refresh(session);setCookie=cookie(await seal(session),LIFETIME);headers.set('Authorization',`Bearer ${session.access_token}`);response=await handle(new Request(retry,{headers}));}catch{setCookie=cookie('',0);}}
      if(authenticating&&response.ok){
        const payload=await response.json() as {session?:unknown;user?:unknown;requiresConfirmation?:boolean;confirmationMethod?:unknown};
        const next=payload.session?normalize(payload.session,payload.user):null;
        if(payload.session&&!next)return responseJson({error:{code:'INVALID_RESPONSE',message:'The account service returned an invalid session.'}},502);
        if(next)setCookie=cookie(await seal(next),LIFETIME);
        return finish(responseJson({session:next?publicSession(next):null,...(payload.user?{user:next?.user||payload.user}:{}),...(payload.requiresConfirmation?{requiresConfirmation:true}:{}),...(payload.confirmationMethod==='code'?{confirmationMethod:'code'}:{})},response.status));
      }
      if(logout){setCookie=cookie('',0);return finish(responseJson({ok:true}));}
      return finish(response);
    }catch{
      if(logout){setCookie=cookie('',0);return finish(responseJson({ok:true}));}
      return finish(responseJson({error:{code:'ACCOUNT_UNAVAILABLE',message:'The account service is temporarily unavailable. Please try again.'}},503));
    }
  };
}
