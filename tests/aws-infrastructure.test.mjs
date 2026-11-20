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
  const bucket=resource('AssetsBucket').Properties;assert.ok(Object.values(bucket.PublicAccessBlockConfiguration).every(value=>value===true));assert.equal(resource('AssetsOac').Properties.OriginAccessControlConfig.SigningBehavior,'always');const distribution=resource('Distribution').Properties.DistributionConfig;assert.equal(distribution.Enabled,true);assert.equal(distribution.DefaultCacheBehavior.ViewerProtocolPolicy,'redirect-to-https');const api=distribution.CacheBehaviors.find(behavior=>behavior.PathPattern==='/api/*');assert.equal(api.CachePolicyId,'413f1603-3b52-45a9-9a26-24a70246d627');assert.equal(resource('ApiForwardingPolicy').Properties.OriginRequestPolicyConfig.CookiesConfig.CookieBehavior,'all');assert.equal(resource('ApiForwardingPolicy').Properties.OriginRequestPolicyConfig.QueryStringsConfig.QueryStringBehavior,'all');
});
test('database has no public ingress and has bounded encrypted capacity and retention',()=>{
  const cluster=resource('DatabaseCluster').Properties;assert.equal(cluster.Engine,'aurora-postgresql');assert.equal(cluster.EnableHttpEndpoint,true);assert.equal(cluster.StorageEncrypted,true);assert.ok(cluster.ServerlessV2ScalingConfiguration);assert.equal(resource('DatabaseWriter').Properties.PubliclyAccessible,false);assert.deepEqual(resource('DatabaseSecurityGroup').Properties.SecurityGroupIngress,[]);assert.ok(cluster.BackupRetentionPeriod);assert.equal(resource('DatabaseCluster').DeletionPolicy,'Snapshot');assert.equal(Object.values(template.Resources).some(r=>r.Type==='AWS::EC2::NatGateway'),false);
});
test('runtime uses supported Node, bounded functions, and cannot read database master credentials',()=>{
  const api=resource('ApiFunction').Properties;assert.equal(api.Runtime,'nodejs24.x');assert.ok(api.ReservedConcurrentExecutions);assert.ok(api.Timeout<=30);const policy=JSON.stringify(resource('RuntimeRole').Properties.Policies);assert.doesNotMatch(policy,/MasterUserSecret/);assert.doesNotMatch(policy,/'\*'/);assert.match(policy,/rds-data:ExecuteStatement/);assert.match(policy,/RuntimeSecretArn/);assert.ok(resource('WorkerFunction').Properties.ReservedConcurrentExecutions);assert.ok(resource('MonitorFunction').Properties.ReservedConcurrentExecutions);
});
test('Cognito is case-insensitive, immutable-email, gated, and uses link confirmation',()=>{
  const pool=resource('UserPool').Properties;assert.deepEqual(pool.UsernameAttributes,['email']);assert.equal(pool.UsernameConfiguration.CaseSensitive,false);assert.equal(pool.Schema.find(field=>field.Name==='email').Mutable,false);assert.equal(pool.VerificationMessageTemplate.DefaultEmailOption,'CONFIRM_WITH_LINK');assert.ok(pool.LambdaConfig.PreSignUp);resource('UserPoolDomain');const client=resource('UserPoolClient').Properties;assert.equal(client.GenerateSecret,false);assert.ok(client.ExplicitAuthFlows.includes('ALLOW_USER_PASSWORD_AUTH'));assert.equal(client.RefreshTokenRotation.Feature,'DISABLED');
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
