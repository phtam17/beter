import test from 'node:test';
import assert from 'node:assert/strict';
import {readSettings} from '../server/config.ts';

export const awsEnvironment={NODE_ENV:'production',BETER_BACKEND:'aws',BETER_ENVIRONMENT:'staging',BETER_DATA_MODE:'sample',AWS_REGION:'us-west-2',SITE_URL:'https://staging.example.com',BETER_DATABASE_RESOURCE_ARN:'arn:aws:rds:us-west-2:123456789012:cluster:beter-staging',BETER_DATABASE_SECRET_ARN:'arn:aws:secretsmanager:us-west-2:123456789012:secret:beter-db-abcdef',BETER_DATABASE_NAME:'beter',BETER_COGNITO_CLIENT_ID:'client123',BETER_COGNITO_USER_POOL_ID:'us-west-2_Pool123',BETER_RUNTIME_SECRET_ARN:'arn:aws:secretsmanager:us-west-2:123456789012:secret:beter-runtime-abcdef',BETER_SESSION_SECRET:'s'.repeat(48),JOB_SECRET:'j'.repeat(48),BETER_ORIGIN_SECRET:'o'.repeat(48)};
test('AWS settings select managed services without Supabase and keep explicit staging sample mode',()=>{
  const settings=readSettings(awsEnvironment);assert.equal(settings.mode,'aws');assert.equal(settings.trustProxy,'aws');assert.equal(settings.dataMode,'sample');assert.equal(settings.supabaseConfigured,false);assert.equal(settings.awsRegion,'us-west-2');assert.equal(settings.databaseResourceArn,awsEnvironment.BETER_DATABASE_RESOURCE_ARN);assert.equal(settings.databaseSecretArn,awsEnvironment.BETER_DATABASE_SECRET_ARN);assert.equal(settings.databaseName,'beter');assert.equal(settings.cognitoClientId,'client123');assert.equal(settings.cognitoUserPoolId,'us-west-2_Pool123');assert.equal(settings.originSecret,awsEnvironment.BETER_ORIGIN_SECRET);
});
test('AWS startup requires every service setting and private secret even outside NODE_ENV production',()=>{
  for(const key of ['AWS_REGION','SITE_URL','BETER_DATABASE_RESOURCE_ARN','BETER_DATABASE_SECRET_ARN','BETER_DATABASE_NAME','BETER_COGNITO_CLIENT_ID','BETER_COGNITO_USER_POOL_ID','BETER_RUNTIME_SECRET_ARN','BETER_SESSION_SECRET','JOB_SECRET','BETER_ORIGIN_SECRET']){
    const env={...awsEnvironment,NODE_ENV:'development'};delete env[key];assert.throws(()=>readSettings(env),Error,key);
  }
  for(const key of ['BETER_SESSION_SECRET','JOB_SECRET','BETER_ORIGIN_SECRET'])assert.throws(()=>readSettings({...awsEnvironment,[key]:'short'}),/secret/i);
});
test('AWS settings reject remote transport, cross-region resources, invalid identifiers and unknown backends',()=>{
  for(const change of [{SITE_URL:'http://localhost:4173'},{SITE_URL:'https://user:private@example.com'},{AWS_REGION:'anything'},{BETER_DATABASE_RESOURCE_ARN:awsEnvironment.BETER_DATABASE_RESOURCE_ARN.replace('us-west-2','us-east-1')},{BETER_DATABASE_SECRET_ARN:'not-an-arn'},{BETER_RUNTIME_SECRET_ARN:awsEnvironment.BETER_RUNTIME_SECRET_ARN.replace('123456789012','234567890123')},{BETER_DATABASE_NAME:'beter;drop schema public'},{BETER_COGNITO_CLIENT_ID:'bad client'},{BETER_COGNITO_USER_POOL_ID:'us-east-1_Wrong'},{BETER_BACKEND:'unknown'}])assert.throws(()=>readSettings({...awsEnvironment,...change}),Error,JSON.stringify(change));
});
test('AWS sample deployment requires staging explicitly and live deployment requires its provider key',()=>{
  for(const environment of [undefined,'development','production'])assert.throws(()=>readSettings({...awsEnvironment,BETER_ENVIRONMENT:environment}),/staging/i);
  assert.throws(()=>readSettings({...awsEnvironment,BETER_DATA_MODE:'live'}),/provider key/i);
  assert.equal(readSettings({...awsEnvironment,BETER_ENVIRONMENT:'production',BETER_DATA_MODE:'live',ODDS_API_KEY:'private-provider-key'}).dataMode,'live');
});
test('AWS always applies hosted production guards when NODE_ENV is absent or development',()=>{
  for(const NODE_ENV of [undefined,'development']){const settings=readSettings({...awsEnvironment,NODE_ENV,BETER_ENVIRONMENT:undefined,BETER_DATA_MODE:'live',ODDS_API_KEY:'live-private-provider-key'});assert.equal(settings.production,true);assert.equal(settings.environment,'production');}
});
