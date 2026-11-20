type ReadinessOptions = {
  now?: () => Date;
  maxHeartbeatAgeMs?: number;
  requiredJobs?: string[];
};
type Check = {name:string;ok:boolean;code:string;count?:number;ageSeconds?:number};
type Job = {name:string;ok:boolean;created_at:string};
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;

/** Evaluate only durable, non-sensitive health fields; provider payloads never cross this boundary. */
export function evaluateReadiness(health:unknown,{now=()=>new Date(),maxHeartbeatAgeMs=150000,requiredJobs=['odds:basketball_nba','odds:americanfootball_nfl','odds:icehockey_nhl']}:ReadinessOptions={}) {
  const checks:Check[]=[];
  const timestamp=now().getTime();
  const value=health as {ledger_mismatches?:unknown;unsettled_bets?:unknown;jobs?:unknown}|null;
  if(!Number.isFinite(timestamp)||!Number.isFinite(maxHeartbeatAgeMs)||maxHeartbeatAgeMs<=0||!value||!count(value.ledger_mismatches)||!count(value.unsettled_bets)||!Array.isArray(value.jobs)){
    return {ready:false,checks:[{name:'database',ok:false,code:'HEALTH_UNAVAILABLE'}]};
  }
  checks.push({name:'database',ok:true,code:'HEALTH_AVAILABLE'});
  checks.push({name:'ledger',ok:value.ledger_mismatches===0,code:value.ledger_mismatches===0?'LEDGER_RECONCILED':'LEDGER_MISMATCH',count:value.ledger_mismatches});
  checks.push({name:'settlements',ok:value.unsettled_bets===0,code:value.unsettled_bets===0?'SETTLEMENTS_CURRENT':'SETTLEMENTS_OVERDUE',count:value.unsettled_bets});
  const jobs=value.jobs as Job[];
  const age=(job:Job)=>timestamp-Date.parse(job.created_at);
  const fresh=(job:Job)=>Number.isFinite(age(job))&&age(job)>=-30000&&age(job)<=maxHeartbeatAgeMs;
  const pipeline=jobs.find(job=>job?.name==='pipeline');
  const workerCode=!pipeline?'WORKER_MISSING':!fresh(pipeline)?'WORKER_STALE':pipeline.ok!==true?'WORKER_FAILED':'WORKER_CURRENT';
  checks.push({name:'worker',ok:workerCode==='WORKER_CURRENT',code:workerCode,...(pipeline&&Number.isFinite(age(pipeline))?{ageSeconds:Math.max(0,Math.floor(age(pipeline)/1000))}:{})});
  const badFeeds=requiredJobs.filter(name=>{const job=jobs.find(job=>job?.name===name);return !job||job.ok!==true||!fresh(job);}).length;
  checks.push({name:'ingestion',ok:badFeeds===0,code:badFeeds===0?'FEEDS_CURRENT':'FEEDS_UNAVAILABLE',count:badFeeds});
  const reviewJob=(job:Job)=>typeof job?.name==='string'&&job.name.startsWith('review:');
  const reviews=jobs.filter(job=>reviewJob(job)&&job.ok===false).length;
  checks.push({name:'reviews',ok:reviews===0,code:reviews===0?'NO_UNRESOLVED_REVIEWS':'UNRESOLVED_REVIEWS',count:reviews});
  const failures=jobs.filter(job=>!reviewJob(job)&&job?.ok===false&&fresh(job)).length;
  checks.push({name:'failures',ok:failures===0,code:failures===0?'NO_RECENT_FAILURES':'RECENT_JOB_FAILURES',count:failures});
  return {ready:checks.every(check=>check.ok),checks};
}
