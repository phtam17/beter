import {readFile as readFileDefault} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const commands=['check','status','resolve','resume','maintenance'];
const jobNames=new Set(['pipeline','maintenance','settlement',...['basketball_nba','americanfootball_nfl','icehockey_nhl'].flatMap(sport=>['odds:'+sport,'results:'+sport])]);
const checkNames=new Set(['database','ledger','settlements','worker','ingestion','failures','reviews','schema','configuration','account_support']);
const checkCodes=new Set(['HEALTH_UNAVAILABLE','HEALTH_AVAILABLE','BACKEND_UNAVAILABLE','LEDGER_RECONCILED','LEDGER_MISMATCH','SETTLEMENTS_CURRENT','SETTLEMENTS_OVERDUE','WORKER_MISSING','WORKER_STALE','WORKER_FAILED','WORKER_CURRENT','FEEDS_CURRENT','FEEDS_UNAVAILABLE','NO_RECENT_FAILURES','RECENT_JOB_FAILURES','NO_UNRESOLVED_REVIEWS','UNRESOLVED_REVIEWS','SCHEMA_REQUIRED','CONFIGURATION_REQUIRED','ACCOUNT_DESTINATIONS_REQUIRED']);
const count=value=>Number.isSafeInteger(value)&&value>=0;
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Credentials come from environment settings; output is an allowlisted operational summary. */
export async function runOperatorCli(args,{env=process.env,fetchImpl=globalThis.fetch,readFile=readFileDefault,writeOutput=text=>process.stdout.write(text+'\n'),timeoutMs=15000}={}) {
  const output=value=>writeOutput(JSON.stringify(value));
  const command=args[0];
  if(command==='help'||command==='--help'){
    output({commands,configuration:['BETER_OPS_URL','JOB_SECRET'],usage:'check | status | resolve --file path | resume --file path | maintenance [--batch-size 1..1000]'});
    return 0;
  }
  let file,batchSize=1000;
  if(!commands.includes(command)){
    output({ok:false,code:'INVALID_ARGUMENTS',message:'Choose check, status, resolve, resume, or maintenance. Use --help for usage.'});return 2;
  }
  const invalidArguments=()=>{output({command,ok:false,code:'INVALID_ARGUMENTS',message:'Use --help for the supported arguments; credentials must be configured through the environment.'});return 2;};
  if(command==='resolve'||command==='resume'){
    if(args.length!==3||args[1]!=='--file'||typeof args[2]!=='string'||!args[2])return invalidArguments();
    file=args[2];
  }else if(command==='maintenance'&&args.length!==1){
    if(args.length!==3||args[1]!=='--batch-size'||!/^\d+$/.test(args[2]))return invalidArguments();
    batchSize=Number(args[2]);if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>1000)return invalidArguments();
  }else if(args.length!==1)return invalidArguments();
  let base;
  try{
    base=new URL(env.BETER_OPS_URL);
    const local=['localhost','127.0.0.1','[::1]'].includes(base.hostname);
    if((base.protocol!=='https:'&&!(base.protocol==='http:'&&local))||base.username||base.password||base.search||base.hash||!['','/'].includes(base.pathname)||typeof env.JOB_SECRET!=='string'||env.JOB_SECRET.length<32||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error();
  }catch{
    output({command,ok:false,code:'SETUP_REQUIRED',message:'Configure an HTTPS app origin and a worker secret of at least 32 characters. Loopback HTTP is allowed for local checks.'});return 2;
  }
  let body;
  if(file){
    try{
      const text=await readFile(file,'utf8');
      if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>1024*1024)throw new Error();
      body=JSON.parse(text);
      const allowed=new Set(command==='resolve'?['eventId','operator','reason','outcomes','resultVersion','evidence']:['eventId','operator','reason']);
      if(!object(body)||Object.keys(body).some(key=>!allowed.has(key))||typeof body.eventId!=='string'||!body.eventId.trim()||body.eventId.length>500||typeof body.operator!=='string'||body.operator.trim().length<2||body.operator.length>80||typeof body.reason!=='string'||body.reason.trim().length<10||body.reason.length>1000)throw new Error();
      if(command==='resolve'&&(typeof body.resultVersion!=='string'||!body.resultVersion.trim()||body.resultVersion.length>128||!object(body.evidence)||typeof body.evidence.source!=='string'||!body.evidence.source.trim()||!Number.isFinite(Date.parse(body.evidence.last_update||body.evidence.updated_at||''))||!Array.isArray(body.outcomes)||body.outcomes.length<1||body.outcomes.length>10000||!body.outcomes.every(outcome=>object(outcome)&&Object.keys(outcome).every(key=>['bet_id','status'].includes(key))&&uuid(outcome.bet_id)&&['won','lost','void'].includes(outcome.status))))throw new Error();
    }catch{
      output({command,ok:false,code:'INVALID_INPUT_FILE',message:'Provide a valid review JSON file within 1 MiB, with event, operator, reason, and verified result evidence where required.'});return 2;
    }
  }else if(command==='maintenance')body={batchSize};
  const route={check:'/ready',status:'/health/details',resolve:'/ops/resolve',resume:'/ops/resume',maintenance:'/ops/maintenance'}[command];
  const controller=new AbortController();
  let timer,timedOut=false;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;controller.abort();reject(new Error());},timeoutMs);});
  try{
    const work=(async()=>{
      const response=await fetchImpl(new URL('/api'+route,base).href,{method:body?'POST':'GET',headers:{Accept:'application/json',Authorization:'Bearer '+env.JOB_SECRET,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});
      if(!response.ok&&!(command==='check'&&response.status===503))return{failed:true,status:response.status};
      const payload=await response.json();
      return{response,payload};
    })();
    const result=await Promise.race([work,deadline]);
    if(result.failed){
      output({command,ok:false,code:result.status===401||result.status===403?'AUTHORIZATION_FAILED':'REQUEST_FAILED',status:result.status,message:'The operation was not completed. Check service configuration and private platform logs.'});return 1;
    }
    const {response,payload}=result;
    if(!object(payload))throw new Error();
    if(command==='check'){
      if(typeof payload.ready!=='boolean'||!Array.isArray(payload.checks)||payload.checks.length===0||!payload.checks.every(check=>object(check)&&checkNames.has(check.name)&&typeof check.ok==='boolean'&&checkCodes.has(check.code)))throw new Error();
      const checks=payload.checks.map(check=>({name:check.name,ok:check.ok,code:check.code,...(count(check.count)?{count:check.count}:{}),...(count(check.ageSeconds)?{ageSeconds:check.ageSeconds}:{})}));
      const ready=response.ok&&payload.ready&&checks.every(check=>check.ok);
      output({command,ok:ready,ready,checks});return ready?0:1;
    }
    if(command==='status'){
      if(!count(payload.schema_version)||!count(payload.ledger_mismatches)||!count(payload.open_bets)||!count(payload.unsettled_bets)||!Array.isArray(payload.jobs))throw new Error();
      const jobs=payload.jobs.filter(job=>object(job)&&jobNames.has(job.name)).map(job=>({name:job.name,ok:job.ok===true,...(Number.isFinite(Date.parse(job.created_at))?{createdAt:new Date(job.created_at).toISOString()}:{})}));
      output({command,ok:true,schemaVersion:payload.schema_version,ledgerMismatches:payload.ledger_mismatches,openBets:payload.open_bets,overdueBets:payload.unsettled_bets,operatorHolds:count(payload.operator_holds)?payload.operator_holds:0,pendingReviews:payload.jobs.filter(job=>typeof job?.name==='string'&&job.name.startsWith('review:')&&job.ok===false).length,jobs});return 0;
    }
    if(command==='resolve'){
      if(!count(payload.applied)||payload.automationHeld!==true)throw new Error();
      output({command,ok:true,applied:payload.applied,duplicate:payload.duplicate===true,automationHeld:true});return 0;
    }
    if(command==='resume'){
      if(payload.automationHeld!==false)throw new Error();
      output({command,ok:true,automationHeld:false});return 0;
    }
    if(!count(payload.quotesDeleted)||!count(payload.jobsDeleted))throw new Error();
    output({command,ok:true,quotesDeleted:payload.quotesDeleted,jobsDeleted:payload.jobsDeleted,...(count(payload.authBucketsDeleted)?{authBucketsDeleted:payload.authBucketsDeleted}:{})});return 0;
  }catch{
    output({command,ok:false,code:timedOut?'REQUEST_TIMEOUT':'REQUEST_FAILED',message:timedOut?'The request timed out. Check status before retrying an operation.':'The operation could not be confirmed. Check status and private platform logs before retrying.'});return 1;
  }finally{clearTimeout(timer);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  process.exitCode=await runOperatorCli(process.argv.slice(2));
}
