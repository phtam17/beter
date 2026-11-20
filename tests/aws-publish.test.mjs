import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const {publishDeployment}=await import('../scripts/aws-publish.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'beter-publish-'));t.after(()=>rm(root,{recursive:true,force:true}));const privateDir=join(root,'.data/aws-deploy');await mkdir(privateDir,{recursive:true});await mkdir(join(root,'dist'));
 const now=new Date('2026-11-20T20:00:00Z'),calls=[];
 const parameters={AppName:'beter',Environment:'staging',LaunchOpen:'false',ScheduleState:'DISABLED',CreditsVerified:'true',CreditCutoffAt:'2026-11-27T23:59:59',SiteOrigin:'https://pending.invalid',CodeS3Key:'lambda/fixture.zip',TestEmailAllowlist:'owner@example.test'};
 const state={schemaVersion:1,accountId:'123456789012',region:'us-west-2',stackName:'beter-staging',stackId:'arn:aws:cloudformation:us-west-2:123456789012:stack/beter-staging/fixture',launchOpen:false,schedules:'DISABLED',cutoffAt:parameters.CreditCutoffAt,parameters,stagingAccess:'Basic PRIVATE_STAGING_VALUE',runtime:{sessionSecret:'PRIVATE_SESSION_SECRET'}};
 const outputs={AssetsBucketName:'beter-fixture-assets',CloudFrontDomain:'d123fixture.cloudfront.net',DistributionId:'EFIXTURE123'};
 const stack={StackStatus:'CREATE_COMPLETE',Parameters:Object.entries(parameters).map(([ParameterKey,ParameterValue])=>({ParameterKey,ParameterValue})),Outputs:Object.entries(outputs).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))};
 const assetPath=join(root,'dist/index.html'),bytes=Buffer.from('<html>Reviewed public app</html>');await writeFile(assetPath,bytes);const manifest={schemaVersion:1,assets:[{key:'index.html',sourcePath:assetPath,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,contentType:'text/html; charset=utf-8',cacheControl:'no-cache'}]};
 const manifestPath=join(root,'manifest.json');const save=async()=>{await writeFile(join(privateDir,'state.json'),JSON.stringify(state));await writeFile(manifestPath,JSON.stringify(manifest));};await save();
 const control={call:async(service,operation,input,extra)=>{calls.push({service,operation,input,extra});if(service==='sts')return{Account:state.accountId};if(operation==='describe-stacks')return{Stacks:[stack]};if(operation==='update-stack')return{StackId:state.stackId};if(operation==='create-invalidation')return{Invalidation:{Id:'SAFE_INVALIDATION'}};return{};}};
 return{root,privateDir,manifestPath,now,state,manifest,outputs,stack,calls,save,control,options(){return{root,privateDir,manifestPath,now,control};}};
}
test('closed staging publishing uploads verified assets and changes only the canonical site origin',async t=>{
 assert.equal(typeof publishDeployment,'function','A reviewed static publishing path is required.');const f=await fixture(t);const result=await publishDeployment(f.options());
 const upload=f.calls.find(call=>call.operation==='put-object');assert.equal(upload.input.Bucket,f.outputs.AssetsBucketName);assert.equal(upload.input.Key,'index.html');assert.equal(upload.input.ContentType,'text/html; charset=utf-8');assert.equal(upload.input.CacheControl,'no-cache');assert.deepEqual(upload.extra,['--body',f.manifest.assets[0].sourcePath,'--region','us-west-2']);
 const update=f.calls.find(call=>call.operation==='update-stack');assert.equal(update.input.UsePreviousTemplate,true);assert.equal(update.input.StackName,f.state.stackId);assert.deepEqual(update.input.Parameters.find(p=>p.ParameterKey==='SiteOrigin'),{ParameterKey:'SiteOrigin',ParameterValue:'https://'+f.outputs.CloudFrontDomain});assert.ok(update.input.Parameters.filter(p=>p.ParameterKey!=='SiteOrigin').every(p=>p.UsePreviousValue===true&&p.ParameterValue===undefined));assert.equal(update.input.Parameters.length,Object.keys(f.state.parameters).length);
 const invalidation=f.calls.find(call=>call.operation==='create-invalidation');assert.equal(invalidation.input.DistributionId,f.outputs.DistributionId);assert.deepEqual(invalidation.input.InvalidationBatch.Paths,{Quantity:1,Items:['/*']});
 const saved=JSON.parse(await readFile(join(f.privateDir,'state.json'),'utf8'));assert.equal(saved.parameters.SiteOrigin,'https://'+f.outputs.CloudFrontDomain);assert.deepEqual(saved.outputs,f.outputs);assert.equal((await stat(join(f.privateDir,'state.json'))).mode&0o777,0o600);assert.equal(result.assets,1);assert.equal(result.updateStarted,true);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_|owner@example/);
});
test('all public hashes are checked before any upload and local path escapes are rejected',async t=>{
 assert.equal(typeof publishDeployment,'function');const f=await fixture(t);await writeFile(f.manifest.assets[0].sourcePath,'changed after review');await assert.rejects(()=>publishDeployment(f.options()),/asset.*changed|hash/i);assert.equal(f.calls.some(c=>c.operation==='put-object'),false);
 f.manifest.assets[0].key='../state.html';await f.save();await assert.rejects(()=>publishDeployment(f.options()),/public asset|manifest/i);assert.equal(f.calls.some(c=>c.operation==='put-object'),false);
});
test('publishing refuses incomplete state, an open stack, pending updates, and expired funding',async t=>{
 assert.equal(typeof publishDeployment,'function');const f=await fixture(t);delete f.state.stackId;await f.save();await assert.rejects(()=>publishDeployment(f.options()),/complete.*closed|closed.*complete/i);assert.equal(f.calls.length,0);
 f.state.stackId='fixture';f.state.launchOpen=true;await f.save();await assert.rejects(()=>publishDeployment(f.options()),/closed/i);assert.equal(f.calls.length,0);
 f.state.launchOpen=false;await f.save();f.stack.Parameters.find(p=>p.ParameterKey==='LaunchOpen').ParameterValue='true';await assert.rejects(()=>publishDeployment(f.options()),/closed/i);assert.equal(f.calls.some(c=>c.operation==='put-object'),false);
 f.stack.Parameters.find(p=>p.ParameterKey==='LaunchOpen').ParameterValue='false';f.stack.StackStatus='UPDATE_IN_PROGRESS';await assert.rejects(()=>publishDeployment(f.options()),/complete|finish/i);assert.equal(f.calls.some(c=>c.operation==='put-object'),false);
 f.stack.StackStatus='CREATE_COMPLETE';await assert.rejects(()=>publishDeployment({...f.options(),now:new Date('2026-11-28T00:00:00Z')}),/funding|cutoff/i);assert.equal(f.calls.some(c=>c.operation==='put-object'),false);
});
test('a resumed publisher preserves the private state and avoids a redundant origin update',async t=>{
 assert.equal(typeof publishDeployment,'function');const f=await fixture(t);f.state.parameters.SiteOrigin='https://'+f.outputs.CloudFrontDomain;f.stack.Parameters.find(p=>p.ParameterKey==='SiteOrigin').ParameterValue=f.state.parameters.SiteOrigin;f.stack.StackStatus='UPDATE_COMPLETE';await f.save();const result=await publishDeployment(f.options());assert.equal(result.updateStarted,false);assert.equal(f.calls.some(c=>c.operation==='update-stack'),false);assert.equal(f.calls.filter(c=>c.operation==='create-invalidation').length,1);assert.equal(JSON.parse(await readFile(join(f.privateDir,'state.json'),'utf8')).stagingAccess,'Basic PRIVATE_STAGING_VALUE');
});
