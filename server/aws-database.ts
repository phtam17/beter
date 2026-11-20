import {RDSDataClient,BeginTransactionCommand,CommitTransactionCommand,RollbackTransactionCommand,ExecuteStatementCommand,type SqlParameter} from '@aws-sdk/client-rds-data';
import {ApiFault,type Backend} from './api.ts';

export type Parameters=Record<string,unknown>;
export type QueryResult={rows:Record<string,any>[]};
export type Queryable={query(sql:string,parameters?:Parameters):Promise<QueryResult>};
export type Database=Queryable&{transaction<T>(operation:(query:Queryable)=>Promise<T>):Promise<T>};
type Client={send(command:any,options?:any):Promise<any>};
type DatabaseOptions={resourceArn:string;secretArn:string;database:string;region?:string;client?:Client;timeoutMs?:number};
const encoder=new TextEncoder();
const identifier=/^[a-z][a-z0-9_]*$/;
function failure(error:unknown):Error {
  const candidate=error as {name?:string;message?:string};
  // Only fixed business reasons cross the SDK boundary. SQL text and credentials never do.
  if(candidate?.name==='DatabaseErrorException'){
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
  if(typeof value==='number'&&Number.isFinite(value))return{name,value:Number.isSafeInteger(value)?{longValue:value}:{doubleValue:value}};
  if(typeof value==='object')return{name,typeHint:'JSON',value:{stringValue:JSON.stringify(value)}};
  throw new TypeError('Invalid database parameter value.');
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
  const result=await query.query(`with value as (select (${expression})::text as data) select substr(data, position, 4096) as part from value cross join lateral generate_series(1,greatest(length(data),1),4096) position order by position`,parameters);
  try{if(!result.rows.length||result.rows.some(row=>typeof row.part!=='string'))throw new Error();return JSON.parse(result.rows.map(row=>row.part).join(''));}
  catch{throw failure(null);}
}
async function service<T>(database:Database,operation:(query:Queryable)=>Promise<T>):Promise<T>{
  return database.transaction(async query=>{await query.query("select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claim.role','service_role',true),set_config('request.jwt.claims','{}',true)");await query.query('set local role service_role');return operation(query);});
}
export function createAwsDatabaseBackend({database,authenticate,auth}:{database:Database;authenticate:Backend['authenticate'];auth:Backend['auth']}):Backend {
  return{
    authenticate,auth,
    async rpc(name,args={},token=''){
      if(!/^beter_[a-z_]+$/.test(name)||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!/^p_[a-z_]+$/.test(key)))throw new ApiFault(400,'INVALID_RPC','Invalid database operation or arguments.');
      const role=token==='$service'?'service_role':token?'authenticated':'anon';
      const user=role==='authenticated'?await authenticate(token):null;
      if(user&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id))throw new ApiFault(401,'AUTH_REQUIRED','Sign in to continue.');
      return database.transaction(async query=>{
        await query.query("select set_config('request.jwt.claim.sub',:subject,true),set_config('request.jwt.claim.role',:role,true),set_config('request.jwt.claims',:claims,true)",{subject:user?.id||'',role,claims:JSON.stringify({sub:user?.id||'',role})});
        await query.query('set local role '+role);
        const parameters=Object.fromEntries(Object.entries(args).map(([key,value])=>[key,value]));
        return scalar(query,`public.${name}(${Object.keys(args).map(key=>`${key} => :${key}`).join(',')})`,parameters);
      });
    },
  };
}
export type AuthSession={accessHash:string;refreshHash:string;userId:string;sealedTokens:string;accessExpiresAt:number;refreshExpiresAt:number;previousAccessHash?:string|null;previousRefreshHash?:string|null;createdAt?:number;user?:{id:string;email:string}};
export function createAwsAuthStore(database:Database){
  const call=(name:string,parameters:Parameters={})=>service(database,query=>scalar(query,`auth.${name}(${Object.keys(parameters).map(key=>':'+key).join(',')})`,parameters));
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
