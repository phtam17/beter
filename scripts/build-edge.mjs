import {mkdir,copyFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const target=resolve(root,'supabase/functions/_shared');
await mkdir(target,{recursive:true});
for(const name of ['api.ts','browser-session.ts','config.ts','provider.ts','grading.ts','jobs.ts','operations.ts','abuse.ts','supabase.ts'])await copyFile(resolve(root,'server',name),resolve(target,name));
for(const asset of ['index.html','app.js','api-client.js','styles.css','engine.js','markets.js'])await readFile(resolve(root,'dist',asset));
console.log('Validated web assets and prepared the portable Supabase function bundle.');
