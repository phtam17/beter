import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const security={
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'strict-origin-when-cross-origin',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
export function createWebHandler({root,api}:{root:string;api:(request:Request)=>Promise<Response>}){
  const directory=resolve(root);
  return async(request:Request):Promise<Response>=>{
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/')||url.pathname==='/api')return api(request);
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers:security});
    try{
      const path=resolve(directory,'.'+decodeURIComponent(url.pathname));
      if(path!==directory&&!path.startsWith(directory+sep))return new Response('Forbidden',{status:403,headers:security});
      const file=path===directory?resolve(directory,'index.html'):path;
      const data=await readFile(file);
      return new Response(request.method==='HEAD'?null:data,{headers:{...security,'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'}});
    }catch{return new Response('Not found',{status:404,headers:security});}
  };
}
export function nodeHandler(handle:(request:Request)=>Promise<Response>){
  return async(req:IncomingMessage,res:ServerResponse)=>{
    try{
      const chunks:Buffer[]=[];let size=0;
      const maxBytes=req.method==='POST'&&new URL(req.url||'/','http://localhost').pathname==='/api/ops/resolve'?1048576:32768;
      for await(const chunk of req){size+=chunk.length;if(size>maxBytes){res.writeHead(413,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'BODY_TOO_LARGE',message:'The request is too large.'}}));return;}chunks.push(chunk);}
      const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
      const scheme=req.headers['x-forwarded-proto']==='https'?'https':'http';
      const request=new Request(`${scheme}://${req.headers.host||'localhost'}${req.url||'/'}`,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method||'GET')?{body:Buffer.concat(chunks)}:{})});
      const response=await handle(request);
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
    }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'SERVER_ERROR',message:'The request could not be completed.'}}));}
  };
}
