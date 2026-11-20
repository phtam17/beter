import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const module=await import('../aws/web-handler.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return{};throw error;});
const access='Basic '+Buffer.from('beter:private-static-access').toString('base64');
const env=()=>({BETER_STAGING_AUTH_HASH:createHash('sha256').update(access).digest('hex'),BETER_FUNDING_CUTOFF_AT:'2099-01-01T00:00:00'});
const event=(overrides={})=>({version:'2.0',rawPath:'/',rawQueryString:'',headers:{authorization:access},requestContext:{http:{method:'GET',sourceIp:'203.0.113.2'}},...overrides});
const assets=()=>({'/index.html':{body:'<!doctype html><title>Beter</title>',contentType:'text/html; charset=utf-8'},'/app.js':{body:Buffer.from('export const name="Beter";').toString('base64'),contentType:'text/javascript; charset=utf-8',isBase64Encoded:true},'/styles.css':{body:'body{color:black}',contentType:'text/css; charset=utf-8'},'/favicon.svg':{body:'<svg></svg>',contentType:'image/svg+xml'}});
function fixture(options={}){let loads=0;assert.equal(typeof module.createAwsWebHandler,'function');const handle=module.createAwsWebHandler({env:env(),loadAssets:async()=>{loads++;return assets();},...options});return{handle,get loads(){return loads;}};}

test('private static gateway denies before loading public assets and never exposes gate secrets',async()=>{
  const f=fixture();for(const headers of [{},{authorization:'Basic wrong'},{'x-beter-staging-access':'wrong',authorization:access}]){const response=await f.handle(event({headers}));assert.equal(response.statusCode,401);assert.match(response.headers['www-authenticate'],/Basic realm="Beter staging"/);assert.equal(response.headers['cache-control'],'no-store');assert.ok(!JSON.stringify(response).includes(access));}
  assert.equal(f.loads,0);
});
test('funding cutoff wins over valid access and public launch before loading assets',async()=>{
  for(const cutoff of ['2000-01-01T00:00:00','invalid',undefined]){const f=fixture({env:{...env(),BETER_LAUNCH_OPEN:'true',BETER_FUNDING_CUTOFF_AT:cutoff}});const response=await f.handle(event());assert.equal(response.statusCode,503);assert.match(response.body,/funding review/);assert.equal(f.loads,0);}
  const f=fixture({env:{...env(),BETER_FUNDING_CUTOFF_AT:'2026-11-20T20:00:00'},now:()=>new Date('2026-11-20T20:00:00Z')});assert.equal((await f.handle(event())).statusCode,503);assert.equal(f.loads,0);
});
test('static gateway serves only canonical allowlisted assets with fixed MIME and safe headers',async()=>{
  const f=fixture();for(const [path,mime] of [['/','text/html; charset=utf-8'],['/index.html','text/html; charset=utf-8'],['/app.js','text/javascript; charset=utf-8'],['/styles.css','text/css; charset=utf-8'],['/favicon.svg','image/svg+xml']]){
    const response=await f.handle(event({rawPath:path}));assert.equal(response.statusCode,200);assert.equal(response.headers['content-type'],mime);assert.equal(response.headers['x-content-type-options'],'nosniff');assert.equal(response.headers['x-frame-options'],'DENY');assert.match(response.headers['strict-transport-security'],/max-age=31536000/);assert.match(response.headers['content-security-policy'],/frame-ancestors 'none'/);assert.match(response.headers['permissions-policy'],/camera=\(\)/);assert.equal(response.headers['cache-control'],'no-cache');assert.equal(response.cookies,undefined);
    if(path==='/app.js'){assert.equal(response.isBase64Encoded,true);assert.match(Buffer.from(response.body,'base64').toString(),/Beter/);}
  }
  assert.equal(f.loads,1);
});
test('HEAD preserves asset metadata without a body and machine access works independently of account bearer tokens',async()=>{
  const f=fixture();const head=await f.handle(event({rawPath:'/app.js',headers:{'x-beter-staging-access':access,authorization:'Bearer private-account'},requestContext:{http:{method:'HEAD'}}}));assert.equal(head.statusCode,200);assert.equal(head.body,'');assert.equal(head.isBase64Encoded,false);assert.equal(head.headers['content-type'],'text/javascript; charset=utf-8');assert.equal(head.headers['content-length'],String(Buffer.byteLength('export const name="Beter";')));
});
test('unknown, API, malformed, encoded, hidden and traversal paths never serve the index fallback',async()=>{
  const f=fixture();for(const path of ['/missing','/api','/api/health','/.env','/source.map','/__proto__'])assert.equal((await f.handle(event({rawPath:path}))).statusCode,404);
  for(const path of ['https://evil.example/','//app.js','/../app.js','/x/./app.js','/%2e%2e/index.html','/%61pp.js','/app.js?x','/app.js#x','/x\\app.js','/x\u0000.js'])assert.equal((await f.handle(event({rawPath:path}))).statusCode,400);
});
test('unsupported HTTP or scheduler inputs never load or mutate assets',async()=>{
  const f=fixture();assert.equal((await f.handle(event({requestContext:{http:{method:'POST'}}}))).statusCode,405);assert.equal((await f.handle({source:'beter.scheduler',task:'process'})).statusCode,403);assert.equal(f.loads,0);
});
test('asset load failures are safe, retryable, and cannot expose filesystem or provider details',async()=>{
  let loads=0;const f=fixture({loadAssets:async()=>{loads++;if(loads===1)throw Error('/private/credential=hidden');return assets();}});const failed=await f.handle(event());assert.equal(failed.statusCode,503);assert.doesNotMatch(failed.body,/credential|hidden|private/);assert.equal((await f.handle(event())).statusCode,200);
});
test('misconfigured map content cannot serve executable HTML under another MIME or invalid base64',async()=>{
  for(const asset of [{body:'<script>private</script>',contentType:'text/html'},{body:'invalid base64!',contentType:'text/javascript; charset=utf-8',isBase64Encoded:true},{body:4,contentType:'text/javascript; charset=utf-8'}]){const f=fixture({loadAssets:async()=>({'/app.js':asset})});const response=await f.handle(event({rawPath:'/app.js'}));assert.equal(response.statusCode,503);assert.doesNotMatch(response.body,/script|private|base64/);}
});
test('explicit launch skips only the access gate, retains funding and never accepts an unknown asset',async()=>{
  const f=fixture({env:{BETER_LAUNCH_OPEN:'true',BETER_FUNDING_CUTOFF_AT:'2099-01-01T00:00:00'}});assert.equal((await f.handle(event({headers:{}}))).statusCode,200);assert.equal((await f.handle(event({headers:{},rawPath:'/not-there'}))).statusCode,404);
});
