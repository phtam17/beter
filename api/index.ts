import {createRuntime} from '../server/runtime.ts';
import {nodeHandler} from '../server/http.ts';
import type {IncomingMessage,ServerResponse} from 'node:http';
let runtime:ReturnType<typeof createRuntime>|undefined;
export function routeVercelUrl(value:string){
  const url=new URL(value,'https://beter.invalid');
  if(url.pathname!=='/api/index'||!url.searchParams.has('route'))return value;
  const path=url.searchParams.get('route')||'';
  if(!/^[a-z]+(?:\/[a-z]+)*$/.test(path)||path.length>100)return'/api/not-found';
  url.searchParams.delete('route');
  return'/api/'+path+(url.searchParams.size?'?'+url.searchParams:'');
}
export default async function handler(req:IncomingMessage,res:ServerResponse){
  try{
    req.url=routeVercelUrl(req.url||'/');
    runtime??=createRuntime({env:{...process.env,NODE_ENV:'production'}});
    const app=await runtime;
    return nodeHandler(app.handle)(req,res);
  }catch{res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:{code:'BACKEND_UNAVAILABLE',message:'The account service is not configured or temporarily unavailable.'}}));}
}
