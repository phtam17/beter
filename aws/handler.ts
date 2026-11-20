import {timingSafeEqual} from 'node:crypto';

type Runtime={
  settings?:{siteUrl?:string;jobSecret?:string;originSecret?:string;environment?:string};
  originSecret?:string;
  handle:(request:Request)=>Promise<Response>;
  runJobs:()=>Promise<unknown>;
};
type Metric={name:'WorkerSuccess'|'ReadinessSuccess';value:0|1};
type Options={getRuntime?:()=>Promise<Runtime>;workerTask?:'process'|'monitor';onMetric?:(metric:Metric)=>void;env?:Record<string,string|undefined>};
type HttpEvent={version?:string;rawPath?:string;rawQueryString?:string;headers?:Record<string,string|undefined>;cookies?:string[];body?:string;isBase64Encoded?:boolean;requestContext?:{http?:{method?:string;sourceIp?:string}};source?:string;task?:string};
const safeResponse=(statusCode:number,code:string,message:string)=>({statusCode,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'},body:JSON.stringify({error:{code,message}}),isBase64Encoded:false});
const denied=()=>safeResponse(403,'FORBIDDEN','This endpoint is not available through this connection.');
const safeIp=(value:unknown):value is string=>typeof value==='string'&&value.length<=64&&/^[0-9a-f:.]+$/i.test(value);
function matches(left:string,right:string){const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);}

/** The API and scheduled functions are separate IAM targets using the same artifact. */
export function createAwsHandler({getRuntime,workerTask,onMetric,env=process.env}:Options={}){
  let pending:Promise<Runtime>|undefined;
  const runtime=()=>{
    pending??=(getRuntime?getRuntime():import('../server/aws-runtime.ts').then(module=>module.createAwsRuntime({env}))).catch(error=>{pending=undefined;throw error;});
    return pending;
  };
  const metric=onMetric||((item:Metric)=>{
    const Environment=env.BETER_ENVIRONMENT==='production'?'production':'staging';
    console.log(JSON.stringify({_aws:{Timestamp:Date.now(),CloudWatchMetrics:[{Namespace:'Beter',Dimensions:[['Environment']],Metrics:[{Name:item.name,Unit:'Count'}]}]},Environment,[item.name]:item.value}));
  });
  return async(event:HttpEvent)=>{
    const http=event?.version==='2.0'&&typeof event.requestContext?.http?.method==='string';
    if(!http){
      if(!workerTask||event?.source!=='beter.scheduler'||event.task!==workerTask)return denied();
      try{
        const app=await runtime();
        if(workerTask==='process'){
          const report=await app.runJobs() as {errors?:unknown};
          const ok=report?.errors===0;metric({name:'WorkerSuccess',value:ok?1:0});return{ok};
        }
        const response=await app.handle(new Request(new URL('/api/ready',app.settings?.siteUrl),{headers:{Authorization:'Bearer '+(app.settings?.jobSecret||'')}}));
        const payload=await response.json() as {ready?:unknown};const ok=response.ok&&payload?.ready===true;
        metric({name:'ReadinessSuccess',value:ok?1:0});return{ok};
      }catch{
        metric({name:workerTask==='process'?'WorkerSuccess':'ReadinessSuccess',value:0});
        throw new Error(workerTask==='process'?'Scheduled processing could not complete.':'Scheduled readiness could not complete.');
      }
    }
    if(workerTask)return denied();
    const headers=new Headers();
    for(const [name,value]of Object.entries(event.headers||{}))if(typeof value==='string')headers.set(name,value);
    const provided=headers.get('x-beter-origin-secret');if(!provided)return denied();
    try{
      const app=await runtime();const expected=app.originSecret||app.settings?.originSecret||'';
      if(expected.length<32)return safeResponse(503,'SETUP_REQUIRED','The application connection is not configured.');
      if(!matches(provided,expected))return denied();
      const path=event.rawPath||'/';let decoded:string;
      try{decoded=decodeURIComponent(path);}catch{return safeResponse(400,'INVALID_REQUEST','Send a valid request path.');}
      if(!path.startsWith('/')||/[\\?#\u0000-\u001f]/.test(decoded)||decoded.split('/').some(part=>part==='.'||part==='..'))return safeResponse(400,'INVALID_REQUEST','Send a valid request path.');
      if(path!=='/api'&&!path.startsWith('/api/'))return safeResponse(404,'NOT_FOUND','This endpoint does not exist.');
      const method=event.requestContext!.http!.method!;
      if(!['GET','HEAD','POST','OPTIONS'].includes(method))return safeResponse(405,'METHOD_NOT_ALLOWED','This method is not supported.');
      const rawBody=event.body||'';
      if(event.isBase64Encoded&&!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(rawBody))return safeResponse(400,'INVALID_REQUEST','Send a valid encoded request body.');
      const body=Buffer.from(rawBody,event.isBase64Encoded?'base64':'utf8');
      if(body.length>(method==='POST'&&path==='/api/ops/resolve'?1048576:32768))return safeResponse(413,'BODY_TOO_LARGE','The request is too large.');
      const viewerIp=headers.get('x-beter-viewer-ip');
      for(const name of ['host','forwarded','x-forwarded-proto','x-forwarded-host','x-forwarded-for','x-beter-origin-secret','x-beter-viewer-ip','x-beter-staging-access','x-beter-source-ip'])headers.delete(name);
      const source=safeIp(viewerIp)?viewerIp:event.requestContext?.http?.sourceIp;
      if(safeIp(source))headers.set('x-beter-source-ip',source);
      if(event.cookies){if(!Array.isArray(event.cookies)||!event.cookies.every(cookie=>typeof cookie==='string'))return safeResponse(400,'INVALID_REQUEST','Send valid account cookies.');headers.set('Cookie',event.cookies.join('; '));}
      const origin=new URL(app.settings?.siteUrl||'');
      if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Invalid deployment origin');
      const request=new Request(origin.origin+path+(event.rawQueryString?'?'+event.rawQueryString:''),{method,headers,...(!['GET','HEAD'].includes(method)?{body}: {})});
      const response=await app.handle(request),output=new Headers(response.headers);
      const cookies=typeof response.headers.getSetCookie==='function'?response.headers.getSetCookie():response.headers.has('set-cookie')?[response.headers.get('set-cookie')!]:[];
      output.delete('set-cookie');output.delete('content-length');output.set('Cache-Control','no-store');output.set('X-Content-Type-Options','nosniff');
      const textual=/^(text\/|application\/(?:[a-z.+-]*json|javascript))/i.test(output.get('Content-Type')||'application/json');
      const bytes=Buffer.from(await response.arrayBuffer());
      return{statusCode:response.status,headers:Object.fromEntries(output),...(cookies.length?{cookies}:{}),body:bytes.toString(textual?'utf8':'base64'),isBase64Encoded:!textual};
    }catch{return safeResponse(503,'APPLICATION_UNAVAILABLE','The application is temporarily unavailable. Please try again.');}
  };
}

/** Cognito's public signup API remains closed alongside the website until launch. */
export async function preSignupHandler<T extends {request?:{userAttributes?:{email?:string}}}>(event:T,{env=process.env}:{env?:Record<string,string|undefined>}={}){
  if(env.BETER_LAUNCH_OPEN==='true')return event;
  const email=event.request?.userAttributes?.email?.trim().toLowerCase();
  const allowed=(env.BETER_TEST_EMAILS||'').split(',').map(value=>value.trim().toLowerCase()).filter(Boolean);
  if(!email||!allowed.includes(email))throw new Error('Account registration is not open.');
  return event;
}

export const handler=createAwsHandler({workerTask:process.env.BETER_AWS_TASK==='process'?'process':process.env.BETER_AWS_TASK==='monitor'?'monitor':undefined});
