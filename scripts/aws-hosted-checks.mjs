import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,randomBytes} from 'node:crypto';

const invalidState=()=>new Error('Hosted checks require complete closed AWS staging state.');
function targets(state){
  const domain=state?.outputs?.CloudFrontDomain,endpoint=state?.outputs?.ApiEndpoint;
  if(state?.launchOpen!==false||state?.parameters?.LaunchOpen!=='false'||state?.parameters?.DataMode!=='sample'||typeof endpoint!=='string'||!(/^https:\/\/[a-z0-9-]+\.execute-api\.[a-z0-9-]+\.amazonaws\.com(?:\/[A-Za-z0-9_-]+)?\/?$/).test(endpoint)||typeof state?.stagingAccess!=='string'||!(/^Basic [A-Za-z0-9+/]{20,}={0,2}$/).test(state.stagingAccess)||typeof state?.runtime?.jobSecret!=='string'||state.runtime.jobSecret.length<32)throw invalidState();
  const api=endpoint.replace(/\/$/,'');
  if(state.parameters.FreeGatewayHosting!=='false'){
    const site=state.outputs.PublicGatewayOrigin;
    if(typeof site!=='string'||site.replace(/\/$/,'')!==api)throw invalidState();
    return{site:api,api,topology:'gateway'};
  }
  if(typeof domain!=='string'||!(/^[a-z0-9-]+\.cloudfront\.net$/).test(domain))throw invalidState();
  return{site:'https://'+domain,api,topology:'cloudfront'};
}
const failure=code=>Object.assign(new Error('Hosted verification failed.'),{code});
const noStore=response=>/(?:^|,)\s*no-store(?:\s|,|$)/i.test(response.headers.get('cache-control')||'');
const cookies=response=>response.headers.getSetCookie?.()||(response.headers.has('set-cookie')?[response.headers.get('set-cookie')]:[]);
const noCookie=response=>cookies(response).length===0;
const jsonBody=(response,text)=>{if(!/^application\/json\b/i.test(response.headers.get('content-type')||''))throw failure('INVALID_RESPONSE');try{return JSON.parse(text);}catch{throw failure('INVALID_RESPONSE');}};
function safeAuthError(response,text,code,message){
  const value=jsonBody(response,text),error=value?.error;
  return value&&Object.keys(value).length===1&&error&&Object.keys(error).length===2&&error.code===code&&error.message===message;
}
function secureHeaders(response){
  const h=response.headers,csp=h.get('content-security-policy')||'';
  return /(?:^|;)\s*max-age\s*=\s*(\d+)/i.exec(h.get('strict-transport-security')||'')?.[1]>=31536000&&h.get('x-content-type-options')?.toLowerCase()==='nosniff'&&h.get('x-frame-options')?.toUpperCase()==='DENY'&&h.get('referrer-policy')==='strict-origin-when-cross-origin'&&["default-src 'self'","script-src 'self'","object-src 'none'","base-uri 'none'","frame-ancestors 'none'","form-action 'self'"].every(rule=>csp.split(';').some(part=>part.trim()===rule))&&/camera=\(\)/.test(h.get('permissions-policy')||'')&&/microphone=\(\)/.test(h.get('permissions-policy')||'')&&/geolocation=\(\)/.test(h.get('permissions-policy')||'');
}
function secureDeletion(response){
  const values=cookies(response);if(values.length!==1)return false;
  const value=values[0];
  return /^__Host-beter-session=;/.test(value)&&/(?:^|;)\s*Secure(?:;|$)/i.test(value)&&/(?:^|;)\s*HttpOnly(?:;|$)/i.test(value)&&/(?:^|;)\s*Path=\/(?:;|$)/i.test(value)&&/(?:^|;)\s*SameSite=Lax(?:;|$)/i.test(value)&&/(?:^|;)\s*Max-Age=0(?:;|$)/i.test(value)&&!/(?:^|;)\s*Domain=/i.test(value);
}

