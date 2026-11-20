import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createApiHandler} from '../server/api.ts';
import {createDataApiDatabase,createAwsAuthStore} from '../server/aws-database.ts';
const {createCognitoAuthBackend}=await import('../server/aws-auth.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});

const id='11111111-1111-4111-8111-111111111111';
const otherId='22222222-2222-4222-8222-222222222222';
const email='cognito-fixture@example.test';
const secret='private-cognito-session-fixture-key-123456789';
const hash=value=>createHash('sha256').update(value).digest('hex');
const clone=value=>value===undefined?undefined:structuredClone(value);
const providerError=name=>Object.assign(new Error('private upstream body password=fixture'),{name});

function fixture(options={}){
  let clock=Date.now(),serial=0;
  const users=new Map(),sessions=new Map(),families=new Map(),calls=[],revoked=new Set();
  const copy=row=>row?clone({...row,user:users.get(row.userId)}):null;
  const store={
    async upsertUser(user){users.set(user.id,clone(user));},
    async createSession(row){const saved={...clone(row),createdAt:clock,family:crypto.randomUUID()};sessions.set(row.accessHash,saved);families.set(row.accessHash,saved.family);},
    async getSessionByAccessHash(value){return copy(sessions.get(value));},
    async getSessionByRefreshHash(value){return copy([...sessions.values()].find(row=>row.refreshHash===value));},
    async rotateSession(oldHash,next){const old=[...sessions.values()].find(row=>row.refreshHash===oldHash);if(!old||old.refreshExpiresAt<=clock||old.userId!==next.userId||old.accessHash!==next.previousAccessHash||old.refreshHash!==next.previousRefreshHash)return false;sessions.delete(old.accessHash);const saved={...clone(next),createdAt:clock,family:old.family};sessions.set(next.accessHash,saved);families.set(next.accessHash,old.family);return true;},
    async revokeSessionByAccessHash(value){const family=families.get(value);const row=[...sessions.values()].find(row=>row.family===family);if(!row)return null;sessions.delete(row.accessHash);return copy(row);},
    async revokeSessionsByUser(value){for(const row of sessions.values())if(row.userId===value)sessions.delete(row.accessHash);},
    async revokeSessionsByEmail(value){const found=[...users.values()].find(user=>user.email===value);if(found)await store.revokeSessionsByUser(found.id);},
  };
  const defaultSend=async(command)=>{
    const operation=command.constructor.name.replace(/Command$/,'');const input=command.input;
    if(operation==='InitiateAuth')return{AuthenticationResult:{AccessToken:`provider-access-${++serial}`,ExpiresIn:3600,...(input.AuthFlow==='USER_PASSWORD_AUTH'?{RefreshToken:'provider-refresh-'+(options.largeTokens?'r'.repeat(9000):'fixture'),IdToken:'provider-id-token-not-needed'}:{})}};
    if(operation==='GetUser'){
      if(revoked.has(input.AccessToken))throw providerError('NotAuthorizedException');
      return{Username:'provider-user',UserAttributes:[{Name:'sub',Value:options.providerId||id},{Name:'email',Value:email},{Name:'email_verified',Value:options.unverified?'false':'true'}]};
    }
    if(operation==='SignUp')return{UserSub:id,UserConfirmed:false};
    if(operation==='GlobalSignOut'){for(let index=1;index<=serial;index++)revoked.add(`provider-access-${index}`);return{};}
    return{};
  };
  const client={async send(command,sendOptions){calls.push({name:command.constructor.name,input:clone(command.input),signal:sendOptions?.abortSignal});return options.send?options.send(command,defaultSend):defaultSend(command);}};
  function adapter(extra={}){assert.equal(typeof createCognitoAuthBackend,'function','A Cognito backend must keep compact application sessions authoritative.');return createCognitoAuthBackend({region:'us-west-2',clientId:'client123',secret,store,client,now:()=>new Date(clock),...extra});}
  return{adapter,client,store,users,sessions,calls,revoked,get clock(){return clock;},advance(ms){clock+=ms;}};
}
async function signin(f){return f.adapter().auth('signin',{email:' COGNITO-FIXTURE@EXAMPLE.TEST ',password:'a-long-private-password'});}

test('Cognito sign-in verifies provider identity and returns only compact opaque handles',async()=>{
  const f=fixture({largeTokens:true}),result=await signin(f);assert.equal(result.user.id,id);assert.equal(result.user.email,email);assert.match(result.session.access_token,/^[a-f0-9]{64}$/);assert.match(result.session.refresh_token,/^[a-f0-9]{64}$/);assert.notEqual(result.session.access_token,result.session.refresh_token);assert.equal(result.session.expires_at,Math.floor(f.clock/1000)+3600);
  assert.doesNotMatch(JSON.stringify(result),/provider-access|provider-refresh|provider-id-token/);
  assert.equal(f.calls[0].name,'InitiateAuthCommand');assert.equal(f.calls[0].input.AuthFlow,'USER_PASSWORD_AUTH');assert.equal(f.calls[0].input.AuthParameters.USERNAME,email);assert.equal(f.calls[1].name,'GetUserCommand');
  const row=[...f.sessions.values()][0];assert.equal(row.accessHash,hash(result.session.access_token));assert.equal(row.refreshHash,hash(result.session.refresh_token));assert.equal(row.userId,id);assert.doesNotMatch(row.sealedTokens,/provider-access|provider-refresh|provider-id-token/);assert.equal(row.previousRefreshHash??null,null);
});
test('large provider tokens fit the actual secure browser cookie transport',async()=>{
  const f=fixture({largeTokens:true}),auth=f.adapter();const handle=createApiHandler({backend:{...auth,rpc:async()=>({})},config:{mode:'aws',dataMode:'sample',liveOddsConfigured:false,sessionSecret:secret}});
  const response=await handle(new Request('https://beter.example/api/auth/signin',{method:'POST',headers:{Origin:'https://beter.example','X-Beter-Client':'browser','Content-Type':'application/json'},body:JSON.stringify({email,password:'a-long-private-password'})}));
  assert.equal(response.status,200);assert.ok(response.headers.get('set-cookie').length<3800);assert.match(response.headers.get('set-cookie'),/HttpOnly/);assert.doesNotMatch(await response.text(),/provider-access|provider-refresh|access_token|refresh_token/);
});
test('unknown, raw-provider, expired and privileged handles cannot authenticate',async()=>{
  const f=fixture(),auth=f.adapter();for(const token of ['$service','provider-access-1','a'.repeat(64),''])await assert.rejects(()=>auth.authenticate(token),error=>error.status===401);assert.equal(f.calls.length,0);
  const result=await auth.auth('signin',{email,password:'a-long-private-password'});f.advance(3600001);const calls=f.calls.length;await assert.rejects(()=>auth.authenticate(result.session.access_token),error=>error.status===401);assert.equal(f.calls.length,calls);
});
test('every private authentication verifies Cognito and rejects changed or unverified identities',async()=>{
  const f=fixture(),auth=f.adapter(),result=await auth.auth('signin',{email,password:'a-long-private-password'});assert.deepEqual(await auth.authenticate(result.session.access_token),{id,email});assert.equal(f.calls.at(-1).name,'GetUserCommand');
  f.revoked.add(f.calls.at(-1).input.AccessToken);await assert.rejects(()=>auth.authenticate(result.session.access_token),error=>error.status===401);
  for(const change of [{providerId:'not-a-uuid'},{unverified:true}]){const bad=fixture(change);await assert.rejects(()=>signin(bad),error=>error.status===401);assert.equal(bad.sessions.size,0);}
});
test('tampered encrypted sessions fail before contacting the provider',async()=>{
  const f=fixture(),auth=f.adapter(),result=await auth.auth('signin',{email,password:'a-long-private-password'});const row=[...f.sessions.values()][0];row.sealedTokens+='tampered';const calls=f.calls.length;await assert.rejects(()=>auth.authenticate(result.session.access_token),error=>error.status===401);assert.equal(f.calls.length,calls);
});
test('refresh rotates opaque credentials and preserves the original absolute refresh deadline',async()=>{
  const f=fixture(),auth=f.adapter(),result=await auth.auth('signin',{email,password:'a-long-private-password'});const deadline=[...f.sessions.values()][0].refreshExpiresAt;f.advance(3600001);const next=await auth.auth('refresh',{refresh_token:result.session.refresh_token});assert.notEqual(next.session.access_token,result.session.access_token);assert.notEqual(next.session.refresh_token,result.session.refresh_token);assert.equal(f.sessions.size,1);assert.equal([...f.sessions.values()][0].refreshExpiresAt,deadline);assert.equal(f.calls.find(call=>call.input.AuthFlow==='REFRESH_TOKEN_AUTH').input.AuthParameters.REFRESH_TOKEN,'provider-refresh-fixture');await assert.rejects(()=>auth.authenticate(result.session.access_token),error=>error.status===401);assert.equal((await auth.authenticate(next.session.access_token)).id,id);
});
test('independent instances share an exact refresh successor during a bounded reuse grace',async()=>{
  const f=fixture(),first=f.adapter(),second=f.adapter(),result=await first.auth('signin',{email,password:'a-long-private-password'});f.advance(3600001);
  const [one,two]=await Promise.all([first.auth('refresh',{refresh_token:result.session.refresh_token}),second.auth('refresh',{refresh_token:result.session.refresh_token})]);assert.deepEqual(one,two);assert.equal(f.sessions.size,1);const count=f.calls.filter(call=>call.input.AuthFlow==='REFRESH_TOKEN_AUTH').length;assert.deepEqual(await second.auth('refresh',{refresh_token:result.session.refresh_token}),one);assert.equal(f.calls.filter(call=>call.input.AuthFlow==='REFRESH_TOKEN_AUTH').length,count);
  f.advance(10001);await assert.rejects(()=>second.auth('refresh',{refresh_token:result.session.refresh_token}),error=>error.status===401);assert.equal((await second.authenticate(one.session.access_token)).id,id);
});
test('refresh cannot accept a provider identity different from the stored account',async()=>{
  let mismatch=false;const f=fixture({send:async(command,next)=>command.constructor.name==='GetUserCommand'&&mismatch?{Username:'wrong',UserAttributes:[{Name:'sub',Value:otherId},{Name:'email',Value:email},{Name:'email_verified',Value:'true'}]}:next(command)});const auth=f.adapter(),result=await auth.auth('signin',{email,password:'a-long-private-password'});mismatch=true;await assert.rejects(()=>auth.auth('refresh',{refresh_token:result.session.refresh_token}),error=>error.status===401);assert.equal(f.sessions.size,1);
});
test('logout revokes local credentials before provider failure and is idempotent',async()=>{
  const f=fixture({send:async(command,next)=>{if(command.constructor.name==='RevokeTokenCommand')throw providerError('InternalErrorException');return next(command);}}),auth=f.adapter(),result=await auth.auth('signin',{email,password:'a-long-private-password'});
  assert.deepEqual(await auth.auth('signout',{},result.session.access_token),{ok:true});assert.equal(f.sessions.size,0);await assert.rejects(()=>auth.authenticate(result.session.access_token),error=>error.status===401);assert.deepEqual(await auth.auth('signout',{},result.session.access_token),{ok:true});
});
test('logout by an earlier access handle revokes the rotated family',async()=>{
  const f=fixture(),auth=f.adapter(),result=await auth.auth('signin',{email,password:'a-long-private-password'});f.advance(3600001);const next=await auth.auth('refresh',{refresh_token:result.session.refresh_token});await auth.auth('signout',{},result.session.access_token);assert.equal(f.sessions.size,0);await assert.rejects(()=>auth.authenticate(next.session.access_token),error=>error.status===401);assert.equal(f.calls.at(-1).name,'RevokeTokenCommand');
});
test('a logout racing an in-flight refresh cannot resurrect its deleted session',async()=>{
  let release,entered;const waiting=new Promise(resolve=>entered=resolve);const barrier=new Promise(resolve=>release=resolve);
  const f=fixture({send:async(command,next)=>{if(command.input.AuthFlow==='REFRESH_TOKEN_AUTH'){entered();await barrier;}return next(command);}}),auth=f.adapter(),result=await auth.auth('signin',{email,password:'a-long-private-password'});f.advance(3600001);const refreshing=auth.auth('refresh',{refresh_token:result.session.refresh_token});await waiting;await auth.auth('signout',{},result.session.access_token);release();await assert.rejects(()=>refreshing,error=>error.status===401);assert.equal(f.sessions.size,0);
});
test('signup confirmation does not create a local user or authenticated session prematurely',async()=>{
  const f=fixture(),auth=f.adapter();assert.deepEqual(await auth.auth('signup',{email,password:'a-long-private-password'}),{session:null,requiresConfirmation:true});assert.equal(f.calls[0].name,'SignUpCommand');assert.equal(f.sessions.size,0);assert.equal(f.users.size,0);
  const existing=fixture({send:async()=>{throw providerError('UsernameExistsException');}});assert.deepEqual(await existing.adapter().auth('signup',{email,password:'a-long-private-password'}),{session:null,requiresConfirmation:true});
});
test('recovery uses Cognito code delivery without revealing whether the account exists',async()=>{
  for(const missing of [false,true]){const f=fixture({send:async(command,next)=>{if(missing)throw providerError('UserNotFoundException');return next(command);}});const result=await f.adapter().auth('recover',{email});assert.equal(result.requiresCode,true);assert.doesNotMatch(JSON.stringify(result),new RegExp(email));assert.equal(f.calls[0].name,'ForgotPasswordCommand');assert.equal(f.calls[0].input.Username,email);}
});
test('verified password recovery globally revokes provider tokens and all old opaque sessions',async()=>{
  const f=fixture(),auth=f.adapter(),first=await auth.auth('signin',{email,password:'a-long-private-password'});await auth.auth('signin',{email,password:'a-long-private-password'});assert.equal(f.sessions.size,2);
  assert.deepEqual(await auth.auth('confirm',{email,code:'123456',password:'a-new-private-password'}),{ok:true});assert.equal(f.sessions.size,0);assert.ok(f.calls.some(call=>call.name==='ConfirmForgotPasswordCommand'&&call.input.ConfirmationCode==='123456'));assert.ok(f.calls.some(call=>call.name==='GlobalSignOutCommand'));await assert.rejects(()=>auth.authenticate(first.session.access_token),error=>error.status===401);
});
test('post-confirm storage failure remains safe because Cognito rejects previously revoked tokens',async()=>{
  const f=fixture(),auth=f.adapter(),first=await auth.auth('signin',{email,password:'a-long-private-password'});f.store.revokeSessionsByUser=async()=>{throw new Error('postgres://private');};f.store.revokeSessionsByEmail=async()=>{throw new Error('postgres://private');};
  await assert.rejects(()=>auth.auth('confirm',{email,code:'123456',password:'a-new-private-password'}),error=>error.status===503&&/password.*changed/i.test(error.message)&&!/postgres|private/.test(error.message));assert.equal(f.sessions.size,1);await assert.rejects(()=>auth.authenticate(first.session.access_token),error=>error.status===401);
});
test('provider failure after confirmation still attempts local revocation and gives recovery-specific advice',async()=>{
  const f=fixture({send:async(command,next)=>{if(command.constructor.name==='GlobalSignOutCommand')throw providerError('InternalErrorException');return next(command);}}),auth=f.adapter();await auth.auth('signin',{email,password:'a-long-private-password'});await assert.rejects(()=>auth.auth('confirm',{email,code:'123456',password:'a-new-private-password'}),error=>error.status===503&&/password.*changed/i.test(error.message));assert.equal(f.sessions.size,0);
});
test('provider rejection codes map to safe account, code and throttling errors',async()=>{
  for(const name of ['NotAuthorizedException','UserNotFoundException','UserNotConfirmedException']){const f=fixture({send:async()=>{throw providerError(name);}});await assert.rejects(()=>f.adapter().auth('signin',{email,password:'a-long-private-password'}),error=>error.status===401&&!/private|password=/.test(error.message));}
  for(const name of ['CodeMismatchException','ExpiredCodeException']){const f=fixture({send:async()=>{throw providerError(name);}});await assert.rejects(()=>f.adapter().auth('confirm',{email,code:'123456',password:'a-new-private-password'}),error=>error.status===400&&error.code==='INVALID_CODE');}
  const limited=fixture({send:async()=>{throw providerError('TooManyRequestsException');}});await assert.rejects(()=>limited.adapter().auth('signin',{email,password:'a-long-private-password'}),error=>error.status===429);
});
test('malformed provider sessions and unsupported challenges cannot create application credentials',async()=>{
  for(const result of [{ChallengeName:'SOFTWARE_TOKEN_MFA',Session:'private-challenge'},{AuthenticationResult:{AccessToken:'raw',ExpiresIn:3600}},{AuthenticationResult:{AccessToken:'raw',RefreshToken:'refresh',ExpiresIn:NaN}}]){const f=fixture({send:async()=>result});await assert.rejects(()=>f.adapter().auth('signin',{email,password:'a-long-private-password'}));assert.equal(f.sessions.size,0);}
});
test('direct password replacement is refused and invalid credentials never reach Cognito',async()=>{
  const f=fixture(),auth=f.adapter();await assert.rejects(()=>auth.auth('password',{password:'a-new-private-password'},'a'.repeat(64)),error=>error.status===400&&error.code==='RECOVERY_REQUIRED');for(const body of [{email:'bad',password:'long-private-password'},{email,password:'short'}])await assert.rejects(()=>auth.auth('signin',body),error=>error.status===400);await assert.rejects(()=>auth.auth('confirm',{email,code:'not a code',password:'a-new-private-password'}),error=>error.status===400);assert.equal(f.calls.length,0);
});
test('provider deadlines abort and report a safe temporary failure',async()=>{
  const f=fixture({send:async()=>new Promise(()=>{})});await assert.rejects(()=>f.adapter({timeoutMs:10}).auth('signin',{email,password:'a-long-private-password'}),error=>error.status===503&&!/private|password=/.test(error.message));assert.equal(f.calls[0].signal.aborted,true);
});
test('invalid configuration and database faults fail without credential disclosure',async()=>{
  const f=fixture();for(const options of [{secret:'short'},{clientId:''},{region:''},{timeoutMs:0}])assert.throws(()=>f.adapter(options),/configur|secret|timeout|client|region/i);
  f.store.createSession=async()=>{throw new Error('database-password=private');};await assert.rejects(()=>signin(f),error=>error.status===503&&!/database-password|private/.test(error.message));
});
test('a short configured refresh lifetime also bounds the initial access lifetime',async()=>{
  const f=fixture({send:async(command,next)=>{const result=await next(command);if(result.AuthenticationResult)result.AuthenticationResult.ExpiresIn=86400;return result;}});
  const auth=f.adapter({refreshTtlMs:3600000}),result=await auth.auth('signin',{email,password:'a-long-private-password'});
  assert.ok(result.session.expires_at*1000<=[...f.sessions.values()][0].refreshExpiresAt);
  assert.equal((await auth.authenticate(result.session.access_token)).id,id);
});
test('encrypted Cognito sessions work through the real Data API query adapter and private PostgreSQL store',async()=>{
  const db=new PGlite();
  try{
    await db.exec(await readFile(new URL('../aws/sql/bootstrap.sql',import.meta.url),'utf8'));
    const transport={send:async command=>{
      const name=command.constructor.name;
      if(name==='BeginTransactionCommand'){await db.exec('begin');return{transactionId:'isolated-auth-test'};}
      if(name==='CommitTransactionCommand'){await db.exec('commit');return{};}
      if(name==='RollbackTransactionCommand'){await db.exec('rollback');return{};}
      const parameters=new Map((command.input.parameters||[]).map(value=>[value.name,value]));const values=[];
      const sql=command.input.sql.replace(/(?<!:):([a-z][a-z0-9_]*)/g,(match,key)=>{if(!parameters.has(key))return match;const value=parameters.get(key).value;values.push(value.isNull?null:value.stringValue??value.longValue??value.doubleValue??value.booleanValue);return'$'+values.length;});
      return{formattedRecords:JSON.stringify((await db.query(sql,values)).rows)};
    }};
    const database=createDataApiDatabase({resourceArn:'arn:aws:rds:us-west-2:123456789012:cluster:auth-test',secretArn:'arn:aws:secretsmanager:us-west-2:123456789012:secret:auth-test',database:'beter',client:transport});
    const f=fixture(),auth=f.adapter({store:createAwsAuthStore(database),now:()=>new Date()});
    const first=await auth.auth('signin',{email,password:'a-long-private-password'});assert.equal((await auth.authenticate(first.session.access_token)).id,id);
    const renewed=await auth.auth('refresh',{refresh_token:first.session.refresh_token});assert.equal((await auth.authenticate(renewed.session.access_token)).id,id);
    assert.deepEqual(await auth.auth('refresh',{refresh_token:first.session.refresh_token}),renewed);
    await auth.auth('signout',{},first.session.access_token);
    await assert.rejects(()=>auth.authenticate(renewed.session.access_token),error=>error.status===401);
    await db.exec('reset role');assert.equal((await db.query('select count(*)::integer as count from auth.aws_sessions')).rows[0].count,0);
  }finally{await db.close();}
});
