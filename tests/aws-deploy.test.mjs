import test from 'node:test';import assert from 'node:assert/strict';
const module=await import('../scripts/aws-deploy.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
test('funded staging plan checks actual account, credit eligibility and review cutoff',()=>{
 assert.equal(typeof module.createStagingPlan,'function');const now=new Date('2026-11-20T20:00:00Z');
 const credits=[{creditStatus:'ENABLED',endDate:'2027-09-30T23:59:59Z',estimatedAmount:{currencyAmount:'217.06',currencyCode:'USD'},applicableProductNames:['Amazon Relational Database Service','Amazon Cognito','Amazon CloudFront','Amazon Simple Storage Service','AWS Lambda','Amazon API Gateway','AWS Secrets Manager','AmazonCloudWatch']}];
 const plan=module.createStagingPlan({accountId:'025925168269',expectedAccountId:'025925168269',credits,now});assert.equal(plan.launchOpen,false);assert.equal(plan.schedules,'DISABLED');assert.equal(plan.estimatedCreditUsd,217.06);assert.equal(plan.monthlyCashCeilingUsd,10);assert.equal(plan.cutoffAt,'2026-11-27T20:00:00');assert.equal(plan.region,'us-west-2');
 assert.throws(()=>module.createStagingPlan({accountId:'999999999999',expectedAccountId:'025925168269',credits,now}),/account/i);
 assert.throws(()=>module.createStagingPlan({accountId:'025925168269',expectedAccountId:'025925168269',credits:[],now}),/credit/i);
 assert.throws(()=>module.createStagingPlan({accountId:'025925168269',expectedAccountId:'025925168269',credits:[{...credits[0],creditStatus:'DISABLED'}],now}),/credit/i);
 assert.throws(()=>module.createStagingPlan({accountId:'025925168269',expectedAccountId:'025925168269',credits:[{...credits[0],endDate:'2026-11-21T00:00:00Z'}],now}),/expiry|credit/i);
});
test('private CLI inputs keep generated credentials out of arguments and diagnostics',async()=>{
 assert.equal(typeof module.createAwsControl,'function');let captured;const files=[];const removed=[];
 const control=module.createAwsControl({binary:'/aws',env:{AWS_PROFILE:'beter-staging',AWS_REGION:'us-west-2'},privateDir:'/tmp/private-fixture',writePrivate:async(path,body)=>{files.push({path,body});},removePrivate:async path=>removed.push(path),execute:async(binary,args,options)=>{captured={binary,args,options};return{stdout:'{"ARN":"secret-reference"}'};}});
 const out=await control.call('secretsmanager','create-secret',{Name:'beter-staging-runtime',SecretString:'private-secret-value'});assert.equal(out.ARN,'secret-reference');assert.equal(files.length,1);assert.match(files[0].body,/private-secret-value/);assert.doesNotMatch(JSON.stringify(captured.args),/private-secret-value/);assert.equal(removed.length,1);
 const failing=module.createAwsControl({binary:'/aws',privateDir:'/tmp/private-fixture',writePrivate:async()=>{},removePrivate:async()=>{},execute:async()=>{throw Error('private-secret-value');}});await assert.rejects(()=>failing.call('secretsmanager','get-secret-value',{SecretId:'private'}),e=>!e.message.includes('private-secret-value'));
});
