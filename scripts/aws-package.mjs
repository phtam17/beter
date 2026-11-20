import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,readdir,rm,rename,utimes} from 'node:fs/promises';
import {resolve,join,relative,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const contentTypes={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.webmanifest':'application/manifest+json','.txt':'text/plain; charset=utf-8'};

/** Produce code-only artifacts and an allowlisted public upload manifest. Never inline environment secrets. */
export async function packageAws({root=projectRoot,outputDir=join(root,'artifacts/aws'),buildImpl=build}={}){
  root=resolve(root);outputDir=resolve(outputDir);
  if(outputDir===root||root.startsWith(outputDir+sep))throw new Error('Choose a dedicated AWS artifact directory.');
  await mkdir(outputDir,{recursive:true});
  await rm(join(outputDir,'manifest.json'),{force:true});
  const dist=join(root,'dist'),assets=[],publicAssets={};
  async function inspect(directory){
    for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      if(entry.name==='.DS_Store')continue;
      if(entry.isSymbolicLink()||entry.name.startsWith('.'))throw new Error('Unsafe public asset or symbolic link in dist.');
      const sourcePath=join(directory,entry.name);
      if(entry.isDirectory()){await inspect(sourcePath);continue;}
      const contentType=contentTypes[extname(entry.name).toLowerCase()];
      if(!entry.isFile()||!contentType)throw new Error('Unsupported public asset type; review the static upload manifest.');
      const bytes=await readFile(sourcePath);
      const key=relative(dist,sourcePath).split(sep).join('/');
      assets.push({key,sourcePath,sha256:hash(bytes),bytes:bytes.length,contentType,cacheControl:'no-cache'});
      publicAssets['/'+key]={body:bytes.toString('base64'),contentType,isBase64Encoded:true};
    }
  }
  await inspect(dist);
  if(!assets.some(asset=>asset.key==='index.html'))throw new Error('Public index.html is required for an AWS package.');
  const templateBytes=Buffer.from(JSON.stringify(JSON.parse(await readFile(join(root,'infra/aws/template.json'),'utf8'))));
  if(templateBytes.length>51200)throw new Error('The minimized template exceeds the direct CloudFormation limit; use a reviewed S3 template URL.');
  const directory=join(outputDir,'lambda');await mkdir(directory,{recursive:true});const entry=join(directory,'index.mjs');
  let result;
  try{
    result=await buildImpl({stdin:{contents:"export * from './aws/handler.ts'; export * from './aws/web-handler.ts';",resolveDir:root,sourcefile:'aws-entry.ts',loader:'ts'},plugins:[{name:'reviewed-public-assets',setup(plugin){plugin.onResolve({filter:/^beter:public-assets$/},()=>({path:'beter:public-assets',namespace:'beter-public'}));plugin.onLoad({filter:/.*/,namespace:'beter-public'},()=>({contents:'export const assets = '+JSON.stringify(publicAssets)+';',loader:'js'}));}}],outfile:entry,absWorkingDir:root,bundle:true,platform:'node',target:'node24',format:'esm',metafile:true,sourcemap:false,minify:false,logLevel:'silent',banner:{js:"import {createRequire as __beterCreateRequire} from 'node:module'; const require = __beterCreateRequire(import.meta.url);"}});
  }catch{throw new Error('The AWS runtime bundle could not be built. Check the reviewed runtime source and installed dependencies.');}
  if(!result?.metafile||Object.keys(result.metafile.inputs).some(name=>/pglite|(?:^|\/)server\/local\.ts$/.test(name)))throw new Error('The local database runtime must not enter an AWS deployment artifact.');
  await utimes(entry,new Date('2000-01-01T00:00:00Z'),new Date('2000-01-01T00:00:00Z'));
  const zipPath=join(outputDir,'lambda.zip');await rm(zipPath,{force:true});
  try{await execute('zip',['-X','-q','-j',zipPath,entry],{maxBuffer:1024*1024});}catch{throw new Error('The zip tool is required to produce the AWS Lambda artifact.');}
  const zip=await readFile(zipPath),templatePath=join(outputDir,'template.json');await writeFile(templatePath,templateBytes);
  const manifest={schemaVersion:1,lambda:{path:zipPath,handler:'index.handler',sha256:hash(zip),sha256Base64:createHash('sha256').update(zip).digest('base64'),bytes:zip.length},template:{path:templatePath,sha256:hash(templateBytes),bytes:templateBytes.length},assets};
  const pending=join(outputDir,'manifest.json.tmp');await writeFile(pending,JSON.stringify(manifest,null,2)+'\n');await rename(pending,join(outputDir,'manifest.json'));
  return manifest;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const result=await packageAws();console.log(JSON.stringify({ok:true,manifest:join(projectRoot,'artifacts/aws/manifest.json'),lambdaBytes:result.lambda.bytes,lambdaSha256:result.lambda.sha256,assets:result.assets.length,templateBytes:result.template.bytes}));}
  catch(error){console.error(JSON.stringify({ok:false,message:error instanceof Error?error.message:'AWS packaging failed.'}));process.exitCode=1;}
}
