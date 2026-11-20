import {RDSDataClient,BeginTransactionCommand,CommitTransactionCommand,RollbackTransactionCommand,ExecuteStatementCommand,type SqlParameter} from '@aws-sdk/client-rds-data';
import {ApiFault,type Backend} from './api.ts';
import {Pool,type PoolConfig} from 'pg';
import {bindPostgresParameters} from './sql.ts';

export type Parameters=Record<string,unknown>;
export type QueryResult={rows:Record<string,any>[]};
export type Queryable={query(sql:string,parameters?:Parameters):Promise<QueryResult>};
export type Database=Queryable&{transaction<T>(operation:(query:Queryable)=>Promise<T>):Promise<T>;close?():Promise<void>};
type Client={send(command:any,options?:any):Promise<any>};
type DatabaseOptions={resourceArn:string;secretArn:string;database:string;region?:string;client?:Client;timeoutMs?:number};
const encoder=new TextEncoder();
const identifier=/^[a-z][a-z0-9_]*$/;
type SqlType='text'|'uuid'|'integer'|'bigint'|'boolean'|'jsonb';
const rpcSignatures:Record<string,Record<string,SqlType>>={
  beter_portfolio:{},beter_create_portfolio:{p_name:'text'},beter_markets:{},beter_health:{},beter_settlement_candidates:{},
  beter_quote:{p_selection_ids:'jsonb'},beter_ingest_events:{p_events:'jsonb'},
  beter_place_bet:{p_quote_id:'uuid',p_stake_cents:'bigint',p_request_id:'text'},
  beter_settle:{p_event_id:'text',p_outcomes:'jsonb',p_result_version:'text',p_evidence:'jsonb'},
  beter_job_record:{p_name:'text',p_ok:'boolean',p_detail:'jsonb'},
  beter_resolve_event:{p_event_id:'text',p_outcomes:'jsonb',p_result_version:'text',p_evidence:'jsonb',p_operator:'text',p_reason:'text'},
  beter_resume_event:{p_event_id:'text',p_operator:'text',p_reason:'text'},
  beter_settlement_batch:{p_after:'text',p_limit:'integer'},
  beter_history:{p_portfolio_id:'uuid',p_before:'uuid',p_limit:'integer',p_status:'text'},
  beter_maintenance:{p_batch_size:'integer'},beter_auth_limit:{p_buckets:'jsonb'},
};
const authSignatures:Record<string,Record<string,SqlType>>={
  beter_user_upsert:{id:'uuid',email:'text'},beter_session_put:{session:'jsonb'},beter_session_get:{hash:'text',kind:'text'},
  beter_session_rotate:{hash:'text',session:'jsonb'},beter_session_revoke:{hash:'text'},beter_sessions_revoke_user:{id:'uuid'},beter_sessions_revoke_email:{email:'text'},
};
function failure(error:unknown):Error {
  const candidate=error as {name?:string;code?:string;message?:string};
  // Only fixed business reasons cross the SDK boundary. SQL text and credentials never do.
  if(candidate?.name==='DatabaseErrorException'||candidate?.code==='P0001'){
    const text=String(candidate.message||'');
    for(const [pattern,reason] of [[/BETER_RATE_LIMITED/,'BETER_RATE_LIMITED'],[/authentication required|auth_required/i,'authentication required'],[/insufficient|exceeds.*balance/i,'insufficient funds'],[/quote.*expir/i,'quote expired'],[/changed|quote.*price/i,'quote price changed'],[/stale|unavailable|closed|started|cutoff/i,'market unavailable'],[/idempot|request.*reuse|request.*different/i,'request id reused'],[/invalid|positive|selection|stake|quote not found|quote.*owner/i,'invalid request']] as const){if(pattern.test(text))return new Error(reason);}
  }
  return new ApiFault(503,'BACKEND_UNAVAILABLE','The database service is temporarily unavailable.');
}
function parameter(name:string,value:unknown):SqlParameter {
  if(!identifier.test(name))throw new TypeError('Invalid database parameter name.');
  if(value===null||value===undefined)return{name,value:{isNull:true}};
  if(typeof value==='string')return{name,value:{stringValue:value}};
  if(typeof value==='boolean')return{name,value:{booleanValue:value}};
  if(typeof value==='number'&&Number.isFinite(value)&&(!Number.isInteger(value)||Number.isSafeInteger(value)))return{name,value:Number.isSafeInteger(value)?{longValue:value}:{doubleValue:value}};
  if(typeof value==='object')return{name,typeHint:'JSON',value:{stringValue:JSON.stringify(value)}};
  throw new TypeError('Invalid database parameter value.');
}
type PoolLike={query(sql:string,values?:unknown[]):Promise<QueryResult>;connect():Promise<{query(sql:string,values?:unknown[]):Promise<QueryResult>;release(error?:Error):void}>;end?():Promise<void>};
export function createPostgresDatabase({pool,connectionString,ssl,allowLocalInsecure=false}:{pool?:PoolLike;connectionString?:string;ssl?:PoolConfig['ssl'];allowLocalInsecure?:boolean}):Database{
  if(!pool){
    let url:URL;try{url=new URL(connectionString||'');}catch{throw new TypeError('Configure a valid PostgreSQL connection.');}
    if(!['postgres:','postgresql:'].includes(url.protocol))throw new TypeError('Configure a PostgreSQL connection.');
    if(url.search)throw new TypeError('PostgreSQL connection URL query parameters are not supported; configure the authority and verified TLS explicitly.');
    const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    const insecure=allowLocalInsecure&&local;
    if((ssl===false&&!insecure)||(ssl&&typeof ssl==='object'&&ssl.rejectUnauthorized===false))throw new TypeError('Configure verified TLS for remote PostgreSQL; only explicit loopback connections can omit TLS.');
    pool=new Pool({connectionString,ssl:ssl??(insecure?false:{rejectUnauthorized:true}),max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,query_timeout:55000,statement_timeout:45000});
  }
  const selected=pool;
  const query=async(target:Pick<PoolLike,'query'>,sql:string,parameters:Parameters={})=>{
    const bound=bindPostgresParameters(sql,parameters);
    try{return await target.query(bound.sql,bound.values);}catch(error){throw failure(error);}
  };
  return{
    query:(sql,parameters)=>query(selected,sql,parameters),
    async transaction<T>(operation:(query:Queryable)=>Promise<T>){
      let client:Awaited<ReturnType<PoolLike['connect']>>;
      try{client=await selected.connect();}catch{throw failure(null);}
      let discard:Error|undefined;
      try{await client.query('begin');const result=await operation({query:(sql,parameters)=>query(client,sql,parameters)});await client.query('commit');return result;}
      catch(error){try{await client.query('rollback');}catch{discard=new Error('Database transaction connection failed.');}throw error instanceof ApiFault||error instanceof TypeError?error:failure(error);}
      finally{client.release(discard);}
    },
    close:async()=>{await selected.end?.();},
  };
}
export function createDataApiDatabase({resourceArn,secretArn,database,region,client=new RDSDataClient({region}),timeoutMs=55000}:DatabaseOptions):Database {
  if(!resourceArn?.startsWith('arn:')||!secretArn?.startsWith('arn:')||!/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.test(database)||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new TypeError('Configure a valid AWS database resource, private secret, and database name.');
  const base={resourceArn,secretArn,database};
  const send=async(command:any)=>{try{return await client.send(command,{abortSignal:AbortSignal.timeout(timeoutMs)});}catch(error){throw failure(error);}};
  const query=async(sql:string,parameters:Parameters={},transactionId?:string):Promise<QueryResult>=>{
    if(typeof sql!=='string'||!sql.trim()||encoder.encode(sql).byteLength>65536)throw new TypeError('The database statement is empty or exceeds the statement limit.');
    if(!parameters||typeof parameters!=='object'||Array.isArray(parameters))throw new TypeError('Invalid database parameters.');
    const response=await send(new ExecuteStatementCommand({...base,sql,parameters:Object.entries(parameters).map(([key,value])=>parameter(key,value)),formatRecordsAs:'JSON',includeResultMetadata:false,...(transactionId?{transactionId}:{})}));
    if(response.formattedRecords===undefined)return{rows:[]};
    try{
      if(typeof response.formattedRecords!=='string'||encoder.encode(response.formattedRecords).byteLength>10*1024*1024)throw new Error();
      const rows=JSON.parse(response.formattedRecords);
      if(!Array.isArray(rows)||rows.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw new Error();
      return{rows};
    }catch{throw failure(null);}
  };
  return{
    query:(sql,parameters)=>query(sql,parameters),
    async transaction<T>(operation:(query:Queryable)=>Promise<T>):Promise<T>{
      const begun=await send(new BeginTransactionCommand(base));
      if(typeof begun.transactionId!=='string'||!begun.transactionId)throw failure(null);
      const transactionId=begun.transactionId;
      try{const result=await operation({query:(sql,parameters)=>query(sql,parameters,transactionId)});await send(new CommitTransactionCommand({...base,transactionId}));return result;}
      catch(error){try{await send(new RollbackTransactionCommand({...base,transactionId}));}catch{/* Preserve the original safe failure. */}throw error;}
    },
  };
}
async function scalar(query:Queryable,expression:string,parameters:Parameters={}):Promise<any>{
  // Each UTF-8 row stays well below Data API's 64 KiB row limit, including escaped JSON.
  const result=await query.query(`with value as (select coalesce((${expression})::text,'null') as data) select substr(data, position, 4096) as part from value cross join lateral generate_series(1,greatest(length(data),1),4096) position order by position`,parameters);
  try{if(!result.rows.length||result.rows.some(row=>typeof row.part!=='string'))throw new Error();return JSON.parse(result.rows.map(row=>row.part).join(''));}
  catch{throw failure(null);}
}
async function service<T>(database:Database,operation:(query:Queryable)=>Promise<T>):Promise<T>{
  return database.transaction(async query=>{await query.query("select set_config('request.jwt.claim.sub','',true) as subject,set_config('request.jwt.claim.role','service_role',true) as role,set_config('request.jwt.claims','{}',true) as claims");await query.query('set local role service_role');return operation(query);});
}
export function createAwsDatabaseBackend({database,authenticate,auth}:{database:Database;authenticate:Backend['authenticate'];auth:Backend['auth']}):Backend {
  return{
    authenticate,auth,
    async rpc(name,args={},token=''){
      if(!Object.hasOwn(rpcSignatures,name)||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!Object.hasOwn(rpcSignatures[name],key)))throw new ApiFault(400,'INVALID_RPC','Invalid database operation or arguments.');
      const role=token==='$service'?'service_role':token?'authenticated':'anon';
      const user=role==='authenticated'?await authenticate(token):null;
      if(user&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id))throw new ApiFault(401,'AUTH_REQUIRED','Sign in to continue.');
      return database.transaction(async query=>{
        await query.query("select set_config('request.jwt.claim.sub',:subject,true) as subject,set_config('request.jwt.claim.role',:role,true) as role,set_config('request.jwt.claims',:claims,true) as claims",{subject:user?.id||'',role,claims:JSON.stringify({sub:user?.id||'',role})});
        await query.query('set local role '+role);
        const parameters=Object.fromEntries(Object.entries(args).map(([key,value])=>[key,value]));
        return scalar(query,`public.${name}(${Object.keys(args).map(key=>`${key} => :${key}::${rpcSignatures[name][key]}`).join(',')})`,parameters);
      });
    },
  };
}
export type AuthSession={accessHash:string;refreshHash:string;userId:string;sealedTokens:string;accessExpiresAt:number;refreshExpiresAt:number;previousAccessHash?:string|null;previousRefreshHash?:string|null;createdAt?:number;user?:{id:string;email:string}};
export function createAwsAuthStore(database:Database){
  const call=(name:string,parameters:Parameters={})=>service(database,query=>scalar(query,`auth.${name}(${Object.keys(parameters).map(key=>':'+key+'::'+authSignatures[name][key]).join(',')})`,parameters));
  return{
    upsertUser:({id,email}:{id:string;email:string})=>call('beter_user_upsert',{id,email}),
    createSession:(session:AuthSession)=>call('beter_session_put',{session}),
    getSessionByAccessHash:(hash:string)=>call('beter_session_get',{hash,kind:'access'}),
    getSessionByRefreshHash:(hash:string)=>call('beter_session_get',{hash,kind:'refresh'}),
    rotateSession:(hash:string,session:AuthSession)=>call('beter_session_rotate',{hash,session}),
    revokeSessionByAccessHash:(hash:string)=>call('beter_session_revoke',{hash}),
    revokeSessionsByUser:(id:string)=>call('beter_sessions_revoke_user',{id}),
    revokeSessionsByEmail:(email:string)=>call('beter_sessions_revoke_email',{email}),
  };
}
