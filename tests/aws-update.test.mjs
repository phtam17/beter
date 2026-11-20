import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const implementation=await import('../scripts/aws-update.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'beter-update-'));t.after(()=>rm(root,{recursive:true,force:true}));const privateDir=join(root,'.data/aws-deploy'),artifactDir=join(root,'artifacts/aws');await mkdir(privateDir,{recursive:true,mode:0o700});await mkdir(artifactDir,{recursive:true});
  const now=new Date('2026-11-20T20:00:00.000Z'),url='https://fixture123.execute-api.us-west-2.amazonaws.com',calls=[],fetches=[];
  const parameters={AppName:'beter',Environment:'staging',LaunchOpen:'false',ScheduleState:'DISABLED',DataMode:'sample',CreditsVerified:'true',CreditCutoffAt:'2026-11-27T20:00:00',FreeGatewayHosting:'true',SiteOrigin:url,RuntimeSecretArn:'arn:aws:secretsmanager:us-west-2:123456789012:secret:runtime',StagingAuthorizationHash:'PRIVATE_STAGING_HASH',TestEmailAllowlist:'PRIVATE_EMAIL@example.test',CodeS3Bucket:'beter-fixture-artifacts',CodeS3Key:'lambda/old.zip',CodeS3ObjectVersion:'',SampleStartAt:'2026-11-20T21:00:00.000Z',SampleDurationSeconds:'120',SupportUrl:url+'/support',PrivacyUrl:url+'/privacy',AccountDeletionUrl:url+'/account-deletion'};
  const state={schemaVersion:1,accountId:'123456789012',region:'us-west-2',stackName:'beter-staging',stackId:'arn:aws:cloudformation:us-west-2:123456789012:stack/beter-staging/fixture',artifactsBucket:parameters.CodeS3Bucket,launchOpen:false,schedules:'DISABLED',cutoffAt:parameters.CreditCutoffAt,parameters,stagingAccess:'Basic '+Buffer.from('beter:PRIVATE_STAGING_ACCESS_1234567890123456').toString('base64'),runtime:{jobSecret:'PRIVATE_JOB_SECRET_123456789012345678901234567890'}};
  const outputs={PublicGatewayOrigin:url,CloudFrontDomain:'unused.cloudfront.net'},stack={StackName:state.stackName,StackId:state.stackId,StackStatus:'UPDATE_COMPLETE',Parameters:Object.entries(parameters).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue:['StagingAuthorizationHash','TestEmailAllowlist'].includes(ParameterKey)?'****':ParameterValue})),Outputs:Object.entries(outputs).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))};
  const template={AWSTemplateFormatVersion:'2010-09-09',Parameters:Object.fromEntries(Object.keys(parameters).map(key=>[key,{Type:'String',Default:'',...(['StagingAuthorizationHash','TestEmailAllowlist'].includes(key)?{NoEcho:true}:{})}])),Resources:{Fixture:{Type:'AWS::S3::Bucket'}}};
  const lambda=Buffer.from('reviewed lambda fixture'),templateBytes=Buffer.from(JSON.stringify(template,null,2));const manifest={schemaVersion:1,lambda:{path:join(artifactDir,'lambda.zip'),sha256:createHash('sha256').update(lambda).digest('hex'),bytes:lambda.length},template:{path:join(artifactDir,'template.json'),sha256:createHash('sha256').update(templateBytes).digest('hex'),bytes:templateBytes.length}};
  const manifestPath=join(artifactDir,'manifest.json');await writeFile(manifest.lambda.path,lambda);await writeFile(manifest.template.path,templateBytes);
  const save=async()=>{await writeFile(join(privateDir,'state.json'),JSON.stringify(state),{mode:0o600});await writeFile(manifestPath,JSON.stringify(manifest));};await save();
  const control={async call(service,operation,input={},extra=[]){calls.push({service,operation,input,extra});if(service==='sts')return{Account:state.accountId};if(operation==='describe-stacks')return{Stacks:[stack]};if(operation==='get-template')return{TemplateBody:JSON.stringify({...template,Description:'previous template'})};if(operation==='update-stack')return{StackId:state.stackId};return{};}};
  const fetchImpl=async(url,options)=>{fetches.push({url,options});return new Response(JSON.stringify({open_bets:0,schema_version:4,ledger_mismatches:0}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});};
  return{root,privateDir,artifactDir,manifestPath,now,url,state,stack,manifest,template,calls,fetches,save,control,fetchImpl,options(){return{privateDir,manifestPath,now,control:this.control,fetchImpl:this.fetchImpl};}};
}
const mutations=f=>f.calls.filter(call=>['put-object','update-stack'].includes(call.operation));
test('closed staging update verifies artifacts, preserves all prior values including NoEcho and epoch, and saves private recovery state',async t=>{
  assert.equal(typeof implementation.updateDeployment,'function');const f=await fixture(t),report=await implementation.updateDeployment(f.options());
  const upload=f.calls.find(call=>call.operation==='put-object');assert.equal(upload.input.Bucket,f.state.artifactsBucket);assert.equal(upload.input.Key,'lambda/'+f.manifest.lambda.sha256+'.zip');assert.equal(upload.input.ServerSideEncryption,'AES256');assert.equal(upload.extra[0],'--body');assert.equal(typeof upload.extra[1],'string');assert.deepEqual(upload.extra.slice(2),['--region','us-west-2']);
  const update=f.calls.find(call=>call.operation==='update-stack');assert.equal(update.input.StackName,f.state.stackId);assert.deepEqual(JSON.parse(update.input.TemplateBody),f.template);assert.equal(update.input.TemplateBody,JSON.stringify(f.template));assert.deepEqual(update.input.Capabilities,['CAPABILITY_IAM']);
  for(const parameter of update.input.Parameters){if(['CodeS3Bucket','CodeS3Key'].includes(parameter.ParameterKey))assert.equal(typeof parameter.ParameterValue,'string');else assert.deepEqual(parameter,{ParameterKey:parameter.ParameterKey,UsePreviousValue:true});}
  assert.equal(update.input.Parameters.length,f.stack.Parameters.length);assert.doesNotMatch(JSON.stringify(update.input),/PRIVATE_|\*\*\*\*/);assert.equal(f.fetches.length,0);assert.deepEqual(Object.keys(report).sort(),['changedParameters','status','url']);assert.equal(report.url,f.url);assert.equal(report.status,'UPDATE_IN_PROGRESS');assert.deepEqual(report.changedParameters,['CodeS3Key']);
  const saved=JSON.parse(await readFile(join(f.privateDir,'state.json'),'utf8'));assert.equal(saved.parameters.SampleStartAt,f.state.parameters.SampleStartAt);assert.equal(saved.parameters.StagingAuthorizationHash,'PRIVATE_STAGING_HASH');assert.equal(saved.parameters.TestEmailAllowlist,'PRIVATE_EMAIL@example.test');assert.equal(saved.lastUpdate.status,'UPDATE_IN_PROGRESS');assert.equal(saved.lastUpdate.lambdaSha256,f.manifest.lambda.sha256);assert.equal((await stat(join(f.privateDir,'state.json'))).mode&0o777,0o600);assert.doesNotMatch(JSON.stringify(report),/PRIVATE_|arn:|example.test/);
});
test('lambda and template hash drift stop before any AWS action',async t=>{
  assert.equal(typeof implementation.updateDeployment,'function');for(const part of ['lambda','template']){const f=await fixture(t);await writeFile(f.manifest[part].path,'unreviewed drift');await assert.rejects(()=>implementation.updateDeployment(f.options()),/hash|changed.*packag|artifact/i);assert.equal(f.calls.length,0);}
});
test('staging updater rejects public targets, changed account, incomplete stacks, unsafe files and expired funding before mutation',async t=>{
  assert.equal(typeof implementation.updateDeployment,'function');
  for(const change of [f=>{f.state.launchOpen=true;},f=>{f.state.parameters.Environment='production';},f=>{f.state.cutoffAt='2020-01-01T00:00:00';},f=>{f.stack.Parameters.find(p=>p.ParameterKey==='LaunchOpen').ParameterValue='true';},f=>{f.stack.Parameters.find(p=>p.ParameterKey==='CreditsVerified').ParameterValue='false';},f=>{f.stack.StackStatus='UPDATE_IN_PROGRESS';},f=>{f.control={call:async()=>({Account:'234567890123'})};}]){const f=await fixture(t);change(f);await f.save();await assert.rejects(()=>implementation.updateDeployment(f.options()),Error);assert.equal(mutations(f).length,0);}
  const f=await fixture(t);await chmod(join(f.privateDir,'state.json'),0o644);await assert.rejects(()=>implementation.updateDeployment(f.options()),/private|permission/i);assert.equal(f.calls.length,0);
});
test('only approved overrides are allowed and secrets, release state, funding and target identifiers cannot be patched',async t=>{
  assert.equal(typeof implementation.updateDeployment,'function');const f=await fixture(t);
  for(const overrides of [{LaunchOpen:'true'},{Environment:'production'},{CreditCutoffAt:'2030-01-01T00:00:00'},{CreditsVerified:'true'},{RuntimeSecretArn:'arn:private'},{CodeS3Bucket:'other'},{ScheduleState:'sometimes'},{SupportUrl:'http://example.test'},{PrivacyUrl:'https://other.example/privacy'}]){await assert.rejects(()=>implementation.updateDeployment({...f.options(),overrides}),/override|HTTPS|origin|schedule/i);assert.equal(mutations(f).length,0);}
});
test('sample changes require explicit quiescence, disabled current schedules, and zero protected open bets',async t=>{
  assert.equal(typeof implementation.updateDeployment,'function');const overrides={SampleStartAt:'2026-11-20T22:00:00.000Z',SampleDurationSeconds:120};
  for(const mode of ['unconfirmed','scheduled','open-bets','redirect','unavailable']){const f=await fixture(t);if(mode==='scheduled')f.stack.Parameters.find(p=>p.ParameterKey==='ScheduleState').ParameterValue='ENABLED';if(mode==='open-bets')f.fetchImpl=async()=>new Response('{"open_bets":1}',{headers:{'Content-Type':'application/json'}});if(mode==='redirect')f.fetchImpl=async()=>new Response(null,{status:302,headers:{Location:'https://private.example'}});if(mode==='unavailable')f.fetchImpl=async()=>{throw Error('PRIVATE_JOB_SECRET_123456789012345678901234567890');};await assert.rejects(()=>implementation.updateDeployment({...f.options(),overrides,quiescent:mode!=='unconfirmed'}),error=>!/PRIVATE_JOB/.test(error.message));assert.equal(mutations(f).length,0);}
});
test('approved sample and schedule changes use protected same-origin health then patch only requested parameters',async t=>{
  assert.equal(typeof implementation.updateDeployment,'function');const f=await fixture(t),overrides={SampleStartAt:'2026-11-20T22:00:00Z',SampleDurationSeconds:120,ScheduleState:'ENABLED',SupportUrl:f.url+'/support'};
  const report=await implementation.updateDeployment({...f.options(),overrides,quiescent:true});assert.equal(f.fetches.length,1);assert.equal(f.fetches[0].url,f.url+'/api/health/details');assert.equal(f.fetches[0].options.method,'GET');assert.equal(f.fetches[0].options.redirect,'manual');assert.equal(f.fetches[0].options.headers.authorization,'Bearer '+f.state.runtime.jobSecret);assert.equal(f.fetches[0].options.headers['x-beter-staging-access'],f.state.stagingAccess);assert.ok(f.fetches[0].options.signal);
  const parameters=f.calls.find(call=>call.operation==='update-stack').input.Parameters;for(const key of Object.keys(overrides))assert.deepEqual(parameters.find(parameter=>parameter.ParameterKey===key),{ParameterKey:key,ParameterValue:String(overrides[key])});assert.ok(parameters.filter(parameter=>!['CodeS3Bucket','CodeS3Key',...Object.keys(overrides)].includes(parameter.ParameterKey)).every(parameter=>parameter.UsePreviousValue===true));assert.ok(report.changedParameters.includes('SampleStartAt'));assert.ok(report.changedParameters.includes('ScheduleState'));assert.doesNotMatch(JSON.stringify(report),/PRIVATE_|22:00/);
});
test('invalid sample dates and duration bounds fail without uploads',async t=>{
  assert.equal(typeof implementation.updateDeployment,'function');const f=await fixture(t);
  for(const overrides of [{SampleStartAt:'2026-02-30T20:00:00.000Z'},{SampleStartAt:'2026-11-20'},{SampleDurationSeconds:59},{SampleDurationSeconds:10801},{SampleDurationSeconds:60.5}]){await assert.rejects(()=>implementation.updateDeployment({...f.options(),overrides,quiescent:true}),/sample|duration|timestamp/i);assert.equal(mutations(f).length,0);}
});
test('a repeated identical code/template update is read-only and leaves private state unchanged',async t=>{
  assert.equal(typeof implementation.updateDeployment,'function');const f=await fixture(t);f.state.parameters.CodeS3Key='lambda/'+f.manifest.lambda.sha256+'.zip';f.stack.Parameters.find(p=>p.ParameterKey==='CodeS3Key').ParameterValue=f.state.parameters.CodeS3Key;await f.save();const original=f.control.call;f.control.call=async(service,operation,...args)=>operation==='get-template'?{TemplateBody:f.template}:original(service,operation,...args);
  const before=await readFile(join(f.privateDir,'state.json'),'utf8'),report=await implementation.updateDeployment(f.options());assert.equal(report.status,'UNCHANGED');assert.deepEqual(report.changedParameters,[]);assert.equal(mutations(f).length,0);assert.equal(await readFile(join(f.privateDir,'state.json'),'utf8'),before);
});
test('update failures do not overwrite private state or disclose provider errors',async t=>{
  assert.equal(typeof implementation.updateDeployment,'function');const f=await fixture(t),original=f.control.call;f.control.call=async(service,operation,...args)=>{if(operation==='update-stack')throw Error('PRIVATE_JOB_SECRET_123456789012345678901234567890');return original(service,operation,...args);};const before=await readFile(join(f.privateDir,'state.json'),'utf8');await assert.rejects(()=>implementation.updateDeployment(f.options()),error=>!error.message.includes('PRIVATE_JOB'));assert.equal(await readFile(join(f.privateDir,'state.json'),'utf8'),before);
});
test('sample overrides require explicit sample mode',async t=>{
  const f=await fixture(t);f.stack.Parameters=f.stack.Parameters.filter(parameter=>parameter.ParameterKey!=='DataMode');await assert.rejects(()=>implementation.updateDeployment({...f.options(),quiescent:true,overrides:{SampleDurationSeconds:120}}),/sample/i);assert.equal(mutations(f).length,0);
});
test('provider-shaped update errors cannot bypass redaction',async t=>{
  const g=await fixture(t);g.control.call=async()=>{throw Object.assign(Error('PRIVATE_PROVIDER_VALUE'),{code:'UPDATE_FAKE_PROVIDER_ERROR'});};await assert.rejects(()=>implementation.updateDeployment(g.options()),error=>!error.message.includes('PRIVATE_PROVIDER_VALUE'));
});
test('a stalled protected health response expires before any update mutation',async t=>{
  const f=await fixture(t);f.fetchImpl=()=>new Promise(()=>{});await assert.rejects(()=>implementation.updateDeployment({...f.options(),timeoutMs:5,quiescent:true,overrides:{SampleDurationSeconds:120}}),/health|quiescen/i);assert.equal(mutations(f).length,0);
});
test('uploaded bytes remain the reviewed artifact if packaging changes the source during remote preflight',async t=>{
  const f=await fixture(t),original=f.control.call;let uploaded;
  f.control.call=async(service,operation,input,extra)=>{if(service==='sts')await writeFile(f.manifest.lambda.path,'unreviewed concurrent rebuild');if(operation==='put-object')uploaded=createHash('sha256').update(await readFile(extra[1])).digest('hex');return original(service,operation,input,extra);};
  await implementation.updateDeployment(f.options());assert.equal(uploaded,f.manifest.lambda.sha256);
});
test('updater CLI accepts only the reviewed flags and never accepts credentials or arbitrary parameter patches',async t=>{
  assert.equal(typeof implementation.runUpdateCli,'function');const f=await fixture(t),output=[];
  const result=await implementation.runUpdateCli(['--schedules','enabled','--sample-start','2026-11-20T22:00:00Z','--sample-duration','120','--quiescent'],{...f.options(),writeOutput:line=>output.push(JSON.parse(line))});assert.equal(result,0);assert.equal(output[0].status,'UPDATE_IN_PROGRESS');assert.doesNotMatch(JSON.stringify(output),/PRIVATE_|arn:|22:00/);
  for(const args of [['--secret','PRIVATE_VALUE'],['--launch-open','true'],['--schedules','maybe'],['--sample-start'],['--quiescent','--quiescent']])assert.equal(await implementation.runUpdateCli(args,{...f.options(),writeOutput:line=>output.push(JSON.parse(line))}),2);assert.doesNotMatch(JSON.stringify(output),/PRIVATE_VALUE/);
});
