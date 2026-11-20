/** Deployment-entry types; hosted execution uses Supabase's actual Deno runtime. */
declare const Deno: {
  env: {get(key:string):string|undefined};
  serve(handler:(request:Request)=>Response|Promise<Response>):unknown;
};
