import {readFile,writeFile,mkdir,rename,chmod,lstat,realpath,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createAwsControl} from './aws-deploy.mjs';
const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const allowed=new Set(['ScheduleState','SampleStartAt','SampleDurationSeconds','SupportUrl','PrivacyUrl','AccountDeletionUrl']);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const requireValue=(value,code,message)=>{if(!value)fail(code,message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function canonical(value){return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;}
function isoTimestamp(value){const time=Date.parse(value);return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(time)&&new Date(time).toISOString().slice(0,19)===value.slice(0,19);}
function siteOrigin(parameters,outputs,region){
  if(parameters.FreeGatewayHosting==='true'){
    const value=outputs.PublicGatewayOrigin;let url;try{url=new URL(value);}catch{fail('UPDATE_ORIGIN_REQUIRED','The selected HTTPS gateway origin is missing.');}
    requireValue(url.protocol==='https:'&&!url.port&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash&&new RegExp('^[a-z0-9]+\\.execute-api\\.'+region.replaceAll('-','\\-')+'\\.amazonaws\\.com(?:\\.cn)?$').test(url.hostname),'UPDATE_ORIGIN_REQUIRED','The selected HTTPS gateway origin is invalid.');return url.origin;
  }
  requireValue(parameters.FreeGatewayHosting==='false'&&/^[a-z0-9]+\.cloudfront\.net$/.test(outputs.CloudFrontDomain||''),'UPDATE_ORIGIN_REQUIRED','The selected HTTPS CloudFront origin is missing.');return'https://'+outputs.CloudFrontDomain;
}
async function saveState(privateDir,path,state){
  const temporary=join(privateDir,randomUUID()+'.state.json');
  try{await mkdir(privateDir,{recursive:true,mode:0o700});await chmod(privateDir,0o700);await writeFile(temporary,JSON.stringify(state,null,2)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,path);}
  catch{await rm(temporary,{force:true}).catch(()=>{});fail('UPDATE_STATE_SAVE_FAILED','The staging update started, but private recovery state could not be saved. Inspect the stack before retrying.');}
}
async function checkQuiescence({url,state,fetchImpl,timeoutMs}){
  requireValue(typeof fetchImpl==='function'&&Number.isSafeInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=60000&&typeof state.runtime?.jobSecret==='string'&&state.runtime.jobSecret.length>=32&&typeof state.stagingAccess==='string'&&/^Basic [A-Za-z0-9+/]+={0,2}$/.test(state.stagingAccess),'UPDATE_QUIESCENCE_REQUIRED','Protected health credentials and a valid timeout are required for a sample change.');
  const controller=new AbortController();let timer;
  try{
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error());},timeoutMs);});
    const check=(async()=>{
      const response=await fetchImpl(url+'/api/health/details',{method:'GET',headers:{authorization:'Bearer '+state.runtime.jobSecret,'x-beter-staging-access':state.stagingAccess},redirect:'manual',signal:controller.signal});
      requireValue(response.status===200&&/^application\/json\b/i.test(response.headers.get('content-type')||'')&&Number(response.headers.get('content-length')||0)<=131072,'UPDATE_QUIESCENCE_REQUIRED','Protected health must confirm zero open bets before a sample change.');
      const reader=response.body?.getReader();let length=0,text='';const decoder=new TextDecoder();
      if(reader)try{for(;;){const result=await reader.read();if(result.done)break;length+=result.value.byteLength;requireValue(length<=131072,'UPDATE_QUIESCENCE_REQUIRED','Protected health must return a bounded response.');text+=decoder.decode(result.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
      requireValue(JSON.parse(text).open_bets===0,'UPDATE_QUIESCENCE_REQUIRED','Protected health must confirm zero open bets before a sample change.');
    })();
    await Promise.race([check,deadline]);
  }catch{fail('UPDATE_QUIESCENCE_REQUIRED','A protected health check did not confirm zero open bets. Keep the current sample epoch.');}
  finally{clearTimeout(timer);controller.abort();}
}

/** Update reviewed code/template bytes while preserving a closed staging deployment. */
export async function updateDeployment({privateDir=join(projectRoot,'.data/aws-deploy'),manifestPath=join(projectRoot,'artifacts/aws/manifest.json'),control=createAwsControl({privateDir}),overrides={},quiescent=false,fetchImpl=globalThis.fetch,now=new Date(),timeoutMs=15000}={}){
  try{
    requireValue(overrides&&typeof overrides==='object'&&!Array.isArray(overrides)&&Object.keys(overrides).every(key=>allowed.has(key)),'UPDATE_OVERRIDE_INVALID','Only reviewed staging schedule, sample, and support URL overrides are allowed.');
    const patches=Object.fromEntries(Object.entries(overrides).map(([key,value])=>[key,String(value)]));
    if(Object.hasOwn(patches,'ScheduleState'))requireValue(['ENABLED','DISABLED'].includes(patches.ScheduleState),'UPDATE_OVERRIDE_INVALID','The schedule override must be ENABLED or DISABLED.');
    if(Object.hasOwn(patches,'SampleStartAt'))requireValue(isoTimestamp(patches.SampleStartAt),'UPDATE_OVERRIDE_INVALID','The sample start override requires a valid UTC ISO timestamp.');
    if(Object.hasOwn(patches,'SampleDurationSeconds'))requireValue(/^\d+$/.test(patches.SampleDurationSeconds)&&Number(patches.SampleDurationSeconds)>=60&&Number(patches.SampleDurationSeconds)<=10800,'UPDATE_OVERRIDE_INVALID','The sample duration override must be an integer from 60 to 10800 seconds.');
    const sampleChange=Object.hasOwn(patches,'SampleStartAt')||Object.hasOwn(patches,'SampleDurationSeconds');
    requireValue(!sampleChange||quiescent===true,'UPDATE_QUIESCENCE_REQUIRED','Explicit quiescent confirmation is required before a sample override.');
    const statePath=join(privateDir,'state.json'),info=await lstat(statePath);
    requireValue(info.isFile()&&(info.mode&0o777)===0o600,'UPDATE_PRIVATE_STATE_REQUIRED','The deployment state must be a private regular file with owner-only permissions.');
    const state=JSON.parse(await readFile(statePath,'utf8')),manifest=JSON.parse(await readFile(manifestPath,'utf8')),p=state.parameters;
    requireValue(state.schemaVersion===1&&state.stackName==='beter-staging'&&state.launchOpen===false&&/^\d{12}$/.test(state.accountId||'')&&/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(state.region||'')&&p?.Environment==='staging'&&p.LaunchOpen==='false'&&p.CreditsVerified==='true'&&['ENABLED','DISABLED'].includes(p.ScheduleState)&&state.schedules===p.ScheduleState,'UPDATE_STAGING_REQUIRED','A complete reviewed closed staging deployment state is required.');
    const stackArn=new RegExp('^arn:(aws|aws-us-gov|aws-cn):cloudformation:'+state.region+':'+state.accountId+':stack/beter-staging/[A-Za-z0-9-]+$');
    requireValue(stackArn.test(state.stackId||'')&&/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(state.artifactsBucket||'')&&p.CodeS3Bucket===state.artifactsBucket,'UPDATE_STAGING_REQUIRED','The closed staging stack and artifact bucket must match private recovery state.');
    requireValue(now instanceof Date&&Number.isFinite(now.getTime())&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(state.cutoffAt||'')&&p.CreditCutoffAt===state.cutoffAt&&Date.parse(state.cutoffAt+'Z')>now.getTime(),'UPDATE_FUNDING_REQUIRED','Review the funding cutoff before updating staging.');
    requireValue(manifest.schemaVersion===1,'UPDATE_ARTIFACT_INVALID','Use a complete reviewed AWS artifact manifest.');
    const artifactDir=resolve(dirname(manifestPath)),canonicalDir=await realpath(artifactDir);let templateBytes;
    for(const [name,file]of [['lambda','lambda.zip'],['template','template.json']]){
      const artifact=manifest[name];requireValue(artifact&&resolve(artifact.path||'')===join(artifactDir,file)&&/^[a-f0-9]{64}$/.test(artifact.sha256||'')&&Number.isSafeInteger(artifact.bytes)&&artifact.bytes>0,'UPDATE_ARTIFACT_INVALID','The artifact manifest contains an unreviewed path or hash.');
      requireValue(await realpath(artifact.path)===join(canonicalDir,file)&&(await lstat(artifact.path)).isFile(),'UPDATE_ARTIFACT_INVALID','Artifact paths must not follow symbolic links.');
      const bytes=await readFile(artifact.path);requireValue(bytes.length===artifact.bytes&&hash(bytes)===artifact.sha256,'UPDATE_ARTIFACT_INVALID','An artifact hash changed after packaging. Review the package before updating.');if(name==='template')templateBytes=bytes;
    }
    const template=JSON.parse(templateBytes.toString('utf8')),body=JSON.stringify(template);
    requireValue(template.AWSTemplateFormatVersion==='2010-09-09'&&template.Parameters&&typeof template.Parameters==='object'&&!Array.isArray(template.Parameters)&&template.Resources&&Buffer.byteLength(body)<=51200,'UPDATE_ARTIFACT_INVALID','The reviewed template must fit the direct CloudFormation limit and declare its parameters.');
    const region=['--region',state.region],identity=await control.call('sts','get-caller-identity',{},region);requireValue(identity.Account===state.accountId,'UPDATE_ACCOUNT_CHANGED','The connected AWS account changed since the staging review.');
    const stack=(await control.call('cloudformation','describe-stacks',{StackName:state.stackId},region)).Stacks?.[0];
    requireValue(stack&&stack.StackId===state.stackId&&stack.StackName===state.stackName&&['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus),'UPDATE_STACK_NOT_READY','Wait for the reviewed staging stack to finish in a complete state.');
    const remote=Object.fromEntries((stack.Parameters||[]).map(item=>[item.ParameterKey,item.ParameterValue])),outputs=Object.fromEntries((stack.Outputs||[]).map(item=>[item.OutputKey,item.OutputValue]));
    requireValue(remote.Environment==='staging'&&remote.LaunchOpen==='false'&&remote.CreditsVerified==='true'&&remote.CreditCutoffAt===state.cutoffAt&&remote.RuntimeSecretArn===p.RuntimeSecretArn&&remote.CodeS3Bucket===state.artifactsBucket&&['ENABLED','DISABLED'].includes(remote.ScheduleState),'UPDATE_STAGING_REQUIRED','The live stack must match the reviewed closed staging funding and target configuration.');
    requireValue(!remote.CodeS3ObjectVersion,'UPDATE_ARTIFACT_INVALID','A version-pinned code artifact requires a separately reviewed update process.');
    const url=siteOrigin(remote,outputs,state.region);
    requireValue(remote.SiteOrigin===url&&p.SiteOrigin===url,'UPDATE_ORIGIN_REQUIRED','The selected HTTPS origin must match the reviewed staging site origin.');
    for(const key of ['SupportUrl','PrivacyUrl','AccountDeletionUrl'])if(Object.hasOwn(patches,key)){
      let value;try{value=new URL(patches[key]);}catch{fail('UPDATE_OVERRIDE_INVALID','Support URL overrides require a valid same-origin HTTPS URL.');}
      requireValue(value.protocol==='https:'&&!value.username&&!value.password&&value.origin===url&&!value.hash,'UPDATE_OVERRIDE_INVALID','Support URL overrides require a same-origin HTTPS URL without credentials.');
    }
    const keys=Object.keys(remote);requireValue(keys.length>0&&keys.every(key=>Object.hasOwn(template.Parameters,key))&&Object.keys(patches).every(key=>Object.hasOwn(template.Parameters,key))&&Object.entries(template.Parameters).every(([key,value])=>Object.hasOwn(remote,key)||Object.hasOwn(patches,key)||Object.hasOwn(value,'Default')),'UPDATE_ARTIFACT_INVALID','The template parameter changes require a separate reviewed migration.');
    if(sampleChange){requireValue(remote.DataMode!=='live'&&remote.ScheduleState==='DISABLED','UPDATE_QUIESCENCE_REQUIRED','Sample overrides require sample staging with current schedules disabled.');await checkQuiescence({url,state,fetchImpl,timeoutMs});}
    const desired={CodeS3Bucket:state.artifactsBucket,CodeS3Key:'lambda/'+manifest.lambda.sha256+'.zip',...patches},changedParameters=Object.keys(desired).filter(key=>remote[key]!==desired[key]);
    const previous=(await control.call('cloudformation','get-template',{StackName:state.stackId,TemplateStage:'Original'},region)).TemplateBody;
    requireValue(previous&&typeof previous==='object'||typeof previous==='string','UPDATE_ARTIFACT_INVALID','Read the current reviewed stack template before updating.');
    const previousTemplate=typeof previous==='string'?JSON.parse(previous):previous;
    if(!changedParameters.length&&JSON.stringify(canonical(previousTemplate))===JSON.stringify(canonical(template)))return{url,status:'UNCHANGED',changedParameters:[]};
    await control.call('s3api','put-object',{Bucket:state.artifactsBucket,Key:desired.CodeS3Key,ServerSideEncryption:'AES256'},['--body',manifest.lambda.path,...region]);
    const requestToken=randomUUID();
    await control.call('cloudformation','update-stack',{StackName:state.stackId,TemplateBody:body,Parameters:[...keys.map(ParameterKey=>Object.hasOwn(desired,ParameterKey)?{ParameterKey,ParameterValue:desired[ParameterKey]}:{ParameterKey,UsePreviousValue:true}),...Object.keys(desired).filter(key=>!keys.includes(key)).map(ParameterKey=>({ParameterKey,ParameterValue:desired[ParameterKey]}))],Capabilities:['CAPABILITY_IAM'],ClientRequestToken:requestToken},region);
    const preserved={...state.parameters};for(const [key,value]of Object.entries(remote))if(value!=='****')preserved[key]=value;
    state.parameters={...preserved,...desired};state.schedules=state.parameters.ScheduleState;state.outputs=outputs;state.lastUpdate={status:'UPDATE_IN_PROGRESS',startedAt:now.toISOString(),clientRequestToken:requestToken,lambdaSha256:manifest.lambda.sha256,templateSha256:manifest.template.sha256,changedParameters};
    await saveState(privateDir,statePath,state);return{url,status:'UPDATE_IN_PROGRESS',changedParameters};
  }catch(error){if(typeof error?.code==='string'&&error.code.startsWith('UPDATE_'))throw error;fail('UPDATE_FAILED','The staging update was not confirmed. Check the reviewed artifacts and private deployment state.');}
}
export async function runUpdateCli(args,{writeOutput=line=>process.stdout.write(line+'\n'),...options}={}){
  const overrides={},seen=new Set();let quiescent=false;
  const map={'--schedules':'ScheduleState','--sample-start':'SampleStartAt','--sample-duration':'SampleDurationSeconds'};
  for(let i=0;i<args.length;i++){
    const flag=args[i];if(seen.has(flag)||flag!=='--quiescent'&&!Object.hasOwn(map,flag)){writeOutput(JSON.stringify({ok:false,code:'INVALID_ARGUMENTS',message:'Choose only reviewed schedule/sample flags and optional --quiescent.'}));return 2;}seen.add(flag);
    if(flag==='--quiescent'){quiescent=true;continue;}
    const value=args[++i];if(!value||value.startsWith('--')||flag==='--schedules'&&!['enabled','disabled'].includes(value)||flag==='--sample-duration'&&(!/^\d+$/.test(value)||Number(value)<60||Number(value)>10800)||flag==='--sample-start'&&!isoTimestamp(value)){writeOutput(JSON.stringify({ok:false,code:'INVALID_ARGUMENTS',message:'Provide a valid schedule, UTC sample start, and bounded sample duration.'}));return 2;}
    overrides[map[flag]]=flag==='--schedules'?value.toUpperCase():value;
  }
  try{writeOutput(JSON.stringify({ok:true,...await updateDeployment({...options,overrides,quiescent})}));return 0;}
  catch(error){writeOutput(JSON.stringify({ok:false,code:error.code||'UPDATE_FAILED',message:error.message}));return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=await runUpdateCli(process.argv.slice(2));
