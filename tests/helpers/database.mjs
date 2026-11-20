import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

export const userA = '11111111-1111-4111-8111-111111111111';
export const userB = '22222222-2222-4222-8222-222222222222';

export async function createTestDatabase() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
  `);
  const directory=new URL('../../supabase/migrations/',import.meta.url);
  for(const name of (await readdir(directory)).filter(name=>/^\d+.*\.sql$/.test(name)).sort()){
    const migration=await readFile(new URL(name,directory),'utf8');if(migration.trim())await db.exec(migration);
  }
  return db;
}

export async function setUser(db,id=userA,role='authenticated') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);
  await db.exec(`set role ${role}`);
}

export async function rpc(db,name,args=[],signature='') {
  const result=await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)+(signature.split(',')[i]?'::'+signature.split(',')[i]:'')).join(',')}) as result`,args);
  return result.rows[0].result;
}

export function sampleEvent(overrides={}) {
  const now=Date.now();
  return {
    id:'nba-example',sport:'basketball_nba',league:'NBA',home_team:'New York Knicks',away_team:'Boston Celtics',
    starts_at:new Date(now+3600000).toISOString(),status:'upcoming',provider_updated_at:new Date(now).toISOString(),fetched_at:new Date(now).toISOString(),
    selections:[{id:'nba-home',team:'New York Knicks',market:'Moneyline',line:null,side:'home',odds:150,bookmaker:'example',provider_updated_at:new Date(now).toISOString(),fetched_at:new Date(now).toISOString()}],
    ...overrides,
  };
}

export async function ingest(db,events=[sampleEvent()]) {
  await setUser(db,null,'service_role');
  return rpc(db,'beter_ingest_events',[JSON.stringify(events)],'jsonb');
}

export async function createQuote(db,selection='nba-home',user=userA) {
  await setUser(db,user);
  return rpc(db,'beter_quote',[JSON.stringify([selection])],'jsonb');
}

export async function place(db,quote,stake=10000,key='request-one') {
  return rpc(db,'beter_place_bet',[quote.id,stake,key],'uuid,bigint,text');
}
