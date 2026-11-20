import {createApiHandler,ApiFault,type Backend} from './api.ts';
import {readSettings} from './config.ts';
import {createSupabaseBackend} from './supabase.ts';
import {createOddsProvider,createSampleProvider,type OddsProvider} from './provider.ts';
import {runBackgroundJobs} from './jobs.ts';
import {createAuthLimiter} from './abuse.ts';
export async function createRuntime({env={},backend:injectedBackend,provider:injectedProvider}:{env?:Record<string,string|undefined>;backend?:Backend;provider?:OddsProvider}={}){
  if(env.BETER_BACKEND==='aws'){const {createAwsRuntime}=await import('./aws-runtime.ts');return createAwsRuntime({env,provider:injectedProvider});}
  const settings=readSettings(env);
  if(settings.mode==='local'&&!settings.sessionSecret){
    const {mkdir,readFile,writeFile}=await import('node:fs/promises');
    const {join}=await import('node:path');
    await mkdir(settings.dataDir,{recursive:true});
    const path=join(settings.dataDir,'.browser-session-key');
    try{settings.sessionSecret=await readFile(path,'utf8');}
    catch(error){if((error as {code?:string}).code!=='ENOENT')throw error;try{await writeFile(path,Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join(''),{flag:'wx',mode:0o600});}catch(error){if((error as {code?:string}).code!=='EEXIST')throw error;}settings.sessionSecret=await readFile(path,'utf8');}
  }
  let backend:Backend&{close?:()=>Promise<void>};
  if(injectedBackend)backend=injectedBackend;
  else if(settings.mode==='supabase')backend=createSupabaseBackend({url:settings.supabaseUrl,anonKey:settings.supabaseAnonKey,serviceRoleKey:settings.supabaseServiceKey,siteUrl:settings.siteUrl});
  else if(settings.mode==='local'){
    const {createLocalBackend}=await import('./local.ts');backend=await createLocalBackend({dataDir:settings.dataDir});
  }else{
    const unavailable=async():Promise<never>=>{throw new ApiFault(503,'BACKEND_UNCONFIGURED','Configure Supabase to enable saved accounts and markets.');};
    backend={authenticate:unavailable,auth:unavailable,rpc:unavailable};
  }
  const provider=injectedProvider||(settings.dataMode==='sample'?createSampleProvider():settings.liveOddsConfigured?createOddsProvider({apiKey:settings.oddsApiKey,bookmaker:settings.bookmaker}):null);
  let running:Promise<unknown>|null=null;
  const runJobs=async()=>{
    if(!provider)throw new ApiFault(503,'ODDS_UNCONFIGURED','An odds provider key must be configured before live processing.');
    if(!running)running=runBackgroundJobs({backend,provider}).finally(()=>{running=null;});
    return running;
  };
  const authLimit=settings.sessionSecret?createAuthLimiter({backend,secret:settings.sessionSecret,trustProxy:settings.trustProxy==='vercel'}):undefined;
  const handle=createApiHandler({backend,config:settings,jobSecret:settings.jobSecret,runJobs,allowedOrigins:settings.allowedOrigins,authLimit});
  return{handle,runJobs,backend,settings,close:async()=>{await running;await backend.close?.();}};
}
