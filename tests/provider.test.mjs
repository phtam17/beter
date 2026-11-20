import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../server/provider.ts').catch(() => ({}));
const { createOddsProvider, createSampleProvider } = module;
const NOW = new Date('2026-11-20T02:00:00.000Z');
const timestamp = '2026-11-20T01:59:45.000Z';
const options = extra => ({ apiKey: 'test-private-key', now: () => NOW, ...extra });
const event = () => ({
  id: 'provider-event-1', sport_key: 'basketball_nba',
  commence_time: '2026-11-20T04:00:00.000Z', home_team: 'New York Knicks', away_team: 'Boston Celtics',
  bookmakers: [{key:'draftkings',last_update:timestamp,markets:[
    {key:'h2h',last_update:timestamp,outcomes:[{name:'Boston Celtics',price:-175},{name:'New York Knicks',price:150}]},
    {key:'spreads',last_update:timestamp,outcomes:[{name:'Boston Celtics',price:-110,point:-4.5},{name:'New York Knicks',price:-110,point:4.5}]},
    {key:'totals',last_update:timestamp,outcomes:[{name:'Over',price:-110,point:224.5},{name:'Under',price:-110,point:224.5}]}
  ]}]
});
const response = body => new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const make = extra => {
  assert.equal(typeof createOddsProvider,'function','The real odds-provider adapter must exist');
  return createOddsProvider(options(extra));
};

test('normalizes real bookmaker market shapes without exposing the provider key', async () => {
  let requested;
  const provider=make({fetchImpl:async(url,init)=>{requested={url:new URL(url),init};return response([event()]);}});
  const events=await provider.getEvents('basketball_nba');
  assert.equal(requested.url.origin,'https://api.the-odds-api.com');
  assert.equal(requested.url.searchParams.get('apiKey'),'test-private-key');
  assert.equal(requested.url.searchParams.get('bookmakers'),'draftkings');
  assert.equal(requested.url.searchParams.get('markets'),'h2h,spreads,totals');
  assert.equal(requested.url.searchParams.get('oddsFormat'),'american');
  assert.equal(requested.init.headers.Accept,'application/json');
  assert.equal(events[0].sport,'Basketball');assert.equal(events[0].league,'NBA');
  assert.equal(events[0].status,'upcoming');assert.equal(events[0].selections.length,6);
  assert.equal(events[0].fetched_at,NOW.toISOString());
  assert.deepEqual(events[0].selections.map(s=>[s.market,s.side,s.line,s.odds]),[
    ['Moneyline','away',null,-175],['Moneyline','home',null,150],
    ['Spread','away',-4.5,-110],['Spread','home',4.5,-110],
    ['Total','over',224.5,-110],['Total','under',224.5,-110]
  ]);
  assert.equal(JSON.stringify(events).includes('test-private-key'),false);
});

test('selection identity remains stable when the price or line changes',async()=>{
  const raw=event();let call=0;
  const provider=make({fetchImpl:async()=>{call++;if(call===2){raw.bookmakers[0].markets[1].outcomes[0].point=-5.5;raw.bookmakers[0].markets[1].outcomes[1].point=5.5;raw.bookmakers[0].markets[1].outcomes[0].price=-120;}return response([raw]);}});
  const before=(await provider.getEvents())[0].selections;
  const after=(await provider.getEvents())[0].selections;
  assert.equal(before[2].id,after[2].id);assert.equal(after[2].line,-5.5);assert.equal(after[2].odds,-120);
});

test('a missing reference bookmaker keeps the event but offers no prices',async()=>{
  const raw=event();raw.bookmakers=[];
  const values=await make({fetchImpl:async()=>response([raw])}).getEvents();
  assert.equal(values.length,1);assert.deepEqual(values[0].selections,[]);
});

test('ignores unsupported and three-way markets instead of treating them as two-way bets',async()=>{
  const raw=event();raw.bookmakers[0].markets.push({key:'player_points',outcomes:[{name:'Example player',price:100,point:20.5}]});
  raw.bookmakers[0].markets[0].outcomes.push({name:'Draw',price:250});
  const value=(await make({fetchImpl:async()=>response([raw])}).getEvents())[0];
  assert.equal(value.selections.length,4);assert.ok(value.selections.every(s=>s.market!=='Moneyline'));
});

test('maps selected NFL and NHL sports and marks past starts as live',async()=>{
  for(const [key,sport,league] of [['americanfootball_nfl','Football','NFL'],['icehockey_nhl','Hockey','NHL']]){
    const raw=event();raw.sport_key=key;raw.commence_time='2026-11-20T01:00:00Z';
    const actual=(await make({fetchImpl:async()=>response([raw])}).getEvents(key))[0];
    assert.equal(actual.sport,sport);assert.equal(actual.league,league);assert.equal(actual.status,'live');
  }
});

test('requires a private key, safe bookmaker key, and supported sport',async()=>{
  assert.throws(()=>make({apiKey:''}),/key.*configured/i);
  assert.throws(()=>make({bookmaker:'../unsafe'}),/bookmaker/i);
  await assert.rejects(make({fetchImpl:async()=>response([])}).getEvents('soccer_epl'),/supported sport/i);
});

