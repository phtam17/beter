import {SecretsManagerClient,GetSecretValueCommand} from '@aws-sdk/client-secrets-manager';
import {RDSDataClient} from '@aws-sdk/client-rds-data';
import {CognitoIdentityProviderClient} from '@aws-sdk/client-cognito-identity-provider';
import {createApiHandler,ApiFault} from './api.ts';
import {readSettings} from './config.ts';
import {createDataApiDatabase,createAwsDatabaseBackend,createAwsAuthStore,type Database} from './aws-database.ts';
import {createCognitoAuthBackend} from './aws-auth.ts';
import {createOddsProvider,createSampleProvider,type OddsProvider} from './provider.ts';
import {runBackgroundJobs} from './jobs.ts';
import {createAuthLimiter} from './abuse.ts';

type Client={send(command:any,options?:{abortSignal?:AbortSignal}):Promise<any>};
type Options={env?:Record<string,string|undefined>;secretsClient?:Client;dataApiClient?:Client;cognitoClient?:Client;database?:Database;provider?:OddsProvider;now?:()=>Date;secretTimeoutMs?:number};
const unavailable=()=>new ApiFault(503,'AWS_RUNTIME_UNAVAILABLE','The application services are not available. Check the private AWS configuration.');

/** Only the AWS entry imports this runtime; local development storage is never bundled here. */
export async function createAwsRuntime({env=process.env,secretsClient,dataApiClient,cognitoClient,database:injectedDatabase,provider:injectedProvider,now,secretTimeoutMs=10000}:Options={}){
  const trustedEnv={...env};const ownedClients:{destroy():void}[]=[];
  try{
    if(trustedEnv.BETER_BACKEND!=='aws'||!/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(trustedEnv.AWS_REGION||'')||!/^arn:(aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(trustedEnv.BETER_RUNTIME_SECRET_ARN||'')||!Number.isFinite(secretTimeoutMs)||secretTimeoutMs<=0)throw unavailable();
    const secretClient=secretsClient||new SecretsManagerClient({region:trustedEnv.AWS_REGION,maxAttempts:2});
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    let secret:any;
    try{
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},secretTimeoutMs);});
      const response=await Promise.race([secretClient.send(new GetSecretValueCommand({SecretId:trustedEnv.BETER_RUNTIME_SECRET_ARN}),{abortSignal:controller.signal}),timeout]);
      if(typeof response.SecretString!=='string'||response.SecretString.length>20000)throw unavailable();
      secret=JSON.parse(response.SecretString);
    }finally{clearTimeout(timer);if(!secretsClient)(secretClient as SecretsManagerClient).destroy();}
    const keys=['sessionSecret','jobSecret','oddsApiKey','originSecret'];
    if(!secret||typeof secret!=='object'||Array.isArray(secret)||Object.keys(secret).length!==keys.length||keys.some(key=>typeof secret[key]!=='string')||Object.keys(secret).some(key=>!keys.includes(key)))throw unavailable();
    Object.assign(trustedEnv,{BETER_SESSION_SECRET:secret.sessionSecret,JOB_SECRET:secret.jobSecret,ODDS_API_KEY:secret.oddsApiKey,BETER_ORIGIN_SECRET:secret.originSecret});
    const settings=readSettings(trustedEnv);
    let database=injectedDatabase;
    if(!database){
      const data=dataApiClient||new RDSDataClient({region:settings.awsRegion,maxAttempts:2});if(!dataApiClient)ownedClients.push(data as RDSDataClient);
      database=createDataApiDatabase({resourceArn:settings.databaseResourceArn,secretArn:settings.databaseSecretArn,database:settings.databaseName,region:settings.awsRegion,client:data});
    }
    const cognito=cognitoClient||new CognitoIdentityProviderClient({region:settings.awsRegion,maxAttempts:2});if(!cognitoClient)ownedClients.push(cognito as CognitoIdentityProviderClient);
    const auth=createCognitoAuthBackend({region:settings.awsRegion,clientId:settings.cognitoClientId,store:createAwsAuthStore(database),secret:settings.sessionSecret,client:cognito,now});
    const backend=createAwsDatabaseBackend({database,...auth});
    const provider=injectedProvider||(settings.dataMode==='sample'?createSampleProvider({now,startsAt:new Date(settings.sampleStartsAt),durationMs:settings.sampleDurationMs}):createOddsProvider({apiKey:settings.oddsApiKey,bookmaker:settings.bookmaker}));
    let running:Promise<unknown>|null=null;let closing:Promise<void>|null=null;
    const runJobs=async()=>{
      if(closing)throw new ApiFault(503,'RUNTIME_CLOSED','The application services are closed.');
      if(!running)running=runBackgroundJobs({backend,provider,now}).finally(()=>{running=null;});
      return running;
    };
    const authLimit=createAuthLimiter({backend,secret:settings.sessionSecret,trustProxy:'aws'});
    const handle=createApiHandler({backend,config:settings,jobSecret:settings.jobSecret,runJobs,allowedOrigins:settings.allowedOrigins,authLimit});
    return{handle,runJobs,backend,settings,originSecret:settings.originSecret,jobSecret:settings.jobSecret,close:()=>{
      if(!closing)closing=(async()=>{try{await running;}finally{try{await database.close?.();}finally{for(const client of ownedClients)client.destroy();}}})();
      return closing;
    }};
  }catch{for(const client of ownedClients)client.destroy();throw unavailable();}
}
