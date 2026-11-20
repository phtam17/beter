import {createHash,randomUUID} from 'node:crypto';
import {createAuthLimiter} from './abuse.ts';
import type {Backend} from './api.ts';
type SupportRequest={email:string;topic:'general'|'privacy'|'delete-account';message:string;reference:string};
type Options={handle:(request:Request)=>Promise<Response>;backend:Pick<Backend,'rpc'>;secret:string;siteUrl:string;sendSupport:(request:SupportRequest)=>Promise<unknown>;trustProxy:'aws'};
class SupportFault extends Error{status:number;code:string;constructor(status:number,code:string,message:string){super(message);this.status=status;this.code=code;}}
const json=(value:unknown,status:number,headers:Record<string,string>={})=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
async function readSupportBody(request:Request){
 if(Number(request.headers.get('Content-Length'))>8192)throw new SupportFault(413,'BODY_TOO_LARGE','Your message is too large. Shorten it and try again.');
 const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>8192){await reader.cancel();throw new SupportFault(413,'BODY_TOO_LARGE','Your message is too large. Shorten it and try again.');}chunks.push(chunk.value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new SupportFault(400,'INVALID_SUPPORT_REQUEST','Enter a valid email, topic, and a message of 10 to 4,000 characters.');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new SupportFault(400,'INVALID_SUPPORT_REQUEST','Enter a valid email, topic, and a message of 10 to 4,000 characters.');
 const body=value as Record<string,unknown>,email=typeof body.email==='string'?body.email.trim().toLowerCase():'',message=typeof body.message==='string'?body.message.trim():'';
 if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)||!['general','privacy','delete-account'].includes(String(body.topic))||typeof body.topic!=='string'||[...message].length<10||[...message].length>4000)throw new SupportFault(400,'INVALID_SUPPORT_REQUEST','Enter a valid email, topic, and a message of 10 to 4,000 characters.');
 return{email,topic:body.topic as SupportRequest['topic'],message};
}
/** Public support uses a separate durable quota namespace and confirms delivery before acceptance. */
export function createAwsSupportHandler({handle,backend,secret,siteUrl,sendSupport,trustProxy}:Options){
 let origin:URL;try{origin=new URL(siteUrl);}catch{throw new Error('Support requires a configured HTTPS origin.');}
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Support requires a configured HTTPS origin.');
 if(typeof secret!=='string'||secret.length<32||typeof sendSupport!=='function')throw new Error('Support requires a private secret and configured delivery.');
 const limiter=createAuthLimiter({backend,trustProxy,secret:createHash('sha256').update('beter-support:'+secret).digest('hex')});
 return async(request:Request):Promise<Response>=>{
  const url=new URL(request.url);if(request.method!=='POST'||url.pathname!=='/api/support')return handle(request);
  try{
   if(request.headers.get('Origin')!==origin.origin||url.origin!==origin.origin)throw new SupportFault(403,'ORIGIN_DENIED','Open the support form on Beter to send a request.');
   if(request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new SupportFault(415,'UNSUPPORTED_MEDIA_TYPE','Send the support form as JSON.');
   const body=await readSupportBody(request),limit=await limiter(request,'recover',body.email);
   if(!limit.allowed)return json({error:{code:'RATE_LIMITED',message:'Too many support requests. Wait before trying again.'}},429,{'Retry-After':String(limit.retryAfterSeconds||60)});
   const reference='BTR-'+randomUUID();await sendSupport({...body,reference});
   return json({accepted:true,reference},202);
  }catch(error){if(error instanceof SupportFault)return json({error:{code:error.code,message:error.message}},error.status);return json({error:{code:'SUPPORT_UNAVAILABLE',message:'Your request has not been confirmed as sent. Please try again later.'}},503);}
 };
}
