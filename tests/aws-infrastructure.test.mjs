import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const template=await readFile(new URL('../infra/aws/template.json',import.meta.url),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
const resource=name=>{assert.ok(template,'A deployable AWS infrastructure template must exist.');assert.ok(template.Resources[name],`Missing infrastructure component: ${name}`);return template.Resources[name];};
test('AWS staging starts closed, with separate user and origin gates',()=>{
  resource('Distribution');assert.equal(template.Parameters.LaunchOpen.Default,'false');assert.equal(template.Parameters.StagingAuthorizationHash.MinLength,64);const code=JSON.stringify(resource('StagingGate').Properties.FunctionCode);assert.match(code,/sha256/);assert.match(code,/x-beter-staging-access/);assert.doesNotMatch(code,/StagingPassword/);const apiOrigin=resource('Distribution').Properties.DistributionConfig.Origins.find(origin=>origin.Id==='api');assert.equal(apiOrigin.OriginCustomHeaders[0].HeaderName,'x-beter-origin-secret');
});
test('static content is private and API forwarding never caches accounts',()=>{
  const bucket=resource('AssetsBucket').Properties;assert.ok(Object.values(bucket.PublicAccessBlockConfiguration).every(value=>value===true));assert.equal(resource('AssetsOac').Properties.OriginAccessControlConfig.SigningBehavior,'always');const distribution=resource('Distribution').Properties.DistributionConfig;assert.deepEqual(distribution.Enabled,{'Fn::If':['IsFreeGateway',false,true]});assert.equal(distribution.DefaultCacheBehavior.ViewerProtocolPolicy,'redirect-to-https');const api=distribution.CacheBehaviors.find(behavior=>behavior.PathPattern==='/api/*');assert.equal(api.CachePolicyId,'4135ea2d-6df8-44a3-9df3-4b5a84be39ad');assert.equal(resource('ApiForwardingPolicy').Properties.OriginRequestPolicyConfig.CookiesConfig.CookieBehavior,'all');assert.equal(resource('ApiForwardingPolicy').Properties.OriginRequestPolicyConfig.QueryStringsConfig.QueryStringBehavior,'all');
});
test('database has no public ingress and has bounded encrypted capacity and retention',()=>{
  const cluster=resource('DatabaseCluster').Properties;assert.equal(cluster.Engine,'aurora-postgresql');assert.equal(cluster.EnableHttpEndpoint,true);assert.equal(cluster.StorageEncrypted,true);assert.ok(cluster.ServerlessV2ScalingConfiguration);assert.equal(resource('DatabaseWriter').Properties.PubliclyAccessible,false);assert.deepEqual(resource('DatabaseSecurityGroup').Properties.SecurityGroupIngress,[]);assert.ok(cluster.BackupRetentionPeriod);assert.equal(resource('DatabaseCluster').DeletionPolicy,'Snapshot');assert.equal(Object.values(template.Resources).some(r=>r.Type==='AWS::EC2::NatGateway'),false);
});
test('runtime uses supported Node, bounded functions, and cannot read database master credentials',()=>{
  const api=resource('ApiFunction').Properties;assert.equal(api.Runtime,'nodejs24.x');assert.ok(api.ReservedConcurrentExecutions);assert.ok(api.Timeout<=30);const policy=JSON.stringify(resource('RuntimeRole').Properties.Policies);assert.doesNotMatch(policy,/MasterUserSecret/);assert.doesNotMatch(policy,/'\*'/);assert.match(policy,/rds-data:ExecuteStatement/);assert.match(policy,/RuntimeSecretArn/);assert.ok(resource('WorkerFunction').Properties.ReservedConcurrentExecutions);assert.ok(resource('MonitorFunction').Properties.ReservedConcurrentExecutions);
});
test('Cognito is case-insensitive, immutable-email, gated, and uses signup codes',()=>{
  const pool=resource('UserPool').Properties;assert.deepEqual(pool.UsernameAttributes,['email']);assert.equal(pool.UsernameConfiguration.CaseSensitive,false);assert.equal(pool.Schema.find(field=>field.Name==='email').Mutable,false);assert.equal(pool.VerificationMessageTemplate['Fn::If']?.[2]?.DefaultEmailOption,'CONFIRM_WITH_CODE');assert.ok(pool.LambdaConfig.PreSignUp);resource('UserPoolDomain');const client=resource('UserPoolClient').Properties;assert.equal(client.GenerateSecret,false);assert.ok(client.ExplicitAuthFlows.includes('ALLOW_USER_PASSWORD_AUTH'));assert.equal(client.RefreshTokenRotation.Feature,'DISABLED');
});
test('scheduling waits for migrations, has scoped invoke rights, and readiness/failure alarms',()=>{
  assert.equal(template.Parameters.ScheduleState.Default,'DISABLED');for(const name of ['ProcessSchedule','MonitorSchedule'])assert.ok(resource(name).Properties.Target.RetryPolicy);const policies=JSON.stringify(resource('SchedulerRole').Properties.Policies);assert.match(policies,/WorkerFunction/);assert.match(policies,/MonitorFunction/);assert.doesNotMatch(policies,/Resource":"\*"/);assert.equal(resource('WorkerHeartbeatAlarm').Properties.TreatMissingData,'breaching');assert.equal(resource('ReadinessAlarm').Properties.TreatMissingData,'breaching');resource('ApiErrorsAlarm');
});
test('managed resources require reviewed credits and keep the ten-dollar net-cash alert ceiling explicit',()=>{
  resource('DatabaseCluster');assert.equal(template.Parameters.CreditsVerified.Default,'false');assert.equal(template.Parameters.MonthlyCashCeilingUsd.Default,10);assert.ok(template.Rules.VerifiedFunding);assert.equal(resource('CashBudget').Properties.Budget.CostTypes.IncludeCredit,true);assert.equal(resource('CashBudget').Properties.Budget.BudgetLimit.Amount.Ref,'MonthlyCashCeilingUsd');assert.ok(template.Rules.PublicLaunchChecks);
});
function edge(overrides={}){
  const value='Basic '+Buffer.from('tester:a-long-private-staging-password').toString('base64');
  const code=resource('StagingGate').Properties.FunctionCode['Fn::Sub'].replaceAll('${CreditCutoffAt}',overrides.cutoff||'2099-01-01T00:00:00').replaceAll('${LaunchOpen}',overrides.open?'true':'false').replaceAll('${StagingAuthorizationHash}',createHash('sha256').update(value).digest('hex'));
  return{value,handler:runInNewContext(code+'\nhandler;',{require})};
}
test('edge gate hashes browser/machine access and strips gate credentials before origin',()=>{
  const {handler,value}=edge();assert.equal(handler({viewer:{ip:'203.0.113.2'},request:{headers:{}}}).statusCode,401);
  const browser=handler({viewer:{ip:'203.0.113.2'},request:{headers:{authorization:{value},'x-beter-viewer-ip':{value:'forged'}}}});assert.equal(browser.headers.authorization,undefined);assert.equal(browser.headers['x-beter-viewer-ip'].value,'203.0.113.2');
  const machine=handler({viewer:{ip:'203.0.113.2'},request:{headers:{authorization:{value:'Bearer worker'},'x-beter-staging-access':{value}}}});assert.equal(machine.headers.authorization.value,'Bearer worker');assert.equal(machine.headers['x-beter-staging-access'],undefined);
});
test('edge funding cutoff overrides public launch and never reaches an origin',()=>{
  for(const cutoff of ['2000-01-01T00:00:00','invalid']){const {handler}=edge({open:true,cutoff});const response=handler({viewer:{ip:'203.0.113.2'},request:{headers:{}}});assert.equal(response.statusCode,503);assert.match(response.body,/funding review/);}
});

test('low-quota accounts opt in to concurrency reservations only after a quota review',()=>{
  assert.equal(template.Parameters.EnableReservedConcurrency?.Default,'false');
  assert.deepEqual(template.Conditions.UseReservedConcurrency,{'Fn::Equals':[{Ref:'EnableReservedConcurrency'},'true']});
  for(const [name,count] of [['PreSignupFunction',1],['ApiFunction',2],['WorkerFunction',1],['MonitorFunction',1]]){
    assert.deepEqual(resource(name).Properties.ReservedConcurrentExecutions,{'Fn::If':['UseReservedConcurrency',count,{Ref:'AWS::NoValue'}]});
  }
  assert.ok(resource('ApiStage').Properties.DefaultRouteSettings.ThrottlingBurstLimit<=20);
  assert.ok(resource('ApiStage').Properties.DefaultRouteSettings.ThrottlingRateLimit<=10);
});

test('both API behaviors reference the documented AWS managed CachingDisabled policy',()=>{
  // AWS Developer Guide: using-managed-cache-policies.html#managed-cache-policy-caching-disabled
  const behaviors=resource('Distribution').Properties.DistributionConfig.CacheBehaviors;
  assert.deepEqual(behaviors.map(behavior=>behavior.PathPattern).sort(),['/api','/api/*']);
  for(const behavior of behaviors)assert.equal(behavior.CachePolicyId,'4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
});

test('free HTTP API hosting keeps static delivery outside database permissions and disables the legacy-TLS distribution',()=>{
 assert.equal(template.Parameters.FreeGatewayHosting?.Default,'true');assert.deepEqual(template.Conditions.IsFreeGateway,{'Fn::Equals':[{Ref:'FreeGatewayHosting'},'true']});
 const fn=resource('StaticFunction');assert.equal(fn.Properties.Handler,'index.assetsHandler');assert.equal(fn.Condition,'IsFreeGateway');assert.equal(fn.Properties.Environment.Variables.BETER_STAGING_AUTH_HASH.Ref,'StagingAuthorizationHash');assert.equal(fn.Properties.Environment.Variables.BETER_LAUNCH_OPEN.Ref,'LaunchOpen');assert.equal(fn.Properties.Environment.Variables.BETER_FUNDING_CUTOFF_AT.Ref,'CreditCutoffAt');
 const role=JSON.stringify(resource('StaticRole').Properties.Policies);assert.doesNotMatch(role,/rds|secret|cognito|s3:/i);assert.match(role,/logs:PutLogEvents/);
 const routes=Object.values(template.Resources).filter(r=>r.Type==='AWS::ApiGatewayV2::Route');for(const key of ['GET /','HEAD /','GET /{proxy+}','HEAD /{proxy+}','ANY /api/{proxy+}'])assert.ok(routes.some(route=>route.Properties.RouteKey===key),key);
 assert.deepEqual(resource('ApiRoute').Properties.RouteKey,{'Fn::If':['IsFreeGateway','ANY /api','$default']});assert.equal(resource('ApiFunction').Properties.Environment.Variables.BETER_PUBLIC_GATEWAY['Fn::If'][0],'IsFreeGateway');assert.equal(template.Outputs.PublicGatewayOrigin.Value['Fn::GetAtt'][0],'HttpApi');
});
test('free generated hostname bypasses only paid-domain assertions while preserving all other public-launch gates',()=>{
 const assertions=template.Rules.PublicLaunchChecks.Assertions;for(const field of ['CustomDomainName','AcmCertificateArn']){const assertion=assertions.find(a=>a.AssertDescription==='Public release requires '+field+'.');assert.ok(assertion.Assert['Fn::Or'],'A free-hostname alternative must exist for '+field);assert.deepEqual(assertion.Assert['Fn::Or'][0],{'Fn::Equals':[{Ref:'FreeGatewayHosting'},'true']});}
 for(const field of ['SesSourceArn','PrivacyUrl','AccountDeletionUrl','SupportUrl','AlertEmail']){const assertion=assertions.find(a=>a.AssertDescription==='Public release requires '+field+'.');assert.equal(assertion.Assert['Fn::Or'],undefined);}
});
test('AWS sample timing stays fixed across API worker and monitor cold starts with a bounded settlement window',()=>{
 assert.equal(template.Parameters.SampleStartAt?.Default,'');assert.equal(template.Parameters.SampleDurationSeconds?.Default,10800);assert.equal(template.Parameters.SampleDurationSeconds?.MinValue,60);assert.equal(template.Parameters.SampleDurationSeconds?.MaxValue,10800);
 for(const name of ['ApiFunction','WorkerFunction','MonitorFunction']){const env=resource(name).Properties.Environment.Variables;assert.deepEqual(env.BETER_SAMPLE_START_AT,{'Fn::If':['IsSampleData',{Ref:'SampleStartAt'},{Ref:'AWS::NoValue'}]});assert.deepEqual(env.BETER_SAMPLE_DURATION_SECONDS,{'Fn::If':['IsSampleData',{Ref:'SampleDurationSeconds'},{Ref:'AWS::NoValue'}]});}
});

test('live provider functions omit every sample override instead of passing empty or default values',()=>{
 assert.deepEqual(template.Conditions.IsSampleData,{'Fn::Equals':[{Ref:'DataMode'},'sample']});
 for(const name of ['ApiFunction','WorkerFunction','MonitorFunction'])for(const key of ['BETER_SAMPLE_START_AT','BETER_SAMPLE_DURATION_SECONDS','BETER_SAMPLE_REPEAT_SECONDS'])assert.deepEqual(resource(name).Properties.Environment.Variables[key]['Fn::If']?.[2],{Ref:'AWS::NoValue'});
});

test('signup codes use the default Cognito message unless verified SES permits a custom template',()=>{
 const verification=resource('UserPool').Properties.VerificationMessageTemplate;
 assert.ok(verification['Fn::If'],'Sender-aware verification templates must be explicit.');
 const [condition,ses,standard]=verification['Fn::If'];assert.equal(condition,'HasSes');assert.deepEqual(standard,{DefaultEmailOption:'CONFIRM_WITH_CODE'});assert.equal(ses.DefaultEmailOption,'CONFIRM_WITH_CODE');assert.match(ses.EmailMessage,/\{####\}/);assert.ok(ses.EmailSubject);assert.equal(ses.EmailMessageByLink,undefined);assert.equal(ses.EmailSubjectByLink,undefined);
 const client=resource('UserPoolClient').Properties;assert.equal(client.AllowedOAuthFlows,undefined);assert.equal(client.CallbackURLs,undefined);
});
test('all runtime functions share the configured private support notification destination',()=>{
 for(const name of ['ApiFunction','WorkerFunction','MonitorFunction'])assert.deepEqual(template.Resources[name].Properties.Environment.Variables.BETER_SUPPORT_TOPIC_ARN,{Ref:'NotificationTopic'});
});
test('private support notifications use a rotating symmetric customer key without replacing the topic',()=>{
 const key=resource('NotificationKey');assert.equal(key.Type,'AWS::KMS::Key');assert.equal(key.Properties.EnableKeyRotation,true);assert.equal(key.Properties.KeySpec,'SYMMETRIC_DEFAULT');assert.equal(key.Properties.KeyUsage,'ENCRYPT_DECRYPT');assert.deepEqual(resource('NotificationTopic').Properties.KmsMasterKeyId,{'Fn::GetAtt':['NotificationKey','Arn']});assert.equal(resource('NotificationTopic').Properties.TopicName,undefined);
});
test('notification key usage is account scoped for stack alarms and SNS-only for the runtime',()=>{
 const statements=resource('NotificationKey').Properties.KeyPolicy.Statement,delegation=statements.find(s=>s.Sid==='EnableAccountIamDelegation'),cloudwatch=statements.find(s=>s.Principal?.Service==='cloudwatch.amazonaws.com');assert.deepEqual(delegation.Principal.AWS,{'Fn::Sub':'arn:${AWS::Partition}:iam::${AWS::AccountId}:root'});assert.deepEqual(cloudwatch.Action,['kms:GenerateDataKey*','kms:Decrypt']);assert.deepEqual(cloudwatch.Condition.StringEquals['aws:SourceAccount'],{Ref:'AWS::AccountId'});assert.deepEqual(cloudwatch.Condition.ArnLike['aws:SourceArn'],['WorkerHeartbeatAlarm','ReadinessAlarm','ApiErrorsAlarm'].map(name=>({'Fn::Sub':'arn:${AWS::Partition}:cloudwatch:${AWS::Region}:${AWS::AccountId}:alarm:${AWS::StackName}-'+name+'-*'})));assert.ok(statements.every(s=>s.Principal!=='*'));
 const references=[];function refs(value){if(!value||typeof value!=='object')return;if(value.Ref)references.push(value.Ref);if(value['Fn::GetAtt'])references.push(value['Fn::GetAtt'][0]);for(const child of Object.values(value))refs(child);}refs(resource('NotificationKey'));assert.ok(!references.some(name=>['NotificationTopic','RuntimeRole','WorkerHeartbeatAlarm','ReadinessAlarm','ApiErrorsAlarm'].includes(name)),'Key policy must not create a topic/role/alarm dependency cycle.');
 const permission=resource('RuntimeRole').Properties.Policies.flatMap(policy=>policy.PolicyDocument.Statement).find(s=>Array.isArray(s.Action)&&s.Action.includes('kms:Decrypt'));assert.deepEqual(permission.Resource,{'Fn::GetAtt':['NotificationKey','Arn']});assert.deepEqual(permission.Action,['kms:GenerateDataKey*','kms:Decrypt']);assert.deepEqual(permission.Condition.StringEquals['kms:ViaService'],{'Fn::Sub':'sns.${AWS::Region}.amazonaws.com'});assert.deepEqual(permission.Condition.StringEquals['kms:CallerAccount'],{Ref:'AWS::AccountId'});
});

test('private sample preview can repeat bounded rounds across all runtime functions without live overrides',()=>{
 assert.deepEqual(template.Parameters.SampleRepeatSeconds,{Type:'Number',Default:21600,MinValue:600,MaxValue:86400,Description:'Private staging sample round interval in seconds; runtime requires at least duration plus 60 seconds. Ignored by live provider.'});
 for(const name of ['ApiFunction','WorkerFunction','MonitorFunction'])assert.deepEqual(resource(name).Properties.Environment.Variables.BETER_SAMPLE_REPEAT_SECONDS,{'Fn::If':['IsSampleData',{Ref:'SampleRepeatSeconds'},{Ref:'AWS::NoValue'}]});
 assert.equal(template.Parameters.LaunchOpen.Default,'false');assert.ok(template.Rules.PublicLaunchChecks);
});
