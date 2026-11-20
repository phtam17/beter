import type { Backend } from './api.ts';
import { gradeSelections, resultVersion } from './grading.ts';

type Provider = {getEvents(sport:string):Promise<any[]>;getResults(sport:string):Promise<any[]>};
type Options = {
  backend: Pick<Backend,'rpc'>;
  provider: Provider;
  sports?: string[];
  now?: () => Date;
  overdueMs?: number;
  batchSize?: number;
};
type Candidate = {id:string;sport:string;home_team:string;away_team:string;starts_at?:string;bets:any[];[key:string]:any};
const sportKey = (sport:string) => ({Basketball:'basketball_nba',Football:'americanfootball_nfl',Hockey:'icehockey_nhl'}[sport] || sport);

async function reviewName(id:string) {
  if(Array.from(id).length<=90)return 'review:'+id;
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(id));
  return 'review:'+Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}

/** Each pass advances a durable keyset cursor, so unresolved events cannot starve later games. */
export async function runBackgroundJobs({backend,provider,sports=['basketball_nba','americanfootball_nfl','icehockey_nhl'],now=()=>new Date(),overdueMs=6*3600000,batchSize=100}:Options) {
  if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>100)throw new Error('Worker batch size must be between 1 and 100.');
  const timestamp=now().getTime();
  if(!Number.isFinite(timestamp)||!Number.isFinite(overdueMs)||overdueMs<=0)throw new Error('Worker clock and overdue threshold must be valid.');
  const report={ingested:0,settled:0,errors:0,review:0,nextCursor:null as string|null};
  const record=async(name:string,ok:boolean,detail:unknown)=>{
    try{await backend.rpc('beter_job_record',{p_name:name,p_ok:ok,p_detail:structuredClone(detail)},'$service');}
    catch{report.errors++;}
  };
  const priorReviews=new Set<string>();
  for(const sport of sports){
    try{
      const events=await provider.getEvents(sport);
      await backend.rpc('beter_ingest_events',{p_events:events},'$service');
      report.ingested+=events.length;
      await record('odds:'+sport,true,{events:events.length});
    }catch{
      report.errors++;
      await record('odds:'+sport,false,{code:'ODDS_INGESTION_FAILED',reason:'Provider ingestion failed; existing freshness limits remain in force.'});
    }
  }
  let candidates:Candidate[]=[];
  try{
    const health=await backend.rpc('beter_health',{},'$service');
    if(!Array.isArray(health?.jobs))throw new Error('Invalid worker state.');
    const previous=health.jobs.find((job:any)=>job.name==='pipeline')?.detail?.nextCursor;
    if(typeof previous==='string'&&previous.length<=250)report.nextCursor=previous;
    for(const job of health.jobs)if(job.ok===false&&typeof job.name==='string'&&job.name.startsWith('review:'))priorReviews.add(job.name);
    const batch=await backend.rpc('beter_settlement_batch',{p_after:report.nextCursor,p_limit:batchSize},'$service');
    if(!Array.isArray(batch?.events)||batch.events.length>batchSize||!(batch.nextCursor===null||typeof batch.nextCursor==='string'&&batch.nextCursor.length<=250))throw new Error('Invalid settlement batch.');
    candidates=batch.events;
    report.nextCursor=batch.nextCursor;
  }catch{
    report.errors++;
    await record('settlement',false,{code:'SETTLEMENT_BACKLOG_UNAVAILABLE',reason:'The settlement backlog could not be read; retry the durable cursor.'});
  }
  const overdue=(event:Candidate)=>event.bets.some(bet=>bet.status==='open')&&Number.isFinite(Date.parse(event.starts_at||''))&&timestamp-Date.parse(event.starts_at!)>overdueMs;
  const review=async(event:Candidate,code:string,reason:string)=>{
    report.errors++;report.review++;
    const started=Date.parse(event.starts_at||'');
    await record(await reviewName(event.id),false,{code,eventId:event.id,startsAt:event.starts_at||null,ageHours:Number.isFinite(started)?Math.floor((timestamp-started)/3600000):null,reason});
  };
  for(const sport of sports){
    const affected=candidates.filter(event=>sportKey(event.sport)===sport);
    if(!affected.length)continue;
    let results:any[];
    try{
      results=await provider.getResults(sport);
      await record('results:'+sport,true,{results:results.length});
    }catch{
      report.errors++;
      await record('results:'+sport,false,{code:'RESULT_RETRIEVAL_FAILED',reason:'Result retrieval failed.'});
      for(const event of affected)if(overdue(event))await review(event,'RESULT_RETRIEVAL_FAILED','This overdue event needs verified result evidence and operator review.');
      continue;
    }
    for(const event of affected){
      const result=results.find(item=>item.id===event.id);
      if(!result?.completed){
        if(overdue(event))await review(event,result?'RESULT_INCOMPLETE':'RESULT_MISSING','No confirmed final score is available for this overdue event. Verify provider evidence or use the audited operator resolution procedure.');
        continue;
      }
      try{
        const outcomes=event.bets.map(bet=>({bet_id:bet.id,status:gradeSelections(event,bet.selections,result)[0].status}));
        const applied=await backend.rpc('beter_settle',{p_event_id:event.id,p_outcomes:outcomes,p_result_version:resultVersion(result),p_evidence:result.evidence||result},'$service');
        report.settled+=Number(applied?.applied||0);
        const name=await reviewName(event.id);
        if(priorReviews.has(name))await record(name,true,{code:'RESULT_RESOLVED',eventId:event.id,reason:'Verified final evidence was processed successfully.'});
      }catch{
        await review(event,'RESULT_REVIEW_REQUIRED','Result could not be graded against accepted bets; operator review required.');
      }
    }
  }
  for(const event of candidates)if(!sports.includes(sportKey(event.sport))&&overdue(event))await review(event,'SPORT_UNSUPPORTED','This overdue event has no configured result processor; operator review required.');
  try{
    const maintenance=await backend.rpc('beter_maintenance',{p_batch_size:1000},'$service');
    await record('maintenance',true,maintenance);
  }catch{
    report.errors++;
    await record('maintenance',false,{code:'MAINTENANCE_FAILED',reason:'Operational record cleanup could not complete.'});
  }
  await record('pipeline',report.errors===0,report);
  return report;
}
