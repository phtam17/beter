import {createApiHandler,ApiFault} from '../_shared/api.ts';
import {createSupabaseBackend} from '../_shared/supabase.ts';
import {createOddsProvider,createSampleProvider} from '../_shared/provider.ts';
import {runBackgroundJobs} from '../_shared/jobs.ts';
import {readSettings} from '../_shared/config.ts';
import {createAuthLimiter} from '../_shared/abuse.ts';
const env=Object.fromEntries(['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','BETER_SESSION_SECRET','ODDS_API_KEY','ODDS_BOOKMAKER','JOB_SECRET','SITE_URL','ALLOWED_ORIGINS','BETER_DATA_MODE','BETER_ENVIRONMENT','BETER_SUPPORT_URL','BETER_PRIVACY_URL','BETER_ACCOUNT_DELETION_URL'].map(key=>[key,Deno.env.get(key)]));
const settings=readSettings({...env,NODE_ENV:'production'});
const backend=createSupabaseBackend({url:settings.supabaseUrl,anonKey:settings.supabaseAnonKey,serviceRoleKey:settings.supabaseServiceKey,siteUrl:settings.siteUrl});
const provider=settings.dataMode==='sample'?createSampleProvider():settings.liveOddsConfigured?createOddsProvider({apiKey:settings.oddsApiKey,bookmaker:settings.bookmaker}):null;
Deno.serve(createApiHandler({backend,config:settings,allowedOrigins:settings.allowedOrigins,authLimit:createAuthLimiter({backend,secret:settings.sessionSecret}),jobSecret:settings.jobSecret,runJobs:async()=>{
  if(!provider)throw new ApiFault(503,'ODDS_UNCONFIGURED','Configure the odds provider key before starting live jobs.');
  return runBackgroundJobs({backend,provider});
}}));
