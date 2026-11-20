import {createHash,timingSafeEqual} from 'node:crypto';

export type AwsHttpEvent={version?:string;rawPath?:string;rawQueryString?:string;headers?:Record<string,string|undefined>;requestContext?:{http?:{method?:string;sourceIp?:string}}};
export type AwsHttpResponse={statusCode:number;headers:Record<string,string>;body:string;isBase64Encoded:boolean};
type Asset={body:string;contentType:string;isBase64Encoded?:boolean};
type AssetMap=Record<string,Asset>;
type Options={loadAssets:()=>Promise<AssetMap>;env?:Record<string,string|undefined>;now?:()=>Date};
export const awsSecurityHeaders={
  'x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'strict-origin-when-cross-origin',
  'strict-transport-security':'max-age=31536000','permissions-policy':'camera=(), microphone=(), geolocation=()',
  'content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function response(statusCode:number,message:string,headers:Record<string,string>={}):AwsHttpResponse{
  return{statusCode,headers:{...awsSecurityHeaders,'content-type':'text/plain; charset=utf-8','cache-control':'no-store',...headers},body:message,isBase64Encoded:false};
}

/** A public Gateway replaces CloudFront's private staging gate, before assets or runtime access. */
export function gatewayAccess(event:AwsHttpEvent,{env=process.env,now=()=>new Date()}:{env?:Record<string,string|undefined>;now?:()=>Date}={}):AwsHttpResponse|null{
  if(event?.version!=='2.0'||typeof event.requestContext?.http?.method!=='string')return response(403,'This endpoint is not available through this connection.');
  const value=env.BETER_FUNDING_CUTOFF_AT,time=now().getTime();
  const cutoff=typeof value==='string'?Date.parse(value.endsWith('Z')?value:value+'Z'):NaN;
  if(!Number.isFinite(time)||!Number.isFinite(cutoff)||time>=cutoff)return response(503,'This environment is paused for a funding review.');
  if(env.BETER_LAUNCH_OPEN==='true')return null;
  const expected=env.BETER_STAGING_AUTH_HASH;
  if(typeof expected!=='string'||!/^[a-f0-9]{64}$/i.test(expected))return response(503,'Private staging access is not configured.');
  let headers:Headers;
  try{headers=new Headers();for(const[name,value]of Object.entries(event.headers||{}))if(typeof value==='string')headers.set(name,value);}
  catch{return response(400,'Send valid request headers.');}
  const candidate=headers.has('x-beter-staging-access')?headers.get('x-beter-staging-access')!:headers.get('authorization')||'';
  const actual=createHash('sha256').update(candidate).digest();
  if(!candidate||candidate.length>4096||!timingSafeEqual(actual,Buffer.from(expected,'hex')))return response(401,'This staging environment requires access credentials.',{'www-authenticate':'Basic realm="Beter staging", charset="UTF-8"'});
  return null;
}

const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.webmanifest':'application/manifest+json','.txt':'text/plain; charset=utf-8'};
/** The static Lambda has public bytes only; its role needs no database or secret permissions. */
export function createAwsWebHandler({loadAssets,env=process.env,now=()=>new Date()}:Options){
  let pending:Promise<AssetMap>|undefined;
  const assets=()=>pending??=(Promise.resolve().then(loadAssets).catch(error=>{pending=undefined;throw error;}));
  async function serve(event:AwsHttpEvent):Promise<AwsHttpResponse>{
    const gated=gatewayAccess(event,{env,now});if(gated)return gated;
    const method=event.requestContext!.http!.method!;
    if(!['GET','HEAD'].includes(method))return response(405,'This method is not supported.',{allow:'GET, HEAD'});
    const path=event.rawPath||'/';
    if(!path.startsWith('/')||path.startsWith('//')||/[%\\?#\u0000-\u0020\u007f]/.test(path)||path.split('/').some(part=>part==='.'||part==='..')||path.includes('//'))return response(400,'Send a valid request path.');
    if(path==='/api'||path.startsWith('/api/')||path.split('/').some(part=>part.startsWith('.')))return response(404,'This file does not exist.');
    const key=path==='/'?'/index.html':path,contentType=mime[key.slice(key.lastIndexOf('.')).toLowerCase()];
    if(!contentType)return response(404,'This file does not exist.');
    try{
      const map=await assets();
      if(!map||typeof map!=='object'||!Object.hasOwn(map,key))return response(404,'This file does not exist.');
      const asset=map[key];
      if(!asset||typeof asset.body!=='string'||asset.contentType!==contentType||(asset.isBase64Encoded!==undefined&&typeof asset.isBase64Encoded!=='boolean'))throw new Error('Invalid public asset.');
      if(asset.isBase64Encoded&&(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.body)||Buffer.from(asset.body,'base64').toString('base64')!==asset.body))throw new Error('Invalid public asset.');
      const size=Buffer.byteLength(asset.body,asset.isBase64Encoded?'base64':'utf8');
      if(size>4000000)throw new Error('Invalid public asset.');
      return{statusCode:200,headers:{...awsSecurityHeaders,'content-type':contentType,'content-length':String(size),'cache-control':'no-cache'},body:asset.body,isBase64Encoded:asset.isBase64Encoded===true};
    }catch{return response(503,'The website is temporarily unavailable. Please try again.');}
  }
  return async(event:AwsHttpEvent):Promise<AwsHttpResponse>=>{
    const result=await serve(event);
    return event?.requestContext?.http?.method==='HEAD'?{...result,body:'',isBase64Encoded:false}:result;
  };
}

export const assetsHandler=createAwsWebHandler({loadAssets:()=>import('beter:public-assets').then(module=>module.assets)});
