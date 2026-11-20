import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const exec=promisify(execFile);
const services=['Amazon Relational Database Service','Amazon Cognito','Amazon CloudFront','Amazon Simple Storage Service','AWS Lambda','Amazon API Gateway','AWS Secrets Manager','AmazonCloudWatch'];
export function createStagingPlan({accountId,expectedAccountId,credits,now=new Date(),region='us-west-2'}){
 if(!/^\d{12}$/.test(accountId)||accountId!==expectedAccountId)throw Error('The connected AWS account must match the reviewed account.');
 const cutoff=new Date(now.getTime()+7*86400000);
 const eligible=credits.filter(c=>c.creditStatus==='ENABLED'&&Date.parse(c.endDate)>cutoff.getTime()+86400000&&c.estimatedAmount?.currencyCode==='USD'&&Number(c.estimatedAmount.currencyAmount)>0);
 const total=eligible.reduce((sum,c)=>sum+Number(c.estimatedAmount.currencyAmount),0);
 if(total<25||!services.every(s=>eligible.some(c=>c.applicableProductNames?.includes(s))))throw Error('Verify sufficient eligible AWS credits and expiry before provisioning.');
 return{schemaVersion:1,accountId,region,stackName:'beter-staging',launchOpen:false,schedules:'DISABLED',monthlyCashCeilingUsd:10,estimatedCreditUsd:Math.round(total*100)/100,cutoffAt:cutoff.toISOString().slice(0,19),verifiedAt:now.toISOString(),creditExpiry:eligible.map(c=>new Date(c.endDate).toISOString()).sort()[0],billingNote:'Alerts and review cutoff are not a hard billing cap; storage, secrets, and retained backups can continue to incur charges.'};
}
export function createAwsControl({binary=process.env.AWS_BIN||'aws',env=process.env,privateDir=resolve('.data/aws-deploy'),execute=exec,writePrivate,removePrivate=path=>rm(path,{force:true})}={}){
 const save=writePrivate||async function(path,body){await mkdir(privateDir,{recursive:true,mode:0o700});await writeFile(path,body,{mode:0o600});};
 async function call(service,operation,input={},extra=[]){
  const file=join(privateDir,randomUUID()+'.json');
  try{
   await save(file,JSON.stringify(input));
   const args=[service,operation,'--cli-input-json','file://'+file,'--output','json','--no-cli-pager',...extra];
   const result=await execute(binary,args,{env:{...env,AWS_PAGER:'',AWS_REGION:env.AWS_REGION||'us-west-2'},maxBuffer:16*1024*1024,timeout:120000});
   return result.stdout.trim()?JSON.parse(result.stdout):{};
  }catch(error){
   const code=String(error?.stderr||'').match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1];
   throw Object.assign(Error('AWS '+service+'/'+operation+' failed'+(code?' ('+code+')':'')+'. Check the account, region, and private AWS service diagnostics.'),{code});
  }finally{await removePrivate(file);}
 }
 return{call};
}
export async function prepareDeployment({control=createAwsControl(),accountId=process.env.BETER_AWS_ACCOUNT_ID,privateDir=resolve('.data/aws-deploy'),now=new Date()}={}){
 const identity=await control.call('sts','get-caller-identity');
 const credit=await control.call('billing','get-credits',{accountId:identity.Account,startDate:now.toISOString().slice(0,7)+'-01T00:00:00Z'},['--region','us-east-1']);
 const plan=createStagingPlan({accountId:identity.Account,expectedAccountId:accountId,credits:credit.credits||[],now});
 await mkdir(privateDir,{recursive:true,mode:0o700});await writeFile(join(privateDir,'plan.json'),JSON.stringify(plan,null,2)+'\n',{mode:0o600});return plan;
}
export async function provisionDeployment({control=createAwsControl(),privateDir=resolve('.data/aws-deploy'),manifestPath=resolve('artifacts/aws/manifest.json'),alertEmail=process.env.BETER_ALERT_EMAIL||'',testEmail=process.env.BETER_TEST_EMAIL||''}={}){
 try{await access(join(privateDir,'state.json'));throw Error('An earlier AWS deployment has private recovery state. Inspect status and resume that deployment.');}catch(error){if(error.code!=='ENOENT')throw error;}
 const plan=JSON.parse(await readFile(join(privateDir,'plan.json'),'utf8'));
 if(Date.now()-Date.parse(plan.verifiedAt)>86400000||plan.launchOpen!==false||plan.schedules!=='DISABLED'||Date.parse(plan.cutoffAt+'Z')<=Date.now())throw Error('Refresh the closed staging funding plan before creating resources.');
 const identity=await control.call('sts','get-caller-identity');if(identity.Account!==plan.accountId)throw Error('AWS account changed since funding review.');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 for(const artifact of [manifest.lambda,manifest.template]){const bytes=await readFile(artifact.path);if(createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw Error('The AWS artifact changed after packaging.');}
 const token=()=>randomBytes(48).toString('base64url');
 const runtime={sessionSecret:token(),jobSecret:token(),originSecret:token(),oddsApiKey:''};
 const stagingAccess='Basic '+Buffer.from('beter:'+token()).toString('base64');
 const secretName='beter-staging-runtime-'+randomBytes(4).toString('hex');
 // Persist private recovery state before any mutation; do not put credentials in argv or logs.
 const state={...plan,runtime,stagingAccess,secretName};
 const save=()=>writeFile(join(privateDir,'state.json'),JSON.stringify(state,null,2)+'\n',{mode:0o600});await save();
 const bucket='beter-staging-artifacts-'+plan.accountId+'-'+randomBytes(4).toString('hex');state.artifactsBucket=bucket;await save();
 const tags=[{Key:'Application',Value:'Beter'},{Key:'Environment',Value:'staging'}];
 await control.call('s3api','create-bucket',{Bucket:bucket,CreateBucketConfiguration:{LocationConstraint:plan.region}});
 await control.call('s3api','put-public-access-block',{Bucket:bucket,PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}});
 await control.call('s3api','put-bucket-encryption',{Bucket:bucket,ServerSideEncryptionConfiguration:{Rules:[{ApplyServerSideEncryptionByDefault:{SSEAlgorithm:'AES256'}}]}});
 await control.call('s3api','put-bucket-tagging',{Bucket:bucket,Tagging:{TagSet:tags}});
 const secret=await control.call('secretsmanager','create-secret',{Name:secretName,SecretString:JSON.stringify(runtime),Tags:tags});state.runtimeSecretArn=secret.ARN;await save();
 const key='lambda/'+manifest.lambda.sha256+'.zip';await control.call('s3api','put-object',{Bucket:bucket,Key:key,ServerSideEncryption:'AES256'},['--body',manifest.lambda.path]);
 const parameters={AppName:'beter',Environment:'staging',LaunchOpen:'false',ScheduleState:'DISABLED',CreditsVerified:'true',CreditCutoffAt:plan.cutoffAt,MonthlyCashCeilingUsd:'10',StagingAuthorizationHash:createHash('sha256').update(stagingAccess).digest('hex'),TestEmailAllowlist:testEmail,SiteOrigin:'https://pending.invalid',RuntimeSecretArn:secret.ARN,CodeS3Bucket:bucket,CodeS3Key:key,AlertEmail:alertEmail,DataMode:'sample'};
 state.parameters=parameters;await save();
 const result=await control.call('cloudformation','create-stack',{StackName:plan.stackName,TemplateBody:await readFile(manifest.template.path,'utf8'),Parameters:Object.entries(parameters).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})),Capabilities:['CAPABILITY_IAM'],Tags:tags,EnableTerminationProtection:true});state.stackId=result.StackId;await save();
 return{stackName:plan.stackName,stackId:result.StackId,cutoffAt:plan.cutoffAt,launchOpen:false,schedules:'DISABLED'};
}
export async function deploymentStatus({control=createAwsControl(),privateDir=resolve('.data/aws-deploy')}={}){
 const state=JSON.parse(await readFile(join(privateDir,'state.json'),'utf8'));const result=await control.call('cloudformation','describe-stacks',{StackName:state.stackId||state.stackName});const stack=result.Stacks[0];
 const outputs=Object.fromEntries((stack.Outputs||[]).map(x=>[x.OutputKey,x.OutputValue]));state.outputs=outputs;await writeFile(join(privateDir,'state.json'),JSON.stringify(state,null,2)+'\n',{mode:0o600});
 return{stackName:state.stackName,status:stack.StackStatus,...(outputs.CloudFrontDomain?{url:'https://'+outputs.CloudFrontDomain}:{}),cutoffAt:state.cutoffAt};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const action=process.argv[2];const result=action==='prepare'?await prepareDeployment():action==='provision'?await provisionDeployment():action==='status'?await deploymentStatus():null;if(!result)throw Error('Choose prepare, provision, or status.');console.log(JSON.stringify({ok:true,...result}));}catch(error){console.error(JSON.stringify({ok:false,message:error.message}));process.exitCode=1;}
}
