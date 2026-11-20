import test from 'node:test';
import assert from 'node:assert/strict';
const module=await import('../server/grading.ts').catch(()=>({}));
const {gradeSelections,resultVersion}=module;
const event={id:'event-1',home_team:'Home',away_team:'Away'};
const result={id:'event-1',completed:true,home_team:'Home',away_team:'Away',home_score:108,away_score:104,updated_at:'2026-11-20T02:00:00.000Z'};
const selection=(id,market,side,line=null)=>({id,market,side,line,team:side==='home'?'Home':side==='away'?'Away':side,odds:-110});
const grade=(picks,score=result)=>{assert.equal(typeof gradeSelections,'function','Server-side final-result grading must exist');return gradeSelections(event,picks,score);};

test('grades both moneyline sides using confirmed final scores',()=>{
  assert.deepEqual(grade([selection('home','Moneyline','home'),selection('away','Moneyline','away')]),[{selection_id:'home',status:'won'},{selection_id:'away',status:'lost'}]);
});
test('returns the stake on a tied two-way moneyline',()=>{
  assert.equal(grade([selection('home','Moneyline','home')],{...result,away_score:108})[0].status,'void');
});
test('grades signed spreads, half-point losses and whole-point pushes',()=>{
  const picks=[selection('home-win','Spread','home',-3.5),selection('home-loss','Spread','home',-4.5),selection('home-push','Spread','home',-4),selection('away-win','Spread','away',4.5),selection('away-loss','Spread','away',3.5),selection('away-push','Spread','away',4),selection('pickem','Spread','home',0)];
  assert.deepEqual(grade(picks).map(x=>x.status),['won','lost','void','won','lost','void','won']);
});
test('grades over, under, exact-total pushes and zero scores',()=>{
  assert.deepEqual(grade([selection('o','Total','over',211.5),selection('u','Total','under',211.5),selection('p','Total','over',212)]).map(x=>x.status),['won','lost','void']);
  assert.equal(grade([selection('zero','Total','under',0.5)],{...result,home_score:0,away_score:0})[0].status,'won');
});
test('does not grade incomplete, mismatched, missing, negative or fractional final scores',()=>{
  assert.equal(typeof gradeSelections,'function');
  for(const change of [{completed:false},{id:'wrong'},{home_team:'wrong'},{away_team:'wrong'},{home_score:null},{away_score:-1},{home_score:1.5}])assert.throws(()=>grade([selection('s','Moneyline','home')],{...result,...change}),/final|match|score/i);
});
test('rejects malformed selections and unknown market scopes',()=>{
  for(const pick of [selection('x','Player points','home'),selection('x','Moneyline','over'),selection('x','Spread','home',null),selection('x','Spread','home',0.25),selection('x','Total','home',212),selection('x','Total','over',-1),{...selection('x','Moneyline','home'),team:'Other team'}])assert.throws(()=>grade([pick]),/selection|market|line|team/i);
  assert.throws(()=>grade([]),/selection/i);
});
test('final-result versions are deterministic and change with corrected evidence',()=>{
  assert.equal(typeof resultVersion,'function');
  const version=resultVersion(result);
  assert.equal(version,resultVersion({...result}));assert.notEqual(version,resultVersion({...result,home_score:109}));assert.notEqual(version,resultVersion({...result,updated_at:'2026-11-20T03:00:00Z'}));
  assert.throws(()=>resultVersion({...result,completed:false}),/final/i);
});
