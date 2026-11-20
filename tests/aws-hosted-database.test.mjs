import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHostedState,readHostedState,runHostedDatabaseChecks} from './aws-hosted-database.integration.mjs';
const future=new Date(Date.now()+86400000).toISOString().slice(0,19);
const state=()=>({accountId:'123456789012',region:'us-west-2',stackName:'beter-staging',launchOpen:false,schedules:'DISABLED',cutoffAt:future,parameters:{Environment:'staging',LaunchOpen:'false',ScheduleState:'DISABLED',DataMode:'sample'},outputs:{LaunchOpen:'false',DatabaseClusterArn:'arn:aws:rds:us-west-2:123456789012:cluster:beter',DatabaseName:'beter',DatabaseAppSecretArn:'arn:aws:secretsmanager:us-west-2:123456789012:secret:app',DatabaseMasterSecretArn:'arn:aws:secretsmanager:us-west-2:123456789012:secret:master'},runtime:{sessionSecret:'private-do-not-return'}});
test('hosted database checks refuse an absent explicit flag before reading files or contacting AWS',async()=>{
  let reads=0;await assert.rejects(()=>readHostedState({env:{},read:async()=>{reads++;},inspect:async()=>{reads++;}}),/EXPLICIT_FLAG_REQUIRED/);assert.equal(reads,0);
});
test('hosted database checks require a private state file and the separately expected account',async()=>{
  let reads=0;await assert.rejects(()=>readHostedState({env:{BETER_RUN_AWS_HOSTED_DATABASE:'1'},inspect:async()=>({mode:0o644,isFile:()=>true}),read:async()=>{reads++;}}),/PRIVATE_STATE_REQUIRED/);assert.equal(reads,0);
  await assert.rejects(()=>readHostedState({env:{BETER_RUN_AWS_HOSTED_DATABASE:'1',BETER_AWS_EXPECTED_ACCOUNT_ID:'234567890123'},inspect:async()=>({mode:0o600,isFile:()=>true}),read:async()=>JSON.stringify(state())}),/CLOSED_STAGING_REQUIRED/);
});
test('hosted database checks return only resource identifiers from closed staging state',async()=>{
  const result=await readHostedState({env:{BETER_RUN_AWS_HOSTED_DATABASE:'1',BETER_AWS_EXPECTED_ACCOUNT_ID:'123456789012'},inspect:async()=>({mode:0o600,isFile:()=>true}),read:async()=>JSON.stringify(state())});assert.equal(result.config.region,'us-west-2');assert.doesNotMatch(JSON.stringify(result.config),/private-do-not-return|sessionSecret/);
});
test('hosted checks accept the actual AWS-managed rds!cluster secret ARN format',()=>{
  const target=state();target.outputs.DatabaseMasterSecretArn='arn:aws:secretsmanager:us-west-2:123456789012:secret:rds!cluster-11111111-1111-4111-8111-111111111111-ABC123';assert.equal(validateHostedState(target,{expectedAccountId:'123456789012'}).adminSecretArn,target.outputs.DatabaseMasterSecretArn);
});
test('hosted database checks refuse public, scheduled, expired, mismatched and production targets',()=>{
  for(const change of [s=>{s.launchOpen=true;},s=>{s.stackName='beter-production';},s=>{s.parameters.Environment='production';},s=>{s.parameters.ScheduleState='ENABLED';},s=>{s.parameters.DataMode='live';},s=>{s.outputs.LaunchOpen='true';},s=>{s.cutoffAt='2020-01-01T00:00:00';},s=>{s.outputs.DatabaseClusterArn=s.outputs.DatabaseClusterArn.replace('us-west-2','us-east-1');},s=>{s.outputs.DatabaseAppSecretArn=s.outputs.DatabaseMasterSecretArn;},s=>{s.outputs.DatabaseMasterSecretArn=s.outputs.DatabaseMasterSecretArn.replace('123456789012','234567890123');}]){const target=state();change(target);assert.throws(()=>validateHostedState(target,{expectedAccountId:'123456789012'}),/HOSTED_CHECKS_/);}
});
test('hosted checks revalidate actual account and stack before Data API calls and release the client on setup failure',async()=>{
  for(const mismatch of ['account','stack']){
    const target=state(),config=validateHostedState(target,{expectedAccountId:'123456789012'});let sends=0,destroyed=0;
    const client={async send(){sends++;throw Error('Must not reach the database.');},destroy(){destroyed++;}};
    const control={async call(service){if(service==='sts')return{Account:mismatch==='account'?'234567890123':'123456789012'};return{Stacks:[{StackName:'beter-staging',StackStatus:'CREATE_COMPLETE',Parameters:Object.entries({...target.parameters,LaunchOpen:'true'}).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})),Outputs:Object.entries(target.outputs).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]};}};
    await assert.rejects(()=>runHostedDatabaseChecks(null,{state:target,config,client,control}),/HOSTED_CHECKS_/);assert.equal(sends,0);assert.equal(destroyed,1);
  }
});
