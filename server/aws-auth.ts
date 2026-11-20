import {
  CognitoIdentityProviderClient,ConfirmForgotPasswordCommand,ConfirmSignUpCommand,ForgotPasswordCommand,
  GetUserCommand,GlobalSignOutCommand,InitiateAuthCommand,ResendConfirmationCodeCommand,RevokeTokenCommand,SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {ApiFault} from './api.ts';

type User={id:string;email:string};
export type AwsAuthSession={
  accessHash:string;refreshHash:string;userId:string;sealedTokens:string;
  accessExpiresAt:number;refreshExpiresAt:number;
  previousAccessHash?:string|null;previousRefreshHash?:string|null;createdAt?:number;user?:User;
};
export type AwsAuthStore={
  upsertUser(user:User):Promise<unknown>;
  createSession(session:AwsAuthSession):Promise<unknown>;
  getSessionByAccessHash(hash:string):Promise<AwsAuthSession|null>;
  getSessionByRefreshHash(hash:string):Promise<AwsAuthSession|null>;
  rotateSession(hash:string,session:AwsAuthSession):Promise<boolean>;
  revokeSessionByAccessHash(hash:string):Promise<AwsAuthSession|null>;
  revokeSessionsByUser(id:string):Promise<unknown>;
  revokeSessionsByEmail(email:string):Promise<unknown>;
};
type Client={send(command:any,options?:{abortSignal?:AbortSignal}):Promise<any>};
type Options={region:string;clientId:string;store:AwsAuthStore;secret:string;client?:Client;now?:()=>Date;timeoutMs?:number;refreshTtlMs?:number};
type ProviderTokens={accessToken:string;refreshToken:string;userId:string};
const encoder=new TextEncoder();
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const opaque=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const providerToken=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=16384&&/^[A-Za-z0-9_.=+/-]+$/.test(value);
const hex=(bytes:ArrayBuffer|Uint8Array)=>Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
const encode=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const decode=(text:string)=>Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),character=>character.charCodeAt(0));
const authFailed=()=>new ApiFault(401,'AUTH_FAILED','Sign in failed. Check your details or confirm your email.');
const unavailable=()=>new ApiFault(503,'ACCOUNT_UNAVAILABLE','The account service is temporarily unavailable. Please try again.');
const resetIncomplete=()=>new ApiFault(503,'PASSWORD_RESET_INCOMPLETE','Your password may have changed. Try signing in with the new password, or request another recovery code.');
function safeError(error:unknown):ApiFault{
  if(error instanceof ApiFault)return error;
  const name=(error as {name?:unknown})?.name;
  if(name==='TooManyRequestsException'||name==='LimitExceededException')return new ApiFault(429,'RATE_LIMITED','Too many attempts. Please wait before trying again.');
  if(name==='CodeMismatchException'||name==='ExpiredCodeException')return new ApiFault(400,'INVALID_CODE','The verification code is invalid or expired. Request a new code and try again.');
  if(name==='InvalidPasswordException'||name==='PasswordHistoryPolicyViolationException')return new ApiFault(400,'INVALID_PASSWORD','Choose a different password that meets the account requirements.');
  if(['NotAuthorizedException','UnauthorizedException','UserNotFoundException','UserNotConfirmedException','PasswordResetRequiredException'].includes(String(name)))return authFailed();
  return unavailable();
}
function emailAddress(value:unknown):string{
  if(typeof value!=='string'||value.length>254||!/^\S+@\S+\.\S+$/.test(value.trim()))throw new ApiFault(400,'INVALID_EMAIL','Enter a valid email address.');
  return value.trim().toLowerCase();
}
function password(value:unknown):string{
  if(typeof value!=='string'||value.length<10||value.length>200)throw new ApiFault(400,'INVALID_PASSWORD','Use a password with 10 to 200 characters.');
  return value;
}