/** GET-only by default. Synthetic auth probes require an explicit option and never use a real email. */
export async function checkAwsHosted({state,fetchImpl=globalThis.fetch,authProbes=false,now=()=>new Date(),randomId=randomUUID,timeoutMs=15000}={}){
  const{site,api,topology}=targets(state);
  if(typeof fetchImpl!=='function'||typeof authProbes!=='boolean'||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>120000)throw invalidState();
  const checkedAt=now().toISOString();
  const secrets=[state.stagingAccess,...Object.values(state.runtime||{}).filter(value=>typeof value==='string'&&value.length>=8)];
  const gated={'x-beter-staging-access':state.stagingAccess};
  const browser={...gated,'x-beter-client':'browser'};
  async function request(url,{headers={},method='GET',body}={}){
    const controller=new AbortController();let timer;
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(failure('REQUEST_TIMEOUT'));},timeoutMs);});
    const read=(async()=>{
      const response=await fetchImpl(url,{method,headers,redirect:'manual',signal:controller.signal,...(body!==undefined?{body:JSON.stringify(body)}:{})});
      if(response.status>=300&&response.status<400)throw failure('REDIRECT_REFUSED');
      if(Number(response.headers.get('content-length'))>131072)throw failure('RESPONSE_TOO_LARGE');
      let text='',size=0;
      if(response.body){
        const reader=response.body.getReader(),decoder=new TextDecoder();
        try{for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072)throw failure('RESPONSE_TOO_LARGE');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}
        finally{reader.releaseLock();}
      }
      if(secrets.some(secret=>text.includes(secret)||[...response.headers.values()].some(value=>value.includes(secret))))throw failure('SECRET_EXPOSED');
      return{response,text};
    })();
    try{return await Promise.race([read,deadline]);}
    finally{clearTimeout(timer);controller.abort();}
  }
  async function check(name,url,options,verify){
    try{const{response,text}=await request(url,options);return{name,ok:verify(response,text)===true,status:response.status};}
    catch(error){return{name,ok:false,code:['REQUEST_TIMEOUT','REDIRECT_REFUSED','RESPONSE_TOO_LARGE','SECRET_EXPOSED','INVALID_RESPONSE'].includes(error?.code)?error.code:'HTTP_UNAVAILABLE'};}
  }
  let siteResponse;
  const checks=await Promise.all([
    check('public-site-gate',site,{},response=>[401,403].includes(response.status)&&noStore(response)&&noCookie(response)),
    check('public-api-gate',site+'/api/config',{},response=>[401,403].includes(response.status)&&noStore(response)&&noCookie(response)),
    check('gated-site',site+'/',{headers:gated},(response,text)=>{siteResponse=response;return response.status===200&&/^text\/html\b/i.test(response.headers.get('content-type')||'')&&/Beter/i.test(text)&&noCookie(response);}),
    check('static-app-module',site+'/app.js',{headers:gated},(response,text)=>response.status===200&&/^(?:text|application)\/javascript\b/i.test(response.headers.get('content-type')||'')&&/(?:^|\n)\s*import\b/.test(text)&&response.headers.get('x-content-type-options')?.toLowerCase()==='nosniff'&&noCookie(response)),
    check('aws-sample-configuration',site+'/api/config',{headers:browser},(response,text)=>{const value=jsonBody(response,text);return response.status===200&&value.mode==='aws'&&value.dataMode==='sample'&&value.liveOddsConfigured===false&&noStore(response)&&noCookie(response);}),
    check('public-health',site+'/api/health',{headers:browser},(response,text)=>{const value=jsonBody(response,text);return response.status===200&&value.ok===true&&value.service==='beter-api'&&noStore(response)&&noCookie(response);}),
    check(topology==='gateway'?'direct-api-gate':'direct-api-blocked',api+'/api/health',{},response=>(topology==='gateway'?[401,403].includes(response.status):response.status===403)&&noStore(response)&&noCookie(response)),
    check('private-health-gate',site+'/api/health/details',{headers:gated},response=>response.status===403&&noStore(response)&&noCookie(response)),
    check('private-health',site+'/api/health/details',{headers:{...gated,authorization:'Bearer '+state.runtime.jobSecret}},(response,text)=>{const value=jsonBody(response,text);return response.status===200&&Number(value.schema_version)>=4&&value.ledger_mismatches===0&&value.unsettled_bets===0&&noStore(response)&&noCookie(response);}),
    check('anonymous-session',site+'/api/auth/session',{headers:browser},(response,text)=>response.status===200&&jsonBody(response,text).session===null&&noStore(response)&&noCookie(response)),
    check('anonymous-portfolio',site+'/api/portfolio',{headers:browser},(response,text)=>response.status===401&&jsonBody(response,text)?.error?.code==='AUTH_REQUIRED'&&noStore(response)&&noCookie(response)),
    check('secure-cookie-clearing',site+'/api/auth/session',{headers:{...browser,cookie:'__Host-beter-session=invalid-hosted-verification-cookie'}},(response,text)=>response.status===200&&jsonBody(response,text).session===null&&noStore(response)&&secureDeletion(response)),
  ]);
  checks.splice(3,0,{name:'security-headers',ok:Boolean(siteResponse&&secureHeaders(siteResponse))});
  if(authProbes){
    const identifier=String(randomId());if(!/^[0-9a-f-]{36}$/i.test(identifier))throw invalidState();
    const email='launch-probe-'+identifier+'@example.invalid',password='Beter-check-'+randomBytes(24).toString('base64url')+'!';
    const options={method:'POST',headers:{...browser,origin:site,'content-type':'application/json'},body:{email,password}};
    checks.push(await check('nonexistent-signin',site+'/api/auth/signin',options,(response,text)=>response.status===401&&safeAuthError(response,text,'AUTH_FAILED','Sign in failed. Check your details or confirm your email.')&&noStore(response)&&noCookie(response)));
    checks.push(await check('closed-signup',site+'/api/auth/signup',options,(response,text)=>response.status===403&&safeAuthError(response,text,'SIGNUP_UNAVAILABLE','Account registration is not available. Contact support or try again later.')&&noStore(response)&&noCookie(response)));
  }
  return{ok:checks.every(check=>check.ok),scope:'closed-staging',topology,publicLaunchReady:false,authProbes,checkedAt,checks};
}

export async function checkAwsHostedFromState({statePath=resolve('.data/aws-deploy/state.json'),readState=path=>readFile(path,'utf8'),...options}={}){
  let state;
  try{state=JSON.parse(await readState(statePath));}catch{throw new Error('Private AWS deployment state is unavailable or invalid.');}
  return checkAwsHosted({...options,state});
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.slice(2).some(value=>value!=='--auth-probes'))throw new Error('Use --auth-probes only to enable synthetic sign-in and denied-signup checks.');
    const result=await checkAwsHostedFromState({authProbes:process.argv.includes('--auth-probes')});
    console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
  }catch{console.error(JSON.stringify({ok:false,message:'Hosted checks could not run. Verify private closed staging state and connectivity.'}));process.exitCode=1;}
}
