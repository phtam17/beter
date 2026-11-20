import {readFile,writeFile,mkdir,rename,chmod,realpath} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createAwsControl} from './aws-deploy.mjs';
const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const extensions=new Set(['.html','.js','.css','.svg','.ico','.png','.jpg','.jpeg','.webp','.woff','.woff2','.webmanifest','.txt']);
async function jsonFile(path,label){try{return JSON.parse(await readFile(path,'utf8'));}catch{throw Error('Read a complete reviewed '+label+' before publishing.');}}

/** Upload reviewed public bytes and finish the canonical-origin bootstrap without exposing private recovery state. */
export async function publishDeployment({root=projectRoot,privateDir=join(root,'.data/aws-deploy'),manifestPath=join(root,'artifacts/aws/manifest.json'),control=createAwsControl({privateDir}),now=new Date()}={}){
 const statePath=join(privateDir,'state.json'),state=await jsonFile(statePath,'closed staging state'),manifest=await jsonFile(manifestPath,'AWS asset manifest');
 const parameters=state.parameters;
 if(state.schemaVersion!==1||!state.stackId||!state.stackName||!/^\d{12}$/.test(state.accountId||'')||!/^[-a-z0-9]+$/.test(state.region||'')||state.launchOpen!==false||state.schedules!=='DISABLED'||!parameters||parameters.Environment!=='staging'||parameters.LaunchOpen!=='false'||parameters.ScheduleState!=='DISABLED'||parameters.CreditsVerified!=='true'||!parameters.SiteOrigin)throw Error('A complete closed staging deployment state is required.');
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(state.cutoffAt||'')||parameters.CreditCutoffAt!==state.cutoffAt||!(Date.parse(state.cutoffAt+'Z')>now.getTime()))throw Error('Review the funding cutoff before publishing.');
 if(manifest.schemaVersion!==1||!Array.isArray(manifest.assets)||!manifest.assets.length||!manifest.assets.some(asset=>asset.key==='index.html'))throw Error('A complete reviewed public asset manifest is required.');
 const dist=join(resolve(root),'dist'),canonicalDist=await realpath(dist),keys=new Set();
 for(const asset of manifest.assets){
  const segments=typeof asset.key==='string'?asset.key.split('/'):[];
  if(!segments.length||segments.some(part=>!part||part.startsWith('.')||part.includes('\\'))||keys.has(asset.key)||!extensions.has(extname(asset.key).toLowerCase())||!asset.sourcePath||resolve(asset.sourcePath)!==join(dist,...segments)||typeof asset.contentType!=='string'||!asset.contentType||/[\r\n]/.test(asset.contentType)||asset.cacheControl!=='no-cache'||!/^[a-f0-9]{64}$/.test(asset.sha256||''))throw Error('The public asset manifest contains an unreviewed path or setting.');
  keys.add(asset.key);
  if(await realpath(asset.sourcePath)!==join(canonicalDist,...segments))throw Error('The public asset manifest cannot follow symbolic links.');
  const bytes=await readFile(asset.sourcePath);
  if(bytes.length!==asset.bytes||createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('A public asset changed after packaging; review its hash before publishing.');
 }
 const region=['--region',state.region],identity=await control.call('sts','get-caller-identity',{},region);
 if(identity.Account!==state.accountId)throw Error('The connected AWS account changed since the staging review.');
 const description=await control.call('cloudformation','describe-stacks',{StackName:state.stackId},region),stack=description.Stacks?.[0];
 if(!stack||!['CREATE_COMPLETE','UPDATE_COMPLETE'].includes(stack.StackStatus))throw Error('Wait for the staging stack to finish in a complete state before publishing.');
 const remoteParameters=Object.fromEntries((stack.Parameters||[]).map(parameter=>[parameter.ParameterKey,parameter.ParameterValue]));
 if(remoteParameters.Environment!=='staging'||remoteParameters.LaunchOpen!=='false'||remoteParameters.ScheduleState!=='DISABLED'||remoteParameters.CreditsVerified!=='true'||remoteParameters.CreditCutoffAt!==state.cutoffAt)throw Error('The hosted stack must match the reviewed closed staging plan.');
 const outputs=Object.fromEntries((stack.Outputs||[]).map(output=>[output.OutputKey,output.OutputValue]));
 const freeGateway=remoteParameters.FreeGatewayHosting==='true';let siteOrigin;
 if(freeGateway){
  let origin;try{origin=new URL(outputs.PublicGatewayOrigin);}catch{throw Error('The completed stack has no valid gateway origin.');}
  const suffix='.execute-api.'+state.region+'.amazonaws.com';
  if(origin.protocol!=='https:'||origin.port||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!(/^[a-z0-9]+$/.test(origin.hostname.split('.')[0]))||![suffix,suffix+'.cn'].some(ending=>origin.hostname===origin.hostname.split('.')[0]+ending))throw Error('The completed stack has an invalid gateway origin.');
  siteOrigin=origin.origin;
 }else{
  if(parameters.FreeGatewayHosting==='true')throw Error('The hosted gateway origin does not match the reviewed hosting mode.');
  if(!/^[a-z0-9]+\.cloudfront\.net$/.test(outputs.CloudFrontDomain||'')||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(outputs.AssetsBucketName||'')||!/^[A-Z0-9]+$/.test(outputs.DistributionId||''))throw Error('The completed staging stack has incomplete public publishing outputs.');
  for(const asset of manifest.assets)await control.call('s3api','put-object',{Bucket:outputs.AssetsBucketName,Key:asset.key,ContentType:asset.contentType,CacheControl:asset.cacheControl,ServerSideEncryption:'AES256'},['--body',asset.sourcePath,...region]);
  siteOrigin='https://'+outputs.CloudFrontDomain;
 }
 const updateStarted=remoteParameters.SiteOrigin!==siteOrigin;
 const preservedParameters={...parameters,...(remoteParameters.FreeGatewayHosting===undefined?{}:{FreeGatewayHosting:remoteParameters.FreeGatewayHosting})};
 if(updateStarted)await control.call('cloudformation','update-stack',{StackName:state.stackId,UsePreviousTemplate:true,Parameters:Object.keys(preservedParameters).map(ParameterKey=>ParameterKey==='SiteOrigin'?{ParameterKey,ParameterValue:siteOrigin}:{ParameterKey,UsePreviousValue:true}),Capabilities:['CAPABILITY_IAM'],ClientRequestToken:randomUUID()},region);
 state.parameters={...preservedParameters,SiteOrigin:siteOrigin};state.outputs=outputs;
 await mkdir(privateDir,{recursive:true,mode:0o700});await chmod(privateDir,0o700);const pending=join(privateDir,randomUUID()+'.state.json');await writeFile(pending,JSON.stringify(state,null,2)+'\n',{mode:0o600});await rename(pending,statePath);
 if(!freeGateway)await control.call('cloudfront','create-invalidation',{DistributionId:outputs.DistributionId,InvalidationBatch:{CallerReference:randomUUID(),Paths:{Quantity:1,Items:['/*']}}});
 return{stackName:state.stackName,url:siteOrigin,hosting:freeGateway?'gateway':'cloudfront',assets:manifest.assets.length,updateStarted,launchOpen:false,schedules:'DISABLED'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{console.log(JSON.stringify({ok:true,...await publishDeployment()}));}catch(error){console.error(JSON.stringify({ok:false,message:error instanceof Error?error.message:'AWS publishing failed.'}));process.exitCode=1;}
}