/** Cognito credentials remain encrypted in a private store; browser cookies contain compact opaque handles. */
export function createCognitoAuthBackend({region,clientId,store,secret,client,now=()=>new Date(),timeoutMs=10000,refreshTtlMs=30*86400000}:Options){
  if(typeof region!=='string'||!region||typeof clientId!=='string'||!clientId||!store||typeof secret!=='string'||secret.length<32||!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isSafeInteger(refreshTtlMs)||refreshTtlMs<3600000)throw new ApiFault(503,'AUTH_UNCONFIGURED','Configure the Cognito region, client, private session secret, and valid timeout.');
  const cognito=client||new CognitoIdentityProviderClient({region,maxAttempts:2});
  const digest=async(value:string)=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
  const encryptionKey=crypto.subtle.digest('SHA-256',encoder.encode('beter-cognito-session-v1:'+secret)).then(bytes=>crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']));
  const rotationKey=crypto.subtle.importKey('raw',encoder.encode('beter-cognito-rotation-v1:'+secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const successor=async(token:string,kind:string)=>hex(await crypto.subtle.sign('HMAC',await rotationKey,encoder.encode(kind+':'+token)));
  function timestamp(){const value=now().getTime();if(!Number.isSafeInteger(value)||value<0)throw unavailable();return value;}
  async function invoke(command:any,deadline:number){
    const remaining=deadline-Date.now();if(remaining<=0)throw unavailable();
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},remaining);});
    try{return await Promise.race([cognito.send(command,{abortSignal:controller.signal}),timeout]);}
    finally{clearTimeout(timer);}
  }
  async function identity(accessToken:string,deadline:number,expectedId?:string):Promise<User>{
    const result=await invoke(new GetUserCommand({AccessToken:accessToken}),deadline);
    if(!Array.isArray(result?.UserAttributes))throw authFailed();
    const attributes=new Map<string,string>();
    for(const attribute of result.UserAttributes){if(typeof attribute?.Name!=='string'||typeof attribute.Value!=='string'||attributes.has(attribute.Name))throw authFailed();attributes.set(attribute.Name,attribute.Value);}
    const id=attributes.get('sub');if(!uuid(id)||(expectedId&&expectedId!==id)||attributes.get('email_verified')!=='true')throw authFailed();
    let email:string;try{email=emailAddress(attributes.get('email'));}catch{throw authFailed();}
    return{id,email};
  }
  function readRow(row:AwsAuthSession|null):AwsAuthSession|null{
    if(!row)return null;
    if(!opaque(row.accessHash)||!opaque(row.refreshHash)||!uuid(row.userId)||typeof row.sealedTokens!=='string'||row.sealedTokens.length>100000||!Number.isSafeInteger(row.accessExpiresAt)||!Number.isSafeInteger(row.refreshExpiresAt)||row.refreshExpiresAt<row.accessExpiresAt||row.user?.id!==row.userId)throw authFailed();
    return row;
  }
  async function seal(tokens:ProviderTokens){
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const payload=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(tokens.userId)},await encryptionKey,encoder.encode(JSON.stringify({v:1,...tokens})));
    return `v1.${encode(iv)}.${encode(new Uint8Array(payload))}`;
  }
  async function open(row:AwsAuthSession):Promise<ProviderTokens>{
    try{
      const [version,iv,payload,...extra]=row.sealedTokens.split('.');if(version!=='v1'||!iv||!payload||extra.length)throw authFailed();
      const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(iv),additionalData:encoder.encode(row.userId)},await encryptionKey,decode(payload));
      const value=JSON.parse(new TextDecoder().decode(plaintext));if(value.v!==1||value.userId!==row.userId||!providerToken(value.accessToken)||!providerToken(value.refreshToken))throw authFailed();
      return{accessToken:value.accessToken,refreshToken:value.refreshToken,userId:row.userId};
    }catch{throw authFailed();}
  }
  function resultTokens(result:any,previousRefresh?:string){
    const value=result?.AuthenticationResult;
    if(result?.ChallengeName)throw new ApiFault(401,'AUTH_CHALLENGE_REQUIRED','This account requires an additional sign-in step. Use account recovery or contact support.');
    const refreshToken=value?.RefreshToken??previousRefresh;
    if(!providerToken(value?.AccessToken)||!providerToken(refreshToken)||!Number.isSafeInteger(value?.ExpiresIn)||value.ExpiresIn<60||value.ExpiresIn>86400)throw unavailable();
    return{accessToken:value.AccessToken,refreshToken,expiresIn:value.ExpiresIn};
  }
  const publicResult=(access:string,refresh:string,row:AwsAuthSession,user:User)=>({session:{access_token:access,refresh_token:refresh,expires_at:Math.floor(row.accessExpiresAt/1000),user},user});
  async function reuseSuccessor(oldToken:string,deadline:number){
    const access=await successor(oldToken,'access'),refresh=await successor(oldToken,'refresh');
    const row=readRow(await store.getSessionByRefreshHash(await digest(refresh)));
    const age=row?.createdAt===undefined?Infinity:timestamp()-row.createdAt;
    if(!row||row.previousRefreshHash!==await digest(oldToken)||age<0||age>10000||row.refreshExpiresAt<=timestamp())throw authFailed();
    const tokens=await open(row),user=await identity(tokens.accessToken,deadline,row.userId);
    return publicResult(access,refresh,row,user);
  }
  async function authenticate(token:string):Promise<User>{
    try{
      if(!opaque(token))throw authFailed();
      const deadline=Date.now()+timeoutMs,row=readRow(await store.getSessionByAccessHash(await digest(token)));
      if(!row||row.accessExpiresAt<=timestamp()||row.refreshExpiresAt<=timestamp())throw authFailed();
      const tokens=await open(row),user=await identity(tokens.accessToken,deadline,row.userId);
      return user;
    }catch(error){throw safeError(error);}
  }
  async function auth(action:string,body:Record<string,unknown>,token=''):Promise<unknown>{
    const deadline=Date.now()+timeoutMs;
    try{
      if(action==='password')throw new ApiFault(400,'RECOVERY_REQUIRED','Use a recovery code to choose a new password.');
      if(action==='signout'){
        if(!opaque(token))return{ok:true};
        const row=readRow(await store.revokeSessionByAccessHash(await digest(token)));
        if(row){try{const tokens=await open(row);await invoke(new RevokeTokenCommand({ClientId:clientId,Token:tokens.refreshToken}),deadline);}catch{/* Local revocation is complete even when the provider is unavailable. */}}
        return{ok:true};
      }
      if(action==='refresh'){
        if(!opaque(body.refresh_token))throw authFailed();const oldToken=body.refresh_token,oldHash=await digest(oldToken);
        const old=readRow(await store.getSessionByRefreshHash(oldHash));
        if(!old)return await reuseSuccessor(oldToken,deadline);
        if(old.refreshExpiresAt<=timestamp())throw authFailed();
        const previous=await open(old);
        const renewed=resultTokens(await invoke(new InitiateAuthCommand({AuthFlow:'REFRESH_TOKEN_AUTH',ClientId:clientId,AuthParameters:{REFRESH_TOKEN:previous.refreshToken}}),deadline),previous.refreshToken);
        const user=await identity(renewed.accessToken,deadline,old.userId);
        const access=await successor(oldToken,'access'),refresh=await successor(oldToken,'refresh');
        const next:AwsAuthSession={accessHash:await digest(access),refreshHash:await digest(refresh),userId:user.id,sealedTokens:await seal({...renewed,userId:user.id}),accessExpiresAt:Math.min(timestamp()+renewed.expiresIn*1000,old.refreshExpiresAt),refreshExpiresAt:old.refreshExpiresAt,previousAccessHash:old.accessHash,previousRefreshHash:old.refreshHash};
        if(!await store.rotateSession(oldHash,next))return await reuseSuccessor(oldToken,deadline);
        await store.upsertUser(user);
        return publicResult(access,refresh,next,user);
      }
      const email=emailAddress(body.email);
      if(action==='verify'){
        if(typeof body.code!=='string'||!/^\d{6}$/.test(body.code))throw new ApiFault(400,'INVALID_CODE','Enter the six-digit verification code.');
        await invoke(new ConfirmSignUpCommand({ClientId:clientId,Username:email,ConfirmationCode:body.code,ForceAliasCreation:false}),deadline);
        return{ok:true};
      }
      if(action==='resend'){
        try{await invoke(new ResendConfirmationCodeCommand({ClientId:clientId,Username:email}),deadline);}catch(error){if(!['UserNotFoundException','InvalidParameterException','NotAuthorizedException'].includes(String((error as {name?:unknown})?.name)))throw error;}
        return{message:'If this account is waiting for confirmation, check your email for a verification code.'};
      }
      if(action==='recover'){
        try{await invoke(new ForgotPasswordCommand({ClientId:clientId,Username:email}),deadline);}catch(error){if(!['UserNotFoundException','InvalidParameterException'].includes(String((error as {name?:unknown})?.name)))throw error;}
        return{requiresCode:true,message:'If this account exists and is confirmed, check your email for a recovery code.'};
      }
      if(action==='confirm'){
        const nextPassword=password(body.password);
        if(typeof body.code!=='string'||!/^\d{6}$/.test(body.code))throw new ApiFault(400,'INVALID_CODE','Enter the six-digit recovery code.');
        await invoke(new ConfirmForgotPasswordCommand({ClientId:clientId,Username:email,ConfirmationCode:body.code,Password:nextPassword}),deadline);
        let failure=false;
        try{
          const fresh=resultTokens(await invoke(new InitiateAuthCommand({AuthFlow:'USER_PASSWORD_AUTH',ClientId:clientId,AuthParameters:{USERNAME:email,PASSWORD:nextPassword}}),deadline));
          const user=await identity(fresh.accessToken,deadline);
          await invoke(new GlobalSignOutCommand({AccessToken:fresh.accessToken}),deadline);
          await store.revokeSessionsByUser(user.id);
        }catch{failure=true;}
        // The immutable email identifier provides a second local revocation path
        // even when the provider fails after it has already changed the password.
        try{await store.revokeSessionsByEmail(email);}catch{failure=true;}
        if(failure)throw resetIncomplete();
        return{ok:true};
      }
      if(action==='signup'){
        const nextPassword=password(body.password);
        try{await invoke(new SignUpCommand({ClientId:clientId,Username:email,Password:nextPassword,UserAttributes:[{Name:'email',Value:email}]}),deadline);}catch(error){
          const name=(error as {name?:unknown})?.name;
          if(name==='UserLambdaValidationException')throw new ApiFault(403,'SIGNUP_UNAVAILABLE','Account registration is not available. Contact support or try again later.');
          if(name!=='UsernameExistsException')throw error;
        }
        return{session:null,requiresConfirmation:true,confirmationMethod:'code'};
      }
      if(action!=='signin')throw new ApiFault(400,'INVALID_AUTH_ACTION','Choose a valid account action.');
      const provider=resultTokens(await invoke(new InitiateAuthCommand({AuthFlow:'USER_PASSWORD_AUTH',ClientId:clientId,AuthParameters:{USERNAME:email,PASSWORD:password(body.password)}}),deadline));
      const user=await identity(provider.accessToken,deadline);
      const access=hex(crypto.getRandomValues(new Uint8Array(32))),refresh=hex(crypto.getRandomValues(new Uint8Array(32))),time=timestamp();
      const session:AwsAuthSession={accessHash:await digest(access),refreshHash:await digest(refresh),userId:user.id,sealedTokens:await seal({...provider,userId:user.id}),accessExpiresAt:time+Math.min(provider.expiresIn*1000,refreshTtlMs),refreshExpiresAt:time+refreshTtlMs,previousAccessHash:null,previousRefreshHash:null};
      await store.upsertUser(user);await store.createSession(session);
      return publicResult(access,refresh,session,user);
    }catch(error){throw safeError(error);}
  }
  return{authenticate,auth};
}
