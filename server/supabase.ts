import { ApiFault, type Backend } from './api.ts';
type Options={url:string;anonKey:string;serviceRoleKey:string;siteUrl?:string;fetchImpl?:typeof fetch};
export function createSupabaseBackend({url,anonKey,serviceRoleKey,siteUrl='',fetchImpl=fetch}:Options):Backend {
  if(!url||!anonKey||!serviceRoleKey)throw new ApiFault(503,'BACKEND_UNCONFIGURED','Supabase is not configured.');
  const origin=new URL(url).origin;
  if(!origin.startsWith('https://')&&!/^http:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(origin))throw new ApiFault(503,'BACKEND_UNCONFIGURED','Use a secure Supabase configuration.');
  async function invoke(path:string,body:unknown,token:string,privileged=false,method='POST') {
    let response:Response;
    try {response=await fetchImpl(origin+path,{method,headers:{apikey:privileged?serviceRoleKey:anonKey,Authorization:'Bearer '+(privileged?serviceRoleKey:token||anonKey),'Content-Type':'application/json'},...(method!=='GET'?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});}
    catch {throw new ApiFault(503,'BACKEND_UNAVAILABLE','The account service is temporarily unavailable.');}
    let data:any;
    try{const text=await response.text();data=text?JSON.parse(text):{};}catch{throw new ApiFault(503,'BACKEND_UNAVAILABLE','The request could not be completed by the account service.');}
    if(!response.ok){
      if(path.startsWith('/auth/'))throw new ApiFault(response.status===429?429:401,response.status===429?'RATE_LIMITED':'AUTH_FAILED',response.status===429?'Too many attempts. Please wait before trying again.':'Sign in failed. Check your details or confirm your email.');
      // Database functions intentionally raise short business reasons; API boundary filters them.
      throw Object.assign(new Error(String(data.message||'Backend request failed.')),{code:data.code,status:response.status});
    }
    return data;
  }
  return {
    async authenticate(token){const user=await invoke('/auth/v1/user',undefined,token,false,'GET');if(typeof user.id!=='string')throw new ApiFault(401,'AUTH_REQUIRED','Sign in to continue.');return{id:user.id,email:user.email};},
    async rpc(name,args={},token=''){if(!/^beter_[a-z_]+$/.test(name))throw new ApiFault(400,'INVALID_RPC','Invalid operation.');return invoke('/rest/v1/rpc/'+name,args,token,token==='$service');},
    async auth(action,body,token=''){
      if(action==='password'){await invoke('/auth/v1/user',{password:body.password},token,false,'PUT');return{ok:true};}
      if(action==='signout'){await invoke('/auth/v1/logout',{},token);return{ok:true};}
      if(action==='recover'){const suffix=siteUrl?'?redirect_to='+encodeURIComponent(new URL('/#account-recovery',siteUrl).href):'';await invoke('/auth/v1/recover'+suffix,{email:body.email},'');return{message:'If an account exists, a recovery link will be sent.'};}
      const path=action==='signup'?'/auth/v1/signup':`/auth/v1/token?grant_type=${action==='refresh'?'refresh_token':'password'}`;
      const payload=action==='refresh'?{refresh_token:body.refresh_token}:{email:body.email,password:body.password};
      const data=await invoke(path,payload,'');
      const session=data.access_token?{access_token:data.access_token,refresh_token:data.refresh_token,expires_at:data.expires_at||Math.floor(Date.now()/1000)+(data.expires_in||3600),user:data.user}:null;
      return{session,user:data.user,requiresConfirmation:!session&&action==='signup'};
    },
  };
}
