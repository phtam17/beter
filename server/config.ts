export function readSettings(env:Record<string,string|undefined>={}) {
  const production=env.NODE_ENV==='production'||env.VERCEL==='1'||env.BETER_BACKEND==='aws';
  const environment=env.BETER_ENVIRONMENT||(env.VERCEL_ENV==='preview'?'staging':production?'production':'development');
  if(!['development','staging','production'].includes(environment))throw new Error('Choose a valid BETER_ENVIRONMENT.');
  const hasAnySupabase=Boolean(env.SUPABASE_URL||env.SUPABASE_ANON_KEY||env.SUPABASE_SERVICE_ROLE_KEY);
  const supabaseConfigured=Boolean(env.SUPABASE_URL&&env.SUPABASE_ANON_KEY&&env.SUPABASE_SERVICE_ROLE_KEY);
  if(env.BETER_BACKEND&&!['aws','supabase','local'].includes(env.BETER_BACKEND))throw new Error('Choose a valid BETER_BACKEND.');
  const aws=env.BETER_BACKEND==='aws';
  const mode=aws?'aws':env.BETER_BACKEND==='local'&&!production?'local':supabaseConfigured?'supabase':production||hasAnySupabase||env.BETER_BACKEND==='supabase'?'unconfigured':'local';
  const dataMode=env.BETER_DATA_MODE||(mode==='local'?'sample':'live');
  if(!['sample','live'].includes(dataMode))throw new Error('BETER_DATA_MODE must select a valid data mode: sample or live.');
  const fixedSample=aws&&env.BETER_ENVIRONMENT==='staging'&&dataMode==='sample';
  const hasSampleSchedule=env.BETER_SAMPLE_START_AT!==undefined||env.BETER_SAMPLE_DURATION_SECONDS!==undefined||env.BETER_SAMPLE_REPEAT_SECONDS!==undefined;
  if(hasSampleSchedule&&!fixedSample)throw new Error('Sample schedule overrides require explicit AWS staging sample mode.');
  let sampleStartsAt='';let sampleDurationMs=10_800_000;let sampleRepeatMs:number|undefined;
  if(fixedSample){
    const start=env.BETER_SAMPLE_START_AT||'';const timestamp=Date.parse(start);
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(start)||!Number.isFinite(timestamp)||new Date(timestamp).toISOString().slice(0,19)!==start.slice(0,19))throw new Error('AWS sample start requires a valid UTC ISO timestamp in BETER_SAMPLE_START_AT.');
    sampleStartsAt=new Date(timestamp).toISOString();
    const duration=env.BETER_SAMPLE_DURATION_SECONDS??'10800';
    if(!/^\d+$/.test(duration)||Number(duration)<60||Number(duration)>10800)throw new Error('AWS sample duration must contain an integer from 60 to 10800 seconds.');
    sampleDurationMs=Number(duration)*1000;
    if(env.BETER_SAMPLE_REPEAT_SECONDS!==undefined){
      const repeat=env.BETER_SAMPLE_REPEAT_SECONDS;
      if(!/^\d+$/.test(repeat)||Number(repeat)<600||Number(repeat)>86400||Number(repeat)*1000<sampleDurationMs+60_000)throw new Error('AWS sample repeat must be an integer from 600 to 86400 seconds and at least duration plus 60 seconds.');
      sampleRepeatMs=Number(repeat)*1000;
    }
  }
  if(production&&env.JOB_SECRET&&env.JOB_SECRET.length<32)throw new Error('The production job secret must contain at least 32 characters.');
  const siteUrl=env.SITE_URL||'http://127.0.0.1:4173';
  function safeUrl(value:string|undefined,label:string,originOnly=false){
    if(!value)return '';
    let parsed:URL;try{parsed=new URL(value);}catch{throw new Error(`${label} must be a valid HTTPS URL.`);}
    const local=!production&&!aws&&['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)&&parsed.protocol==='http:';
    if((parsed.protocol!=='https:'&&!local)||parsed.username||parsed.password||(originOnly&&(parsed.pathname!=='/'||parsed.search||parsed.hash)))throw new Error(`${label} must be a secure HTTPS ${originOnly?'origin':'URL'} without credentials.`);
    return originOnly?parsed.origin:parsed.href;
  }
  if(aws){
    const region=env.AWS_REGION||'';
    if(!/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(region))throw new Error('AWS configuration requires a valid AWS_REGION.');
    const resource=env.BETER_DATABASE_RESOURCE_ARN?.match(/^arn:(aws|aws-us-gov|aws-cn):rds:([a-z0-9-]+):(\d{12}):cluster:[A-Za-z0-9-]+$/);
    if(!resource||resource[2]!==region)throw new Error('AWS configuration requires a database cluster ARN in AWS_REGION.');
    if(env.BETER_SUPPORT_TOPIC_ARN){const topic=env.BETER_SUPPORT_TOPIC_ARN.match(/^arn:(aws|aws-us-gov|aws-cn):sns:([a-z0-9-]+):(\d{12}):[A-Za-z0-9_.-]+$/);if(!topic||topic[1]!==resource[1]||topic[2]!==region||topic[3]!==resource[3])throw new Error('AWS support requires an operator notification topic in the application account and region.');}
    for(const key of ['BETER_DATABASE_SECRET_ARN','BETER_RUNTIME_SECRET_ARN']){
      const arn=env[key]?.match(/^arn:(aws|aws-us-gov|aws-cn):secretsmanager:([a-z0-9-]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+$/);
      if(!arn||arn[1]!==resource[1]||arn[2]!==region||arn[3]!==resource[3])throw new Error('AWS configuration requires private secret ARNs in the database account and region.');
    }
    if(!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(env.BETER_DATABASE_NAME||''))throw new Error('AWS configuration requires a valid database name.');
    if(!/^[a-z0-9]{1,128}$/.test(env.BETER_COGNITO_CLIENT_ID||'')||!env.BETER_COGNITO_USER_POOL_ID?.startsWith(region+'_')||!new RegExp('^'+region+'_[A-Za-z0-9]+$').test(env.BETER_COGNITO_USER_POOL_ID))throw new Error('AWS configuration requires a valid Cognito client and user pool in AWS_REGION.');
    for(const key of ['BETER_SESSION_SECRET','JOB_SECRET','BETER_ORIGIN_SECRET'])if(!env[key]||env[key]!.length<32||env[key]!.length>4096||/\s/.test(env[key]!))throw new Error('AWS private secrets must contain 32 to 4096 characters without whitespace.');
    if(!env.SITE_URL)throw new Error('AWS configuration requires the actual HTTPS SITE_URL.');
    safeUrl(siteUrl,'AWS site origin',true);
    if(dataMode==='sample'&&env.BETER_ENVIRONMENT!=='staging')throw new Error('AWS sample data requires an explicit staging environment.');
    if(dataMode==='live'&&!env.ODDS_API_KEY)throw new Error('AWS live data requires a configured odds provider key.');
  }
  if(production){
    if(!aws&&!supabaseConfigured)throw new Error('Production requires complete Supabase configuration.');
    if(!env.JOB_SECRET)throw new Error('Production requires a configured JOB_SECRET.');
    if(!env.SITE_URL)throw new Error('Production requires the actual HTTPS SITE_URL.');
    if(!aws)safeUrl(env.SUPABASE_URL,'Production Supabase URL',true);
    safeUrl(siteUrl,'Production site origin',true);
    if(dataMode==='sample'&&environment!=='staging')throw new Error('Hosted sample data requires an explicit staging environment.');
    if(dataMode==='live'&&!env.ODDS_API_KEY)throw new Error('Production live data requires a configured odds provider key.');
    if((env.BETER_SESSION_SECRET||env.SUPABASE_SERVICE_ROLE_KEY||'').length<32)throw new Error('The production session secret must contain at least 32 characters.');
  }
  const allowedOrigins=(env.ALLOWED_ORIGINS||env.SITE_URL||'').split(',').map(x=>x.trim()).filter(Boolean).map(value=>safeUrl(value,'Allowed origin',true));
  return {mode,dataMode,production,environment,supabaseConfigured,liveOddsConfigured:Boolean(env.ODDS_API_KEY),sampleStartsAt,sampleDurationMs,sampleRepeatMs,
    jobSecret:env.JOB_SECRET||'',sessionSecret:env.BETER_SESSION_SECRET||env.SUPABASE_SERVICE_ROLE_KEY||'',supabaseUrl:env.SUPABASE_URL||'',supabaseAnonKey:env.SUPABASE_ANON_KEY||'',supabaseServiceKey:env.SUPABASE_SERVICE_ROLE_KEY||'',
    oddsApiKey:env.ODDS_API_KEY||'',bookmaker:env.ODDS_BOOKMAKER||'draftkings',siteUrl,
    supportTopicArn:env.BETER_SUPPORT_TOPIC_ARN||'',
    supportUrl:safeUrl(env.BETER_SUPPORT_URL||(aws&&env.BETER_SUPPORT_TOPIC_ARN?siteUrl+'/support.html':''),'Support URL'),privacyUrl:safeUrl(env.BETER_PRIVACY_URL||(aws&&env.BETER_SUPPORT_TOPIC_ARN?siteUrl+'/privacy.html':''),'Privacy URL'),accountDeletionUrl:safeUrl(env.BETER_ACCOUNT_DELETION_URL||(aws&&env.BETER_SUPPORT_TOPIC_ARN?siteUrl+'/account-deletion.html':''),'Account deletion URL'),
    trustProxy:aws?'aws':env.VERCEL==='1'?'vercel':'none',
    awsRegion:env.AWS_REGION||'',databaseResourceArn:env.BETER_DATABASE_RESOURCE_ARN||'',databaseSecretArn:env.BETER_DATABASE_SECRET_ARN||'',databaseName:env.BETER_DATABASE_NAME||'',
    cognitoClientId:env.BETER_COGNITO_CLIENT_ID||'',cognitoUserPoolId:env.BETER_COGNITO_USER_POOL_ID||'',runtimeSecretArn:env.BETER_RUNTIME_SECRET_ARN||'',originSecret:env.BETER_ORIGIN_SECRET||'',
    dataDir:env.BETER_DATA_DIR||'.data/postgres',allowedOrigins,
  };
}
