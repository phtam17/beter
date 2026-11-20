import { createServer } from 'node:http';
import { resolve } from 'node:path';
import {createRuntime} from './server/runtime.ts';
import {createWebHandler,nodeHandler} from './server/http.ts';
for(const file of ['.env','.env.local']){try{process.loadEnvFile(file);}catch(error){if(error.code!=='ENOENT')throw error;}}
const port = Number(process.env.PORT || 4173);
const runtime=await createRuntime({env:process.env});
if(runtime.settings.mode!=='unconfigured')try{await runtime.runJobs();}catch{console.log('Market synchronization is waiting for a configured data provider.');}
const server=createServer(nodeHandler(createWebHandler({root:resolve(import.meta.dirname,'dist'),api:runtime.handle})));
const timer=setInterval(()=>{runtime.runJobs().catch(()=>console.log('Market synchronization requires attention.'));},60000);timer.unref();
server.listen(port,'127.0.0.1',()=>console.log(`Beter is ready at http://127.0.0.1:${port} (${runtime.settings.mode} accounts, ${runtime.settings.dataMode} odds)`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{clearInterval(timer);server.close(async()=>{await runtime.close();process.exit(0);});});