test('handles provider rate limiting, downtime, bad JSON and network errors without leaking secrets',async()=>{
  const fetchers=[
    async()=>new Response('sensitive upstream text',{status:429}),
    async()=>new Response('sensitive upstream text',{status:503}),
    async()=>new Response('bad json',{status:200}),
    async()=>{throw new Error('https://api.example.com/?apiKey=test-private-key');}
  ];
  for(const fetchImpl of fetchers){
    await assert.rejects(make({fetchImpl}).getEvents(),error=>{
      assert.ok(/provider/i.test(error.message));
      assert.equal(error.message.includes('test-private-key'),false);
      assert.equal(error.message.includes('sensitive upstream'),false);
      assert.ok(error.status>=400);return true;
    });
  }
});

test('times out an unresponsive provider and aborts the request',async()=>{
  let signal;
  const provider=make({timeoutMs:5,fetchImpl:async(_,init)=>{signal=init.signal;return new Promise(()=>{});}});
  await assert.rejects(provider.getEvents(),/provider.*timed out/i);
  assert.equal(signal.aborted,true);
});

test('rejects malformed events, invalid odds, unsupported quarter lines, and future provider updates',async()=>{
  const mutations=[
    raw=>{raw.id='';},raw=>{raw.home_team=raw.away_team;},raw=>{raw.commence_time='invalid';},
    raw=>{raw.bookmakers[0].markets[0].outcomes[0].price=0;},
    raw=>{raw.bookmakers[0].markets[1].outcomes[0].point=-4.25;},
    raw=>{raw.bookmakers[0].markets[0].last_update='2026-11-21T00:00:00Z';},
    raw=>{raw.bookmakers[0].markets[0].outcomes[0].name='Unknown team';},
    raw=>{raw.bookmakers[0].markets[2].outcomes[1].point=225.5;},
    raw=>{raw.bookmakers[0].markets.push(raw.bookmakers[0].markets[0]);}
  ];
  for(const mutate of mutations){const raw=event();mutate(raw);await assert.rejects(make({fetchImpl:async()=>response([raw])}).getEvents(),/provider.*invalid/i);}
  await assert.rejects(make({fetchImpl:async()=>response({events:[]})}).getEvents(),/provider.*invalid/i);
});

test('rejects inconsistent spread handicaps rather than accepting a broken market',async()=>{
  const raw=event();raw.bookmakers[0].markets[1].outcomes[1].point=5.5;
  await assert.rejects(make({fetchImpl:async()=>response([raw])}).getEvents(),/provider.*invalid/i);
});

test('normalizes final and pending results and requests the recovery window',async()=>{
  let requested;
  const result={id:'provider-event-1',completed:true,home_team:'New York Knicks',away_team:'Boston Celtics',scores:[{name:'Boston Celtics',score:'104'},{name:'New York Knicks',score:'108'}],last_update:timestamp};
  const pending={...result,id:'pending',completed:false,scores:null,last_update:null};
  const records=await make({fetchImpl:async url=>{requested=new URL(url);return response([result,pending]);}}).getResults('basketball_nba');
  assert.equal(requested.searchParams.get('daysFrom'),'3');assert.match(requested.pathname,/\/scores$/);
  assert.equal(records[0].home_score,108);assert.equal(records[0].away_score,104);assert.equal(records[0].completed,true);
  assert.equal(records[0].updated_at,timestamp);assert.equal(records[0].evidence.id,result.id);
  assert.equal(records[1].completed,false);assert.equal(records[1].home_score,null);assert.equal(records[1].updated_at,null);
});

test('rejects incomplete final evidence and non-integer or conflicting score records',async()=>{
  const result=()=>({id:'result',completed:true,home_team:'Home',away_team:'Away',scores:[{name:'Home',score:'2'},{name:'Away',score:'1'}],last_update:timestamp});
  for(const mutate of [r=>{r.scores=null;},r=>{r.scores[0].score='-1';},r=>{r.scores[0].score='1.5';},r=>{r.scores[1].name='Home';},r=>{r.last_update='2026-11-21T00:00:00Z';}]){
    const raw=result();mutate(raw);await assert.rejects(make({fetchImpl:async()=>response([raw])}).getResults('basketball_nba'),/provider.*invalid/i);
  }
});

test('sample provider is explicitly identified, stable across reads, and settles only after its clock reaches the result time',async()=>{
  assert.equal(typeof createSampleProvider,'function');let clock=new Date(NOW);
  const provider=createSampleProvider({now:()=>clock});
  const before=(await provider.getEvents())[0];
  assert.equal(before.id,'sample-nba-1');assert.ok(before.selections.every(s=>s.bookmaker==='sample'));
  clock=new Date(NOW.getTime()+60_000);const later=(await provider.getEvents())[0];
  assert.equal(before.starts_at,later.starts_at);assert.equal((await provider.getResults('basketball_nba'))[0].completed,false);
  clock=new Date(NOW.getTime()+5*3_600_000);
  assert.equal((await provider.getEvents())[0].status,'final');
  const final=(await provider.getResults('basketball_nba'))[0];assert.equal(final.completed,true);assert.equal(final.home_score,108);
  assert.equal((await provider.getEvents('americanfootball_nfl'))[0].league,'NFL');assert.equal((await provider.getEvents('icehockey_nhl'))[0].league,'NHL');
  await assert.rejects(provider.getEvents('unsupported'),/supported sport/i);
});
