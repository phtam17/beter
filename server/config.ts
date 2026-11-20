export function readSettings(env:Record<string,string|undefined>={}) {
  const production=env.NODE_ENV==='production'||env.VERCEL==='1';
  const environment=env.BETER_ENVIRONMENT||(env.VERCEL_ENV==='preview'?'staging':production?'production':'development');
  if(!['development','staging','production'].includes(environment))throw new Error('Choose a valid BETER_ENVIRONMENT.');
  const hasAnySupabase=Boolean(env.SUPABASE_URL||env.SUPABASE_ANON_KEY||env.SUPABASE_SERVICE_ROLE_KEY);
  const supabaseConfigured=Boolean(env.SUPABASE_URL&&env.SUPABASE_ANON_KEY&&env.SUPABASE_SERVICE_ROLE_KEY);
  const mode=supabaseConfigured?'supabase':production||hasAnySupabase?'unconfigured':'local';
  const dataMode=env.BETER_DATA_MODE||(mode==='local'?'sample':'live');
  if(!['sample','live'].includes(dataMode))throw new Error('BETER_DATA_MODE must select a valid data mode: sample or live.');
  if(production&&env.JOB_SECRET&&env.JOB_SECRET.length<32)throw new Error('The production job secret must contain at least 32 characters.');
  const siteUrl=env.SITE_URL||'http://127.0.0.1:4173';
  function safeUrl(value:string|undefined,label:string,originOnly=false){
    if(!value)return '';
    let parsed:URL;try{parsed=new URL(value);}catch{throw new Error(`${label} must be a valid HTTPS URL.`);}
    const local=!production&&['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)&&parsed.protocol==='http:';
    if((parsed.protocol!=='https:'&&!local)||parsed.username||parsed.password||(originOnly&&(parsed.pathname!=='/'||parsed.search||parsed.hash)))throw new Error(`${label} must be a secure HTTPS ${originOnly?'origin':'URL'} without credentials.`);
    return originOnly?parsed.origin:parsed.href;
  }
  if(production){
    if(!supabaseConfigured)throw new Error('Production requires complete Supabase configuration.');
    if(!env.JOB_SECRET)throw new Error('Production requires a configured JOB_SECRET.');
    if(!env.SITE_URL)throw new Error('Production requires the actual HTTPS SITE_URL.');
    safeUrl(env.SUPABASE_URL,'Production Supabase URL',true);
    safeUrl(siteUrl,'Production site origin',true);
    if(dataMode==='sample'&&environment!=='staging')throw new Error('Hosted sample data requires an explicit staging environment.');
    if(dataMode==='live'&&!env.ODDS_API_KEY)throw new Error('Production live data requires a configured odds provider key.');
    if((env.BETER_SESSION_SECRET||env.SUPABASE_SERVICE_ROLE_KEY||'').length<32)throw new Error('The production session secret must contain at least 32 characters.');
  }
  const allowedOrigins=(env.ALLOWED_ORIGINS||env.SITE_URL||'').split(',').map(x=>x.trim()).filter(Boolean).map(value=>safeUrl(value,'Allowed origin',true));
  return {mode,dataMode,production,environment,supabaseConfigured,liveOddsConfigured:Boolean(env.ODDS_API_KEY),
    jobSecret:env.JOB_SECRET||'',sessionSecret:env.BETER_SESSION_SECRET||env.SUPABASE_SERVICE_ROLE_KEY||'',supabaseUrl:env.SUPABASE_URL||'',supabaseAnonKey:env.SUPABASE_ANON_KEY||'',supabaseServiceKey:env.SUPABASE_SERVICE_ROLE_KEY||'',
    oddsApiKey:env.ODDS_API_KEY||'',bookmaker:env.ODDS_BOOKMAKER||'draftkings',siteUrl,
    supportUrl:safeUrl(env.BETER_SUPPORT_URL,'Support URL'),privacyUrl:safeUrl(env.BETER_PRIVACY_URL,'Privacy URL'),accountDeletionUrl:safeUrl(env.BETER_ACCOUNT_DELETION_URL,'Account deletion URL'),
    trustProxy:env.VERCEL==='1'?'vercel':'none',
    dataDir:env.BETER_DATA_DIR||'.data/postgres',allowedOrigins,
  };
}
