import test from 'node:test';
import assert from 'node:assert/strict';
const {readSettings}=await import('../server/config.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const settings=env=>{assert.equal(typeof readSettings,'function','Explicit local and hosted settings are required.');return readSettings(env);};
test('development uses an explicitly identified local sample feed',()=>{const s=settings({});assert.equal(s.mode,'local');assert.equal(s.dataMode,'sample');assert.equal(s.liveOddsConfigured,false);});
test('production without credentials refuses to start a local account database',()=>{assert.throws(()=>settings({NODE_ENV:'production'}),/production.*configuration/i);});
test('hosted mode requires complete Supabase configuration',()=>{assert.equal(settings({SUPABASE_URL:'https://x.supabase.co'}).mode,'unconfigured');const s=settings({SUPABASE_URL:'https://x.supabase.co',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'private',ODDS_API_KEY:'odds'});assert.equal(s.mode,'supabase');assert.equal(s.dataMode,'live');assert.equal(s.liveOddsConfigured,true);});
test('sample data must be selected explicitly outside local development',()=>{assert.equal(settings({SUPABASE_URL:'https://x.supabase.co',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'private',BETER_DATA_MODE:'sample'}).dataMode,'sample');assert.throws(()=>settings({BETER_DATA_MODE:'unknown'}),/data mode/i);});
test('production background jobs require a strong worker secret',()=>{assert.throws(()=>settings({NODE_ENV:'production',JOB_SECRET:'short'}),/secret/i);});
