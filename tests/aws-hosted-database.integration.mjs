// Opt-in only. This verifies the migrated CLOSED staging cluster, never production.
// Financial fixtures remain in its immutable history; their bets are settled.
import test from 'node:test';
import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {RDSDataClient,ExecuteStatementCommand} from '@aws-sdk/client-rds-data';
import {createDataApiDatabase,createAwsDatabaseBackend,createAwsAuthStore} from '../server/aws-database.ts';
import {createAwsControl} from '../scripts/aws-deploy.mjs';

const ensure=(condition,code)=>{if(!condition)throw new Error(code);};
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
export function validateHostedState(state,{expectedAccountId,now=Date.now()}={}){
  const p=state?.parameters,o=state?.outputs,region=state?.region,account=state?.accountId;
  ensure(/^\d{12}$/.test(expectedAccountId||'')&&account===expectedAccountId&&state.stackName==='beter-staging'&&state.launchOpen===false&&state.schedules==='DISABLED','HOSTED_CHECKS_CLOSED_STAGING_REQUIRED');
  ensure(p?.Environment==='staging'&&p.LaunchOpen==='false'&&p.ScheduleState==='DISABLED'&&p.DataMode==='sample'&&o?.LaunchOpen==='false','HOSTED_CHECKS_CLOSED_STAGING_REQUIRED');
  ensure(/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(region||'')&&Number.isFinite(now)&&Date.parse(state.cutoffAt+'Z')>now,'HOSTED_CHECKS_REVIEW_REQUIRED');
  const resource=o.DatabaseClusterArn?.match(/^arn:(aws|aws-us-gov|aws-cn):rds:([a-z0-9-]+):(\d{12}):cluster:[A-Za-z0-9-]+$/);
  ensure(resource&&resource[2]===region&&resource[3]===account&&o.DatabaseName==='beter','HOSTED_CHECKS_DATABASE_REQUIRED');
  for(const name of ['DatabaseAppSecretArn','DatabaseMasterSecretArn']){
    const secret=o[name]?.match(/^arn:(aws|aws-us-gov|aws-cn):secretsmanager:([a-z0-9-]+):(\d{12}):secret:[A-Za-z0-9/_+=.@-]+$/);
    ensure(secret&&secret[1]===resource[1]&&secret[2]===region&&secret[3]===account,'HOSTED_CHECKS_DATABASE_REQUIRED');
  }
  ensure(o.DatabaseAppSecretArn!==o.DatabaseMasterSecretArn,'HOSTED_CHECKS_SEPARATE_LOGIN_REQUIRED');
  return{accountId:account,region,stackName:state.stackName,stackId:state.stackId,resourceArn:o.DatabaseClusterArn,database:o.DatabaseName,secretArn:o.DatabaseAppSecretArn,adminSecretArn:o.DatabaseMasterSecretArn};
}
export async function readHostedState({env=process.env,path=resolve('.data/aws-deploy/state.json'),read=readFile,inspect=stat}={}){
  ensure(env.BETER_RUN_AWS_HOSTED_DATABASE==='1','HOSTED_CHECKS_EXPLICIT_FLAG_REQUIRED');
  const info=await inspect(path);ensure((info.mode&0o077)===0&&info.isFile(),'HOSTED_CHECKS_PRIVATE_STATE_REQUIRED');
  const state=JSON.parse(await read(path,'utf8'));
  return{state,config:validateHostedState(state,{expectedAccountId:env.BETER_AWS_EXPECTED_ACCOUNT_ID})};
}
async function warmDatabase(client,config){
  const deadline=Date.now()+45000;
  for(let attempt=0;attempt<12;attempt++){
    try{await client.send(new ExecuteStatementCommand({resourceArn:config.resourceArn,secretArn:config.adminSecretArn,database:config.database,sql:'select 1 as ready',formatRecordsAs:'JSON'}),{abortSignal:AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-Date.now())))});return;}
    catch(error){ensure(['DatabaseResumingException','DatabaseUnavailableException'].includes(error?.name)&&attempt<11&&Date.now()+3000<deadline,'HOSTED_CHECKS_DATABASE_WARMUP_FAILED');await delay(3000);}
  }
}
export async function runHostedDatabaseChecks(t,options={}){
  const client=options.client||new RDSDataClient({region:options.config?.region,maxAttempts:2});
  try{return await executeHostedDatabaseChecks(t,{...options,client});}finally{client.destroy?.();}
}
async function executeHostedDatabaseChecks(t,{state,config,client,control=createAwsControl()}={}){
  const identity=await control.call('sts','get-caller-identity');ensure(identity.Account===config.accountId,'HOSTED_CHECKS_ACCOUNT_CHANGED');
  const result=await control.call('cloudformation','describe-stacks',{StackName:config.stackId||config.stackName},['--region',config.region]);const stack=result.Stacks?.[0];
  ensure(['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack?.StackStatus)&&stack.StackName===config.stackName&&(!config.stackId||stack.StackId===config.stackId),'HOSTED_CHECKS_STACK_NOT_READY');
  const live=validateHostedState({...state,parameters:Object.fromEntries((stack.Parameters||[]).map(p=>[p.ParameterKey,p.ParameterValue])),outputs:Object.fromEntries((stack.Outputs||[]).map(p=>[p.OutputKey,p.OutputValue]))},{expectedAccountId:config.accountId});
  ensure(live.resourceArn===config.resourceArn&&live.secretArn===config.secretArn&&live.adminSecretArn===config.adminSecretArn,'HOSTED_CHECKS_STATE_CHANGED');
  await warmDatabase(client,config);
  const admin=createDataApiDatabase({...config,secretArn:config.adminSecretArn,client}),runtime=createDataApiDatabase({...config,client});
  let onTransaction=null;
  const traced={...runtime,transaction:operation=>runtime.transaction(async query=>{if(onTransaction)onTransaction((await query.query('select pg_backend_pid() as pid')).rows[0]?.pid);return operation(query);})};
  const ids=[randomUUID(),randomUUID(),randomUUID()],runId=randomUUID(),events=[];
  const backend=createAwsDatabaseBackend({database:traced,authenticate:async token=>{const index=['fixture-a','fixture-b'].indexOf(token);ensure(index>=0,'HOSTED_CHECKS_TEST_IDENTITY_REQUIRED');return{id:ids[index]};},auth:async()=>{throw Error('HOSTED_CHECKS_AUTH_PROVIDER_OUT_OF_SCOPE');}});
  const store=createAwsAuthStore(traced);
  const asUser=(id,operation)=>runtime.transaction(async query=>{await query.query("select set_config('request.jwt.claim.sub',:subject,true) as subject",{subject:id});await query.query('set local role authenticated');return operation(query);});
  const counts=async id=>(await admin.query("select (select count(*)::int from public.beter_portfolios where owner_id=:id::uuid) as portfolios,(select count(*)::int from public.beter_ledger where owner_id=:id::uuid and type='grant') as grants,(select count(*)::int from public.beter_ledger where owner_id=:id::uuid and type='stake') as stakes",{id})).rows[0];
  const safeStep=async(name,code,operation)=>{let failed=false;await t.test(name,async()=>{try{await operation();}catch{failed=true;throw new Error(code);}});if(failed)throw Error(code);};
  async function waitForLocks(pids,count){
    const deadline=Date.now()+12000;
    while(Date.now()<deadline){
      if(pids.length===count){
        ensure(new Set(pids).size===count,'HOSTED_CHECKS_INDEPENDENT_SESSIONS_REQUIRED');
        const rows=(await admin.query("select count(*)::int as n from pg_stat_activity where pid in(select value::int from jsonb_array_elements_text(:pids::jsonb)) and wait_event_type='Lock'",{pids})).rows;
        if(rows[0]?.n===count)return;
      }
      await delay(100);
    }
    throw Error('HOSTED_CHECKS_OVERLAPPING_LOCKS_REQUIRED');
  }
  async function race(key,operations,{ordered=false}={}){
    const pids=[],pending=[];let settled;
    try{
      await admin.transaction(async gate=>{
        await gate.query('select pg_advisory_xact_lock(hashtextextended(:key,0))::text as gate',{key});
        onTransaction=pid=>pids.push(pid);
        for(const operation of operations){pending.push(operation());pending.at(-1).catch(()=>{});if(ordered)await waitForLocks(pids,pending.length);}
        settled=Promise.allSettled(pending);await waitForLocks(pids,operations.length);
      });
      return await settled;
    }finally{onTransaction=null;await Promise.allSettled(pending);}
  }
  async function event(){
    const id='hosted-check-'+randomUUID(),timestamp=new Date().toISOString();
    const data={id,sport:'Basketball',league:'NBA',home_team:'Hosted Check Home',away_team:'Hosted Check Away',starts_at:new Date(Date.now()+3600000).toISOString(),status:'upcoming',provider_updated_at:timestamp,fetched_at:timestamp,selections:[{id:id+'-home',team:'Hosted Check Home',market:'Moneyline',line:null,side:'home',odds:150,bookmaker:'hosted-check',provider_updated_at:timestamp,fetched_at:timestamp}]};
    events.push(id);await backend.rpc('beter_ingest_events',{p_events:[data]},'$service');return data;
  }
  const quote=(token,data)=>backend.rpc('beter_quote',{p_selection_ids:[data.selections[0].id]},token);
  const place=(token,accepted,stake,request)=>()=>backend.rpc('beter_place_bet',{p_quote_id:accepted.id,p_stake_cents:stake,p_request_id:request},token);
  const session=label=>({accessHash:createHash('sha256').update(runId+label+'access').digest('hex'),refreshHash:createHash('sha256').update(runId+label+'refresh').digest('hex'),userId:ids[2],sealedTokens:'hosted-check-encrypted-fixture',accessExpiresAt:Date.now()+60000,refreshExpiresAt:Date.now()+3600000});
  try{
    await safeStep('hosted runtime login has no ownership, inherited privileges or administrator roles','HOSTED_ROLE_BOUNDARY_FAILED',async()=>{
      const row=(await runtime.query("select current_user::text as name,session_user::text as login,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolcanlogin from pg_roles where rolname=current_user")).rows[0];
      ensure(row?.name==='beter_runtime'&&row.login==='beter_runtime'&&row.rolcanlogin&&!['rolsuper','rolinherit','rolcreaterole','rolcreatedb','rolreplication','rolbypassrls'].some(key=>row[key]),'HOSTED_ROLE_FLAGS_INVALID');
      const privileges=(await runtime.query("select has_schema_privilege(current_user,'public','CREATE') as public_create,has_table_privilege(current_user,'auth.users','SELECT') as auth_read,has_function_privilege(current_user,'auth.beter_runtime_configure(text)','EXECUTE') as configure,pg_has_role(current_user,'rds_superuser','MEMBER') as administrator")).rows[0];
      ensure(privileges&&!Object.values(privileges).some(Boolean),'HOSTED_RUNTIME_PRIVILEGE_LEAK');
      const owners=(await admin.query("select count(*)::int as incorrect from pg_class c join pg_namespace n on n.oid=c.relnamespace where (n.nspname='auth' or n.nspname='public' and c.relname like 'beter_%') and c.relkind in('r','p','S') and pg_get_userbyid(c.relowner)<>current_user")).rows[0];ensure(owners.incorrect===0,'HOSTED_MIGRATION_OWNER_INVALID');
      const health=await backend.rpc('beter_health',{},'$service');ensure(health.schema_version>=4,'HOSTED_SCHEMA_VERSION_REQUIRED');
      await runtime.query('select * from auth.aws_sessions limit 1').then(()=>{throw Error('HOSTED_PRIVATE_TABLE_READ_ALLOWED');},()=>{});
    });
    for(let index=0;index<ids.length;index++)await store.upsertUser({id:ids[index],email:`aws-hosted-${runId}-${index}@example.invalid`});
    await safeStep('independent hosted first visits create one portfolio and one grant','HOSTED_INITIAL_GRANT_RACE_FAILED',async()=>{
      const outcomes=await race(ids[0],[()=>backend.rpc('beter_portfolio',{},'fixture-a'),()=>backend.rpc('beter_portfolio',{},'fixture-a')]);
      ensure(outcomes.every(item=>item.status==='fulfilled')&&outcomes[0].value.id===outcomes[1].value.id,'HOSTED_INITIAL_GRANT_RACE_INVALID');const row=await counts(ids[0]);ensure(row.portfolios===1&&row.grants===1,'HOSTED_DUPLICATE_INITIAL_GRANT');await backend.rpc('beter_portfolio',{},'fixture-b');
    });
    await safeStep('actual authenticated RLS isolates owners and transaction context resets after commit and rollback','HOSTED_CALLER_ISOLATION_FAILED',async()=>{
      for(const id of ids.slice(0,2)){
        const rows=(await asUser(id,query=>query.query('select owner_id::text as owner from public.beter_portfolios'))).rows;ensure(rows.length===1&&rows[0].owner===id,'HOSTED_RLS_OWNER_LEAK');
      }
      await backend.rpc('beter_health',{},'fixture-a').then(()=>{throw Error('HOSTED_WORKER_RPC_ALLOWED');},()=>{});
      await runtime.transaction(async query=>{await query.query("select set_config('request.jwt.claim.sub',:subject,true) as subject",{subject:ids[0]});await query.query('set local role authenticated');throw Error('HOSTED_EXPECTED_ROLLBACK');}).catch(error=>ensure(error.message==='HOSTED_EXPECTED_ROLLBACK','HOSTED_ROLLBACK_FAILED'));
      for(let i=0;i<4;i++){const row=(await runtime.query("select current_user::text as role,nullif(current_setting('request.jwt.claim.sub',true),'') as subject")).rows[0];ensure(row.role==='beter_runtime'&&row.subject===null,'HOSTED_IDENTITY_CONTEXT_LEAK');}
      await backend.rpc('beter_portfolio').then(()=>{throw Error('HOSTED_ANONYMOUS_FINANCIAL_RPC_ALLOWED');},()=>{});await backend.rpc('beter_markets');
    });
    await safeStep('two overlapping hosted stakes cannot spend one balance twice','HOSTED_OVERSPEND_RACE_FAILED',async()=>{
      const data=await event(),one=await quote('fixture-a',data),two=await quote('fixture-a',data);const outcomes=await race(ids[0],[place('fixture-a',one,600000,randomUUID()),place('fixture-a',two,600000,randomUUID())]);
      ensure(outcomes.filter(item=>item.status==='fulfilled').length===1&&outcomes.filter(item=>item.status==='rejected').length===1,'HOSTED_OVERSPEND_WINNER_INVALID');const portfolio=await backend.rpc('beter_portfolio',{},'fixture-a');ensure(portfolio.balance_cents===400000&&portfolio.bets.length===1&&(await counts(ids[0])).stakes===1,'HOSTED_DOUBLE_STAKE');
    });
    await safeStep('duplicate hosted requests and settlement workers write each financial effect once','HOSTED_IDEMPOTENCY_RACE_FAILED',async()=>{
      const data=await event(),accepted=await quote('fixture-b',data),key=randomUUID();const outcomes=await race(ids[1],[place('fixture-b',accepted,10000,key),place('fixture-b',accepted,10000,key)]);
      ensure(outcomes.every(item=>item.status==='fulfilled')&&outcomes[0].value.bet.id===outcomes[1].value.bet.id&&(await counts(ids[1])).stakes===1,'HOSTED_DUPLICATE_STAKE');
      const args={p_event_id:data.id,p_outcomes:[{bet_id:outcomes[0].value.bet.id,status:'won'}],p_result_version:'hosted-'+runId,p_evidence:{source:'hosted-database-check'}};
      const settled=await race('result:'+data.id,[()=>backend.rpc('beter_settle',args,'$service'),()=>backend.rpc('beter_settle',args,'$service')]);ensure(settled.every(item=>item.status==='fulfilled')&&settled.reduce((sum,item)=>sum+item.value.applied,0)===1,'HOSTED_DUPLICATE_SETTLEMENT');
      ensure((await backend.rpc('beter_portfolio',{},'fixture-b')).balance_cents===1015000,'HOSTED_SETTLEMENT_BALANCE_INVALID');
    });
    await safeStep('hosted auth JSON exceeds 64KiB and round-trips through Data API chunking','HOSTED_LARGE_JSON_CHUNKING_FAILED',async()=>{
      const original={...session('large'),sealedTokens:'é'.repeat(40000)};await store.createSession(original);const found=await store.getSessionByAccessHash(original.accessHash);ensure(found.sealedTokens===original.sealedTokens&&Buffer.byteLength(JSON.stringify(found),'utf8')>65536,'HOSTED_LARGE_JSON_INVALID');await store.revokeSessionByAccessHash(original.accessHash);
    });
    await safeStep('hosted refresh, logout and recovery races preserve one winner and revoke descendants','HOSTED_SESSION_RACE_FAILED',async()=>{
      const old=session('old'),next={...session('next'),previousAccessHash:old.accessHash,previousRefreshHash:old.refreshHash};await store.createSession(old);
      const refreshed=await race('aws-auth:'+ids[2],[()=>store.rotateSession(old.refreshHash,next),()=>store.rotateSession(old.refreshHash,next)]);ensure(refreshed.every(item=>item.status==='fulfilled')&&refreshed.filter(item=>item.value===true).length===1,'HOSTED_REFRESH_WINNER_INVALID');await store.revokeSessionByAccessHash(old.accessHash);
      await store.createSession(old);const loggedOut=await race('aws-auth:'+ids[2],[()=>store.rotateSession(old.refreshHash,next),()=>store.revokeSessionByAccessHash(old.accessHash)],{ordered:true});ensure(loggedOut[0].status==='fulfilled'&&loggedOut[0].value===true&&loggedOut[1].status==='fulfilled'&&loggedOut[1].value?.accessHash===next.accessHash&&(await store.getSessionByRefreshHash(next.refreshHash))===null,'HOSTED_LOGOUT_RACE_INVALID');
      await store.createSession(old);const recovered=await race('aws-auth:'+ids[2],[()=>store.rotateSession(old.refreshHash,next),()=>store.revokeSessionsByEmail(`aws-hosted-${runId}-2@example.invalid`)],{ordered:true});ensure(recovered.every(item=>item.status==='fulfilled')&&(await store.getSessionByAccessHash(next.accessHash))===null,'HOSTED_RECOVERY_RACE_INVALID');
    });
  }finally{
    try{
      for(const id of events){const rows=(await admin.query("select id::text as id from public.beter_bets where event_id=:id and status='open' order by id",{id})).rows;if(rows.length)await backend.rpc('beter_settle',{p_event_id:id,p_outcomes:rows.map(row=>({bet_id:row.id,status:'void'})),p_result_version:'hosted-cleanup-'+runId,p_evidence:{source:'hosted-database-check-cleanup'}},'$service');}
      await store.revokeSessionsByUser(ids[2]);
      const health=await backend.rpc('beter_health',{},'$service');ensure(health.ledger_mismatches===0,'HOSTED_LEDGER_RECONCILIATION_FAILED');
    }catch{throw Error('HOSTED_FIXTURE_FINALIZATION_FAILED_REVIEW_REQUIRED');}
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  let setup;try{setup=await readHostedState();}catch{throw Error('HOSTED_CHECKS_SETUP_REQUIRED: explicitly enable closed staging checks and verify private state and the expected account.');}
  test('actual hosted Data API caller isolation and concurrency',{timeout:240000},async t=>{
    try{await runHostedDatabaseChecks(t,setup);}catch(error){throw Error(/^[A-Z_]+$/.test(error?.message||'')?error.message:'HOSTED_DATABASE_CHECKS_FAILED');}
  });
}
