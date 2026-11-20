import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const {packageAws}=await import('../scripts/aws-package.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'beter-package-'));t.after(()=>rm(root,{recursive:true,force:true}));for(const path of ['aws','dist','infra/aws'])await mkdir(join(root,path),{recursive:true});await writeFile(join(root,'aws/handler.ts'),"export const handler=async()=>({statusCode:200,body:'ok'}); export const preSignupHandler=async(event)=>event;");await writeFile(join(root,'dist/index.html'),'<html>Fixture</html>');await writeFile(join(root,'dist/app.js'),'console.log("fixture")');await writeFile(join(root,'.env.local'),'PRIVATE_KEY=must-never-copy');await writeFile(join(root,'infra/aws/template.json'),JSON.stringify({AWSTemplateFormatVersion:'2010-09-09',Resources:{}}));return root;}
test('AWS package builds one deployable Lambda entry, immutable hashes, and only explicit public assets',async t=>{
  assert.equal(typeof packageAws,'function','A reviewed AWS packaging path is required.');const root=await fixture(t);const manifest=await packageAws({root});assert.equal(manifest.schemaVersion,1);assert.equal(manifest.lambda.handler,'index.handler');assert.match(manifest.lambda.sha256,/^[a-f0-9]{64}$/);assert.match(manifest.lambda.sha256Base64,/^[A-Za-z0-9+/]{43}=$/);assert.deepEqual(manifest.assets.map(asset=>asset.key),['app.js','index.html']);assert.ok(manifest.assets.every(asset=>asset.cacheControl==='no-cache'));const listing=(await execute('unzip',['-Z1',manifest.lambda.path])).stdout.trim();assert.equal(listing,'index.mjs');assert.doesNotMatch(await readFile(join(root,'artifacts/aws/lambda/index.mjs'),'utf8'),/must-never-copy/);assert.equal(JSON.parse(await readFile(manifest.template.path,'utf8')).AWSTemplateFormatVersion,'2010-09-09');
});
test('AWS public asset packaging rejects secrets and symbolic-link escapes',async t=>{
  assert.equal(typeof packageAws,'function');const root=await fixture(t);await writeFile(join(root,'dist/.env'),'secret');await assert.rejects(()=>packageAws({root}),/public asset|unsafe/i);await rm(join(root,'dist/.env'));await symlink(join(root,'.env.local'),join(root,'dist/leak.js'));await assert.rejects(()=>packageAws({root}),/symbolic|public asset|unsafe/i);
});
test('AWS bundle cannot silently include the local database runtime',async t=>{
  assert.equal(typeof packageAws,'function');const root=await fixture(t);await assert.rejects(()=>packageAws({root,buildImpl:async()=>({metafile:{inputs:{'node_modules/@electric-sql/pglite/dist/index.js':{}}}})}),/local database/i);
});
test('missing assets and build failures leave no success manifest',async t=>{
  assert.equal(typeof packageAws,'function');const root=await fixture(t);await rm(join(root,'dist/index.html'));await assert.rejects(()=>packageAws({root}),/index.html/);await assert.rejects(()=>readFile(join(root,'artifacts/aws/manifest.json')),/ENOENT/);
  await writeFile(join(root,'dist/index.html'),'<html>Restored</html>');await mkdir(join(root,'artifacts/aws'),{recursive:true});await writeFile(join(root,'artifacts/aws/manifest.json'),'stale success');
  await assert.rejects(()=>packageAws({root,buildImpl:async()=>{throw new Error('PRIVATE_BUILD_VALUE');}}),error=>/could not be built/.test(error.message)&&!error.message.includes('PRIVATE_BUILD_VALUE'));await assert.rejects(()=>readFile(join(root,'artifacts/aws/manifest.json')),/ENOENT/);
});

test('packaging keeps nested public paths, ignores Finder metadata, and rejects unreviewed file types',async t=>{
  const root=await fixture(t);await mkdir(join(root,'dist/assets'));await writeFile(join(root,'dist/assets/icon.svg'),'<svg/>');await writeFile(join(root,'dist/.DS_Store'),'metadata');const manifest=await packageAws({root});assert.ok(manifest.assets.some(asset=>asset.key==='assets/icon.svg'&&asset.contentType==='image/svg+xml'));assert.equal(manifest.assets.some(asset=>asset.key.includes('DS_Store')),false);
  await writeFile(join(root,'dist/database.sql'),'private');await assert.rejects(()=>packageAws({root}),/Unsupported public asset/);
});
test('artifact generation rejects unsafe destinations, oversized templates, and unverifiable bundles',async t=>{
  const root=await fixture(t);await assert.rejects(()=>packageAws({root,outputDir:root}),/dedicated AWS artifact/);
  await writeFile(join(root,'infra/aws/template.json'),JSON.stringify({Description:'x'.repeat(51201)}));await assert.rejects(()=>packageAws({root}),/direct CloudFormation limit/);
  await writeFile(join(root,'infra/aws/template.json'),'{}');await assert.rejects(()=>packageAws({root,buildImpl:async()=>({})}),/local database runtime/);
});
