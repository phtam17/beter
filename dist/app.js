import { americanToDecimal, formatOdds, potentialPayout, createInitialState, placeBets, settleBet, resetState, getStats } from './engine.js';
import { events as demoEvents, sports, marketNames, getSelection } from './markets.js';
import { createApiClient, adaptPortfolio } from './api-client.js';
import { saveDraft, loadDraft, clearDraft } from './drafts.js';

const paths = {
  grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  ticket:'M4 4h16v5a3 3 0 0 0 0 6v5H4v-5a3 3 0 0 0 0-6zM14 5v3m0 3v2m0 3v3',
  shield:'m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7zM8.5 12l2.5 2.5 4.5-5',
  search:'m16.5 16.5 4 4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0',
  info:'M12 11v6m0-10v1M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0',
  sliders:'M4 7h4m6 0h6M4 17h10m6 0h0M8 4v6m6 4v6M11 7h3M17 17h3',
  chart:'M4 3v17h17M8 14l4-4 4 2 5-7',
  book:'M12 5C9 3 5 3 2 4v15c4-1 7-1 10 1m0-15c3-2 7-2 10-1v15c-4-1-7-1-10 1zm-6 3h2m-2 4h2m8-4h2m-2 4h2',
  basketball:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3v18M5.6 5.6c8 1.5 11.3 4.8 12.8 12.8M5.6 18.4c8-1.5 11.3-4.8 12.8-12.8',
  football:'M3 21C-1 9 9-1 21 3c4 12-6 22-18 18m4-4L17 7m-8 5 3 3m0-6 3 3',
  hockey:'M7 3 4 18q0 3 4 3h4v-4H7m4-4 5-10m0 16c0-1 6-1 6 0v2c0 1-6 1-6 0z',
  download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  check:'m5 12 4 4L19 6',
  lock:'M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4',
  clock:'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  reset:'M4 10a8 8 0 1 1 1 7M4 4v6h6'
};
const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.grid}"/></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(value);
const compactMoney = value => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(value);
const signedMoney = value => `${value>0?'+':value<0?'−':''}${money(Math.abs(value))}`;
const pct = value => `${value.toFixed(1)}%`;
const STORAGE_KEY = 'beter-practice-v1';
const PRACTICE_STORAGE_KEY = 'beter-practice-personal-v1';
const api = createApiClient();
let appConfig = { mode: 'unconfigured', dataMode: 'sample' };
let sessionRestoring = true;
let accountMode = Boolean(api.session());
let accountLoading = accountMode;
let accountError = '';
let refreshError = '';
let accountRequest = null;
let accountGeneration = 0;
let events = demoEvents;
let acceptedQuote = null;
let placementRequestId = null;
let confirmationAttempted = false;
let betBusy = false;
let slipRevision = 0;
let quoteController = null;
let placementInFlight = false;
let betError = '';
let stakeError = '';
let authMode = 'signin';
let authMessage = '';
let authError = '';
let authEmail = '';
let authBusy = false;
let authAttempt = 0;
let recoveryToken = null;
let storageWarning = false;
let saveWarning = false;
let previewMode = false;
let hasPersonalPractice = false;
let personalState = null;
let state = loadState();
let selections = [];
let mode = 'single';
let stake = '100';
let range = 'All';
let betFilter = 'All bets';
let pendingReset = null;
let toastTimer;
let draftMessage = '';
let restoredScope = null;
let placementReceipt = '';
let boardReturnId = null;
let historyScope = '';
let historyPage = null;
let historyBusy = false;
let historyError = '';
let historyRetry = null;
let historyController = null;
let historyRevision = 0;
let exportController = null;
let exportBusy = false;
let exportError = '';
let exportCount = 0;
const HISTORY_PAGE_SIZE = 100;
const EXPORT_BET_LIMIT = 50000;
const sessionDrafts = new Map();
const memoryDraftStorage = {
  getItem:key=>sessionDrafts.get(key)??null,
  setItem:(key,value)=>sessionDrafts.set(key,value),
  removeItem:key=>sessionDrafts.delete(key)
};
const content = document.querySelector('#page-content');
const dialog = document.querySelector('#settings-dialog');
const authDialog = document.querySelector('#auth-dialog');
const helpDialog = document.querySelector('#help-dialog');
const sportIcon = sport=>({Basketball:'basketball',Football:'football',Hockey:'hockey'}[sport]||'grid');

function readSavedState(key) {
    const saved = localStorage.getItem(key);
    if (!saved) return null;
    const candidate = JSON.parse(saved);
    const statuses = ['open','won','lost','void'];
    const validMoney = n=>typeof n==='number' && Number.isFinite(n) && n>=0 && n<=1e12;
    if (candidate.version!==1 || !validMoney(candidate.balance) || !validMoney(candidate.initialBankroll) || !Array.isArray(candidate.bets) || !Array.isArray(candidate.ledger) || candidate.ledger.length===0) throw new Error();
    if (!candidate.bets.every(b=>typeof b.id==='string' && Array.isArray(b.selections) && b.selections.length && b.selections.every(s=>typeof s.team==='string' && Number.isFinite(americanToDecimal(s.odds))) && statuses.includes(b.status) && validMoney(b.stake) && validMoney(b.payout) && validMoney(b.potentialPayout))) throw new Error();
    if (!candidate.ledger.every(l=>validMoney(l.bankroll) && !Number.isNaN(Date.parse(l.at)))) throw new Error();
    return candidate;
}
function loadState() {
  if(personalState){previewMode=false;hasPersonalPractice=true;return personalState;}
  try {
    const personal=readSavedState(PRACTICE_STORAGE_KEY);
    if(personal){previewMode=false;hasPersonalPractice=true;personalState=personal;return personal;}
    const earlier=readSavedState(STORAGE_KEY);
    previewMode=!earlier||earlier.bets.some(b=>b.id.startsWith('demo-'));
    hasPersonalPractice=Boolean(earlier&&!previewMode);
    if(hasPersonalPractice)personalState=earlier;
    return earlier||createInitialState();
  } catch {storageWarning=true;previewMode=true;return createInitialState();}
}
function saveState() {
  if(accountMode||previewMode)return;
  personalState=state;hasPersonalPractice=true;
  try { localStorage.setItem(PRACTICE_STORAGE_KEY,JSON.stringify(state));saveWarning=false; }
  catch { saveWarning=true; }
}
function draftScope() {
  return accountMode?(state.portfolioId&&api.session()?.user.id?`account:${api.session().user.id}:${state.portfolioId}`:null):previewMode?null:'practice';
}
function draftStorage() {try{return localStorage;}catch{return null;}}
function persistSlip() {
  const scope=draftScope();
  if(!scope)return;
  saveDraft(memoryDraftStorage,scope,{selections,mode,stake});
  const saved=saveDraft(draftStorage(),scope,{selections,mode,stake});
  draftMessage=selections.length?(saved?'Draft saved on this device.':'This draft could not be saved. Keep this page open.') : '';
}
function clearSlipDraft() {
  const scope=draftScope();if(scope){clearDraft(memoryDraftStorage,scope);clearDraft(draftStorage(),scope);}
  draftMessage='';
}
function restoreSlip() {
  const scope=draftScope();
  if(!scope||restoredScope===scope)return;
  restoredScope=scope;
  const options={allowParlay:!accountMode,resolveSelection:id=>{
    if(accountMode){const event=events.find(e=>e.selections?.some(s=>s.id===id));const pick=accountSelection(id);return event?.status==='upcoming'&&pick&&Date.parse(pick.startsAt)>Date.now()+60000?pick:null;}
    for(const event of demoEvents)for(let market=0;market<3;market++)for(let team=0;team<2;team++){
      const pick=getSelection(event.id,market,team);if(pick.id===id)return pick;
    }
    return null;
  }};
  const draft=loadDraft(memoryDraftStorage,scope,options)||loadDraft(draftStorage(),scope,options);
  if(!draft)return;
  selections=draft.selections;mode=draft.mode;stake=draft.stake;
  draftMessage=draft.removedCount?'Draft restored. Unavailable selections were removed.':accountMode?'Draft restored. Review a fresh quote before confirming.':'Draft restored. Review your selections and stake.';
}
function startPersonalPractice({navigate=true}={}) {
  try {
    const saved=personalState||readSavedState(PRACTICE_STORAGE_KEY);
    const earlier=saved?null:readSavedState(STORAGE_KEY);
    state=saved||(earlier&&!earlier.bets.some(b=>b.id.startsWith('demo-'))?earlier:resetState());
  }catch{state=resetState();}
  previewMode=false;selections=[];mode='single';stake='100';restoredScope=null;placementReceipt='';
  invalidateQuote();saveState();restoreSlip();betFilter='All bets';
  if(navigate&&location.hash!=='#sportsbook')location.hash='sportsbook';else render();
}
function viewSamplePortfolio() {
  persistSlip();
  try {const earlier=readSavedState(STORAGE_KEY);state=earlier?.bets.some(b=>b.id.startsWith('demo-'))?earlier:createInitialState();}catch{state=createInitialState();}
  previewMode=true;selections=[];draftMessage='';placementReceipt='';restoredScope=null;invalidateQuote();render();
}
function practiceIntroHTML() {
  if(accountMode)return '';
  if(previewMode)return `<section class="sample-preview-notice" aria-label="Sample preview"><div><h2>Sample preview</h2><p>These illustrative results are separate from your practice. Start with your own $10,000 in virtual funds.</p>${state.bets.some(b=>!b.id.startsWith('demo-'))?'<p>Your earlier demo bets remain in this preview.</p>':''}</div><button type="button" class="button primary" data-action="start-practice">${hasPersonalPractice?'Return to my practice':'Start my $10,000 practice'}</button></section>`;
  if(routeInfo().route==='sportsbook')return '<section class="practice-welcome practice-welcome-compact" aria-label="Personal practice"><p>Your own results, from a $10,000 start.</p><button type="button" class="button secondary" data-action="sample-preview">View sample portfolio</button></section>';
  return `<section class="practice-welcome" aria-label="Personal practice"><div><h2>${state.bets.length?'Your practice, your results.':'Make your first practice decision.'}</h2><p>${state.bets.length?'Only your own bets contribute to this portfolio.':'Choose odds, review what needs to happen, then place a virtual bet. Your history starts with you.'}</p></div><div class="button-row">${state.bets.length?'':'<a class="button primary" href="#sportsbook">Explore markets</a>'}<button type="button" class="button secondary" data-action="sample-preview">View sample portfolio</button></div></section>`;
}
function marketHelpHTML() {
  return `<details class="market-help"><summary>How these markets work</summary><div><p><strong>Moneyline:</strong> choose the team that wins the game.</p>${accountMode?'<p>Your account supports moneyline singles. Spread, total, and parlays are available in the separate demo.</p>':'<p><strong>Spread:</strong> apply the listed handicap to a team’s score. Negative numbers need a larger winning margin; positive numbers give the team a head start.</p><p><strong>Total:</strong> choose over (O) or under (U) the combined score.</p>'}<p><strong>Odds:</strong> +150 means $150 profit on a winning $100 stake. −200 means a $200 stake earns $100 profit. Payout includes the returned stake.</p><a href="#learn">Explore odds with the calculator</a></div></details>`;
}
function selectionExplanation(selection) {
  if(selection.market==='Moneyline')return `${selection.team} must win the game.`;
  if(selection.market==='Spread'){
    const line=Number(selection.line);
    return line<0?`${selection.team} must win by more than ${Math.abs(line)} points.`:`${selection.team} can win, or lose by fewer than ${line} points.`;
  }
  const [direction,line]=String(selection.line).split(' ');
  return `The teams’ combined final score must be ${direction==='O'?'over':'under'} ${line}.`;
}
function slipStatusHTML() {
  return `<p class="draft-notice" role="status" ${draftMessage?'':'hidden'}>${esc(draftMessage)}</p>${selections.length?'<button type="button" class="text-button slip-back" data-action="back-to-games">Back to games</button>':''}`;
}
function placementReceiptHTML() {
  return placementReceipt?`<section class="placement-receipt" tabindex="-1" aria-label="Practice bet confirmation"><div><h2>Practice bet placed</h2><p>${esc(placementReceipt)}</p></div><a class="button secondary" href="#bets">View bet</a><button type="button" class="text-button" data-action="dismiss-receipt">Dismiss confirmation</button></section>`:'';
}
function focusElement(element) {
  if(!element)return;
  if(element.matches('h1,h2,h3,section,p'))element.setAttribute('tabindex','-1');
  element.focus();
}
function focusSlip() {
  focusElement(document.querySelector('.remove-selection')||document.querySelector('#stake')||document.querySelector('#slip-title'));
}
function showToast(message) {
  const toast=document.querySelector('#toast');
  clearTimeout(toastTimer); toast.textContent=message; toast.hidden=false;
  toastTimer=setTimeout(()=>{toast.hidden=true;},5500);
}
function routeInfo() {
  const [route,query] = location.hash.slice(1).split('?');
  return {route:['overview','sportsbook','bets','learn'].includes(route)?route:'overview', params:new URLSearchParams(query||'')};
}
function updateFilter(key,value) {
  const {route,params}=routeInfo();
  if(value) params.set(key,value); else params.delete(key);
  history.replaceState(null,'',`#${route}${params.size?'?'+params:''}`);
}
function heading(title,subtitle) {
  const isSample=!accountMode&&state.bets.some(b=>b.id.startsWith('demo-'));
  return `<div class="page-heading"><div><h1>${title}</h1><p>${subtitle}</p></div><div class="page-actions"><span class="sample-badge">${icon(isSample?'book':'shield')}${accountMode?'Saved portfolio':isSample?'Sample portfolio':'Your practice'}</span><button type="button" class="icon-button" data-action="settings" aria-label="Practice settings">${icon('sliders')}</button></div></div>`;
}
function statsHTML() {
  const stats=getStats(state);
  const wins=stats.wins??state.bets.filter(b=>b.status==='won').length;
  const losses=stats.losses??state.bets.filter(b=>b.status==='lost').length;
  return `<dl class="stats-row"><div class="stat"><dt>Total bankroll</dt><dd class="num">${money(stats.bankroll)}<small>${compactMoney(state.balance)} available${stats.openBets?` / ${compactMoney(stats.amountAtRisk)} in play`:' in virtual funds'}</small></dd></div><div class="stat"><dt>Total profit / loss</dt><dd class="num ${stats.totalProfit>=0?'positive':'negative'}">${signedMoney(stats.totalProfit)}<small class="${stats.totalProfit>=0?'positive':'negative'}">${stats.totalProfit>=0?'+':''}${pct(stats.totalProfit/state.initialBankroll*100)} on starting bankroll</small></dd></div><div class="stat"><dt>Win rate</dt><dd class="num">${pct(stats.winRate)}<small>${wins} won / ${losses} lost</small></dd></div><div class="stat"><dt>Bets placed</dt><dd class="num">${String(stats.totalBets).padStart(2,'0')}<small>${stats.openBets} open / ${stats.settledBets} settled</small></dd></div></dl>`;
}
function chartHTML(chartWidth=800) {
  let points=state.ledger.filter(l=>l.type!=='stake');
  if (range!=='All') {
    const end=Math.max(Date.now(),...points.map(l=>Date.parse(l.at)));
    const cutoff=end-(range==='1W'?7:30)*86400000;
    const before=points.filter(l=>Date.parse(l.at)<cutoff).at(-1);
    points=points.filter(l=>Date.parse(l.at)>=cutoff);
    if(before) points.unshift({...before,at:new Date(cutoff).toISOString()});
  }
  if (!points.length) points=[{at:new Date().toISOString(),bankroll:getStats(state).bankroll}];
  const values=points.map(l=>l.bankroll);
  const spread=Math.max(...values)-Math.min(...values);
  const step=spread>5000?2500:spread>2000?1000:500;
  const low=Math.floor((Math.min(...values)-step*.5)/step)*step;
  const high=Math.max(low+step*3,Math.ceil((Math.max(...values)+step*.5)/step)*step);
  const width=chartWidth,left=0,right=width-56,top=25,bottom=145;
  const x=i=>points.length===1?right:left+i/(points.length-1)*(right-left);
  const y=v=>bottom-(v-low)/(high-low)*(bottom-top);
  const coords=values.map((v,i)=>[x(i),y(v)]);
  if(coords.length===1) coords.unshift([left,coords[0][1]]);
  const path=coords.map(([px,py],i)=>`${i?'L':'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const ticks=Array.from({length:Math.round((high-low)/step)+1},(_,i)=>low+step*i);
  const last=coords.at(-1);
  const labelIndices=[...new Set((width<500?[0,.5,1]:[0,.25,.5,.75,1]).map(f=>Math.floor((points.length-1)*f)))];
  const dates=labelIndices.map(i=>`<text class="chart-label" x="${x(i)}" y="175" text-anchor="${i===0?'start':i===points.length-1?'end':'middle'}">${new Date(points[i].at).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</text>`).join('');
  const label=money(values.at(-1));
  const tipX=Math.max(0,Math.min(right-100,last[0]-50));
  return `<section class="chart-section" aria-labelledby="performance-title"><div class="section-header"><div><h2 id="performance-title">Bankroll performance</h2><p>See how your decisions add up.</p></div><div class="segmented" role="group" aria-label="Chart time range">${['1W','1M','All'].map(r=>`<button type="button" data-range="${r}" aria-pressed="${range===r}">${r}</button>`).join('')}</div></div><div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 ${width} 180" preserveAspectRatio="none" role="img" aria-label="Virtual bankroll from ${money(values[0])} to ${money(values.at(-1))} over ${points.length} ${state.ledgerSampled?'sampled history points':'recorded points'}"><title>Bankroll performance</title>${ticks.map(v=>`<line class="chart-grid" x1="${left}" y1="${y(v)}" x2="${right}" y2="${y(v)}"/><text class="chart-label" x="${right+12}" y="${y(v)+4}">$${(v/1000).toFixed(1)}k</text>`).join('')}<path class="chart-area" d="${path} L${right},${bottom} L${left},${bottom}Z"/><path class="chart-line" d="${path}"/><circle class="chart-point" cx="${last[0]}" cy="${last[1]}" r="5"/><rect class="chart-tip-bg" x="${tipX}" y="${Math.max(0,last[1]-35)}" width="100" height="24"/><text class="chart-tip" x="${tipX+50}" y="${Math.max(0,last[1]-35)+16}" text-anchor="middle">${label}</text>${dates}</svg></div><div class="chart-footer"><span class="chart-legend"><span class="legend-line"></span>Virtual bankroll</span><span>Starting bankroll ${compactMoney(state.initialBankroll)}${state.ledgerSampled?' / Sampled history points; totals include all bets.':''}</span></div></section>`;
}
function redrawChart() {const chart=document.querySelector('.chart-section');if(chart)chart.outerHTML=chartHTML(Math.round(chart.clientWidth));}
function demoMarketsHTML(full=false) {
  const {params}=routeInfo();
  const active=sports.includes(params.get('sport'))?params.get('sport'):'All sports';
  const q=params.get('q')||'';
  return `<section id="markets" aria-labelledby="markets-title"><div class="section-header market-heading"><div><h2 id="markets-title">${full?'Markets':'Explore the board'}</h2>${full?'':'<p>Sample games. Real practice.</p>'}</div>${!full?'<a class="text-button" href="#sportsbook">View all markets</a>':`<span class="sample-badge">${events.length} sample games</span>`}</div><div class="market-toolbar"><div class="sport-tabs" role="group" aria-label="Filter by sport">${sports.map(s=>`<button type="button" class="sport-tab" data-sport="${s}" aria-pressed="${active===s}">${icon(sportIcon(s))}${s==='Football'?'Football':s}</button>`).join('')}</div><label class="search-field">${icon('search')}<span class="visually-hidden">Search teams</span><input type="search" id="market-search" name="teams" autocomplete="off" placeholder="Search teams" value="${esc(q)}"></label></div>${marketHelpHTML()}<div id="market-results">${marketResultsHTML(full)}</div><p class="board-note">${icon('info')}All games, times, and odds are illustrative. Results are simulated manually.</p></section>`;
}
function demoMarketResultsHTML(full=false) {
  const {params}=routeInfo();
  const sport=params.get('sport')||'All sports';
  const query=(params.get('q')||'').toLowerCase().trim();
  let visible=events.filter(e=>(sport==='All sports'||!sports.includes(sport)||e.sport===sport)&&`${e.away.name} ${e.home.name} ${e.league}`.toLowerCase().includes(query));
  if(!full&&sport==='All sports'&&!query) visible=visible.slice(0,3);
  if(!visible.length) return `<div class="empty-state">${icon('search')}<h3>No games found</h3><p>Try another team or choose a different sport.</p><button type="button" class="button secondary" data-action="clear-filters">Clear filters</button></div>`;
  return `<div class="board-labels"><span>Game / sample start time</span><span>Spread</span><span>Moneyline</span><span>Total</span></div>${visible.map(event=>`<article class="event" aria-label="${event.away.name} at ${event.home.name}"><div class="event-meta">${icon(sportIcon(event.sport))}<strong>${event.league}</strong><span>Practice fixture</span><time>${event.time}</time></div>${[event.away,event.home].map((team,teamIndex)=>`<div class="team-row"><div class="team-info"><span class="team-badge" aria-hidden="true">${team.short}</span><span class="team-name">${team.name}<small>${team.record}</small></span></div>${marketNames.map((market,marketIndex)=>{
    const pick=getSelection(event.id,marketIndex,teamIndex);
    const selected=selections.some(s=>s.id===pick.id);
    return `<button type="button" class="odds-button" data-pick="${pick.id}" data-event="${event.id}" data-market="${marketIndex}" data-team="${teamIndex}" aria-pressed="${selected}" aria-label="${esc(pick.team)} ${market} ${esc(pick.line)}, odds ${formatOdds(pick.odds)}">${marketIndex!==1?`<span>${pick.line}</span>`:''}<span class="odds">${formatOdds(pick.odds)}</span></button>`;
  }).join('')}</div>`).join('')}</article>`).join('')}`;
}
function demoSlipHTML() {
  let payout=0,totalStake=0;
  if(selections.length) {
    try { payout=potentialPayout(Number(stake),selections,mode);totalStake=Math.round(Number(stake)*100)*(mode==='single'?selections.length:1)/100; } catch {}
  }
  return `<aside class="right-rail" aria-label="Practice bet slip"><section class="bet-slip" id="bet-slip" aria-labelledby="slip-title"><div class="slip-title"><h2 id="slip-title">${icon('ticket')}Bet slip <span class="count-badge">${selections.length}</span></h2>${selections.length?'<button type="button" class="text-button" data-action="clear-slip">Clear</button>':''}</div>${slipStatusHTML()}${!selections.length?`<div class="slip-empty"><span class="slip-empty-symbol">${icon('ticket')}</span><h3>A good bet starts with a pick.</h3><p>Choose any odds on the board<br>to build your practice bet.</p><a class="button secondary" href="#sportsbook">Explore markets</a></div>`:`<form id="bet-form" class="slip-content" novalidate><div class="segmented" role="group" aria-label="Bet type">${['single','parlay'].map(m=>`<button type="button" data-mode="${m}" aria-pressed="${mode===m}">${m==='single'?'Singles':'Parlay'}</button>`).join('')}</div>${selections.map(s=>`<div class="slip-selection"><h3>${esc(s.team)}</h3><p>${esc(s.eventName)}</p><div class="selection-market"><span>${s.market}${s.market==='Spread'?' '+esc(s.line):''}</span><strong>${formatOdds(s.odds)}</strong></div><p class="selection-explanation">${esc(selectionExplanation(s))}</p><button type="button" class="remove-selection" data-remove="${s.id}" aria-label="Remove ${esc(s.team)}">×</button></div>`).join('')}<label class="stake-label" for="stake">${mode==='single'?'Stake per selection':'Parlay stake'}<span>${money(state.balance)} available</span></label><div class="stake-input"><span>$</span><input id="stake" name="stake" type="number" inputmode="decimal" step="0.01" min="0.01" autocomplete="off" value="${esc(stake)}" aria-describedby="slip-error" aria-invalid="${Boolean(stakeError)}" required></div><div class="quick-stakes">${[25,50,100].map(v=>`<button type="button" data-stake="${v}">$${v}</button>`).join('')}</div><div id="slip-calculation">${slipCalculationHTML(totalStake,payout)}</div><button type="submit" class="button primary place-button">Place practice ${mode==='parlay'?'parlay':selections.length>1?'bets':'bet'}</button><p id="slip-error" class="form-error" role="alert">${esc(stakeError)}</p><p class="slip-hint">${mode==='parlay'?'Every selection must win. Choose one pick per game.':'Each selection is placed as its own bet.'} Payout includes your stake.</p></form>`}<div class="slip-footer">${icon('lock')}100% virtual. Always.</div></section><section class="practice-note">${icon('book')}<h3>Find your edge.<br>Without the risk.</h3><p>A little understanding goes a long way. Get to know the odds before your next pick.</p><a href="#learn">Learn the fundamentals</a></section><p class="small-note">${icon('shield')}Practice builds understanding, and simulated wins don’t predict real results.</p></aside>`;
}
function slipCalculationHTML(total,payout) {
  return `<dl class="slip-summary"><div><dt>Total stake</dt><dd class="num">${money(total)}</dd></div><div><dt>Potential profit</dt><dd class="num">${money(Math.max(0,payout-total))}</dd></div><div class="payout-row"><dt>Potential payout</dt><dd class="num">${money(payout)}</dd></div></dl>`;
}
function updateSlipCalculation({validate=false}={}) {
  if(accountMode){updateAccountCalculation({validate});return;}
  const node=document.querySelector('#slip-calculation');if(!node)return;
  let total=0,payout=0,error='';
  try {payout=potentialPayout(Number(stake),selections,mode);total=Math.round(Number(stake)*100)*(mode==='single'?selections.length:1)/100;if(total>state.balance)error='Your stake exceeds your available virtual balance.';}catch(e){error=e.message;}
  node.innerHTML=slipCalculationHTML(total,payout);
  stakeError=validate?error:'';
  document.querySelector('#slip-error').textContent=stakeError;
  document.querySelector('#stake').setAttribute('aria-invalid',String(Boolean(stakeError)));
}
function recentHTML() {
  const recent=[...state.bets].reverse().slice(0,4);
  return `<section class="recent-section"><div class="section-header"><h2>Recent bets</h2><a class="text-button" href="#bets">View bet history</a></div>${!recent.length?emptyBetsHTML():`<table class="bets-table"><thead><tr><th>Selection</th><th>Stake</th><th>Result</th><th>Profit / loss</th></tr></thead><tbody>${recent.map(b=>`<tr><td><span class="bet-name">${esc(b.selections.length>1?`${b.selections.length}-leg parlay`:b.selections[0].team)}</span><span class="bet-description">${esc(b.selections.length>1?'Parlay':b.selections[0].market)} / ${dateLabel(b.createdAt)}</span></td><td class="num">${money(b.stake)}</td><td><span class="status status-${b.status}">${statusLabel(b.status)}</span></td><td class="num ${b.status==='won'?'positive':b.status==='lost'?'negative':''}">${b.status==='open'?'In play':signedMoney(b.payout-b.stake)}</td></tr>`).join('')}</tbody></table>`}</section>`;
}
function emptyBetsHTML() {return `<div class="empty-state">${icon('ticket')}<h3>Your first bet is a fresh start.</h3><p>Place a practice bet to start tracking your decisions.</p><a class="button secondary" href="#sportsbook">Explore markets</a></div>`;}
function emptyFilteredBetsHTML() {return `<div class="empty-state filtered-empty">${icon('ticket')}<h3>No ${esc(betFilter==='All bets'?'matching':betFilter.toLowerCase())} bets</h3><p>Your other bets are still in your history. Choose another result or show all bets.</p><button type="button" class="button secondary" data-action="show-all-bets">Show all bets</button></div>`;}
function dateLabel(date) {return new Date(date).toLocaleDateString('en-US',{month:'short',day:'numeric'});}
function statusLabel(s) {return ({open:'Open',won:'Won',lost:'Lost',void:'Voided'})[s];}
function betsHTML() {
  betFilter=routeInfo().params.get('status')||betFilter;
  if(!['All bets','Open','Won','Lost','Voided'].includes(betFilter))betFilter='All bets';
  if(accountMode&&betFilter!=='All bets'&&historyPage?.filter!==betFilter&&!historyBusy&&!historyError){
    const filter=betFilter,generation=accountGeneration;historyBusy=true;
    queueMicrotask(()=>{if(accountMode&&generation===accountGeneration&&betFilter===filter)void loadHistoryPage({filter});});
  }
  const current=accountMode?currentHistoryPage():null;
  const filtered=(accountMode?current.bets:[...state.bets].reverse()).filter(b=>betFilter==='All bets'||statusLabel(b.status)===betFilter);
  const historyControls=accountMode&&(filtered.length||current.nextCursor||current.trail.length||historyBusy||historyError)?`<nav class="history-pages" aria-label="Bet history pages"><button type="button" class="button secondary" data-action="newer-history" ${!current.trail.length||historyBusy?'disabled':''}>Newer bets</button><p id="history-page-status" tabindex="-1">${historyBusy?'Loading history…':`Page ${current.trail.length+1} / ${filtered.length} bet${filtered.length===1?'':'s'}`}</p><button type="button" class="button secondary" data-action="older-history" ${!current.nextCursor||historyBusy?'disabled':''}>Older bets</button></nav>`:'';
  const historyFeedback=historyError?`<div class="connection-notice"><p role="alert">${esc(historyError)}</p><button type="button" class="button secondary" data-action="retry-history" id="retry-history">Retry history</button></div>`:'';
  const exportFeedback=`${exportError?`<p class="form-error" role="alert">${esc(exportError)}</p>`:''}${exportBusy?`<div class="export-progress"><progress value="${exportCount}" max="${Math.max(1,getStats(state).totalBets,exportCount)}" aria-label="Preparing CSV"></progress><p>Preparing ${exportCount} of ${getStats(state).totalBets} bets…</p><button type="button" class="text-button" data-action="cancel-export">Cancel export</button></div>`:''}`;
  return `<section><div class="bets-toolbar"><div class="segmented" role="group" aria-label="Filter bet history">${['All bets','Open','Won','Lost','Voided'].map(f=>`<button type="button" data-bet-filter="${f}" aria-pressed="${betFilter===f}">${f}</button>`).join('')}</div><button type="button" class="text-button" data-action="export" ${exportBusy?'disabled aria-busy="true"':''}>${icon('download')}Export CSV</button></div>${exportFeedback}${historyFeedback}${historyControls}<div class="inline-notice">${icon('info')}<p>You're in control of the simulation. Set an open bet’s result to see how wins, losses, and voids change your bankroll.</p></div>${!filtered.length?(historyBusy?'<p class="auth-help">Loading bet history…</p>':historyError?'<p class="auth-help">Choose Retry history to load these results.</p>':state.bets.length?emptyFilteredBetsHTML():emptyBetsHTML()):filtered.map(b=>`<article class="bet-card"><div class="bet-card-head"><span class="status status-${b.status}">${statusLabel(b.status)}</span><span class="bet-description">${b.selections.length>1?b.selections.length+'-leg parlay':'Single bet'}${b.id.startsWith('demo-')?' / Sample':''}</span><time datetime="${esc(b.createdAt)}">${dateLabel(b.createdAt)}</time></div><div class="bet-details"><div>${b.selections.map(s=>`<p class="bet-card-title">${esc(s.team)} <span class="bet-description">${esc(s.market)} ${s.market==='Spread'?esc(s.line):''} / ${formatOdds(s.odds)} / ${esc(s.eventName)}</span></p>`).join('')}</div><dl class="bet-financials"><div><dt>Stake</dt><dd class="num">${money(b.stake)}</dd></div><div><dt>${b.status==='open'?'Potential payout':'Payout'}</dt><dd class="num">${money(b.status==='open'?b.potentialPayout:b.payout)}</dd></div><div><dt>Profit / loss</dt><dd class="num ${b.status==='won'?'positive':b.status==='lost'?'negative':''}">${b.status==='open'?'In play':signedMoney(b.payout-b.stake)}</dd></div></dl></div>${b.status==='open'?`<div class="settle-controls"><span>Simulate this bet’s result</span><div>${['won','lost','void'].map(s=>`<button type="button" data-settle="${b.id}" data-outcome="${s}">${s==='won'?'Mark won':s==='lost'?'Mark lost':'Void bet'}</button>`).join('')}</div></div>`:''}</article>`).join('')}</section>`;
}
function learnHTML() {
  const lessons=[
    ['Read American odds','<p><strong>Positive odds show profit on a $100 stake.</strong> At +150, a $100 winning bet returns $250: your $100 stake plus $150 profit.</p><p><strong>Negative odds show the stake needed for $100 profit.</strong> At −200, a $200 winning bet returns $300. A $100 stake would return $150.</p>'],
    ['Know the three main markets','<p><strong>Moneyline:</strong> pick the team you think will win the game.</p><p><strong>Spread:</strong> a handicap applied to the final score. A team at −4.5 needs to win by at least five points. A team at +4.5 can win outright or lose by four or fewer.</p><p><strong>Total:</strong> pick whether the combined score will be over or under the listed number. A push on a whole-number line returns your stake.</p>'],
    ['Understand singles and parlays',accountMode?'<p>Pregame moneyline singles are available in your account. Parlays are available in the separate demo.</p><p><strong>A single</strong> stands alone. A winning moneyline bet returns its quoted payout; a tie is refunded according to the published simulation rules.</p><p><strong>A parlay</strong> combines selections into one ticket. All selections must win. You can explore this mechanism in demo mode.</p>':'<p><strong>A single</strong> stands alone. With three singles at $25 each, your total stake is $75 and each bet settles independently.</p><p><strong>A parlay</strong> combines selections into one bet. Decimal odds multiply, and all selections need to win. One lost selection loses the whole stake. Demo mode supports parlays across separate games and lets you set sample outcomes manually.</p>'],
    ['Measure your decisions','<p><strong>Win rate</strong> is the number of won bets divided by won and lost bets. Voided and open bets are excluded.</p><p><strong>Return on stakes</strong> is net profit divided by the amount staked on decided bets. Winning more than half your bets can still produce a loss, depending on the odds.</p><p><strong>Total bankroll</strong> includes your available virtual balance plus stakes committed to open bets. Payout includes the original stake; profit excludes it.</p>'],
    ['Use the practice room',accountMode?'<p>Account bets are settled automatically. Demo mode supports manual sample outcomes.</p><p>Select a moneyline, enter a virtual stake, and request a quote. Review its price and expiry, then confirm. Go to <strong>My bets</strong> to track the result.</p><p>Starting fresh creates another <strong>$10,000 virtual portfolio</strong> while retaining earlier account records. Your account portfolio is held on the server.</p><p>The sample feed is illustrative. Simulated outcomes do not establish an advantage in real betting.</p>':'<p>Start fresh in practice settings to begin with <strong>$10,000 in virtual funds</strong>. Select odds, review your stake and potential payout, then place your bet.</p><p>Go to <strong>My bets</strong> to mark it won, lost, or void. Demo results are set manually, and prices stay fixed. Your demo portfolio saves automatically in this browser.</p><p>The sample portfolio is illustrative. Simulated outcomes do not establish an advantage in real betting.</p>']
  ];
  return `<div class="learn-layout"><section aria-label="Betting fundamentals">${lessons.map(([title,body],i)=>`<details class="lesson" ${i===0?'open':''}><summary>${title}</summary><div class="lesson-body">${body}</div></details>`).join('')}</section><aside><section class="calculator"><h2>Make sense of the odds.</h2><p>See the numbers behind a potential return.</p><label for="calc-stake">Virtual stake ($)</label><input type="number" id="calc-stake" name="calculator-stake" value="100" step="0.01" min="0.01" inputmode="decimal"><label for="calc-odds">American odds</label><input type="number" id="calc-odds" name="calculator-odds" value="150" step="1" inputmode="text"><div id="calc-output" aria-live="polite"></div><p id="calc-error" class="form-error" role="alert"></p></section><div class="practice-note">${icon('chart')}<h3>Practice. Reflect. Repeat.</h3><p>Use the same virtual stake to compare your decisions over time.</p><a href="#sportsbook">Try a practice bet</a></div></aside></div>`;
}
function updateCalculator() {
  const output=document.querySelector('#calc-output');if(!output)return;
  try {
    const amount=Number(document.querySelector('#calc-stake').value);
    const odds=Number(document.querySelector('#calc-odds').value);
    const decimal=americanToDecimal(odds);
    if(!Number.isFinite(amount)||amount<=0||amount>1e9||Math.abs(amount*100-Math.round(amount*100))>.000001)throw new Error('Enter a positive stake with up to two decimal places.');
    const payout=potentialPayout(amount,[{id:'calculator',eventId:'calculator',team:'Example selection',odds}]);
    output.innerHTML=`<dl class="calc-result"><div><dt>Potential payout</dt><dd class="num">${money(payout)}</dd></div><div><dt>Implied probability</dt><dd class="num">${pct(100/decimal)}</dd></div></dl>`;
    document.querySelector('#calc-error').textContent='';
  }catch(e){output.innerHTML='';document.querySelector('#calc-error').textContent=e.message;}
}
function render() {
  syncHistoryScope();
  updateAccountChrome();
  if(accountMode&&(accountLoading||accountError)) {
    content.innerHTML=accountModeHTML()+heading('Your practice, in play.','Your portfolio stays with your account.')+(accountLoading?'<div class="loading-state" role="status">Loading your saved portfolio…</div>':`<section class="connection-error" role="alert"><h2>We couldn’t load your account.</h2><p>${esc(accountError)}</p><button type="button" class="button secondary" data-action="retry-account">Retry connection</button></section>`);
    return;
  }
  const {route}=routeInfo();
  document.querySelectorAll('[data-route]').forEach(a=>{if(a.dataset.route===route)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
  const count=document.querySelector('#nav-bet-count'),open=getStats(state).openBets;count.textContent=open;count.hidden=!open;
  if(route==='learn') {
    content.innerHTML=heading('Know the odds. Own your decisions.','A little understanding before your next selection.')+learnHTML();
    updateCalculator();
  } else {
    const title=route==='overview'?'Your practice, in play.':route==='sportsbook'?'Sportsbook':'Every bet tells a story.';
    const subtitle=route==='overview'?'Build your strategy. Track your progress. Keep it virtual.':route==='sportsbook'?'Choose a game, understand your pick, and keep it virtual.':'Review your picks and see how your decisions play out.';
    content.innerHTML=heading(title,subtitle)+practiceIntroHTML()+placementReceiptHTML()+`<div class="workspace"><div class="workspace-main">${route!=='sportsbook'?statsHTML():''}${route==='overview'?chartHTML()+'<hr class="section-divider">'+marketsHTML()+recentHTML():route==='sportsbook'?marketsHTML(true):betsHTML()}</div>${slipHTML()}</div>`;
  }
  if(saveWarning&&!accountMode)content.insertAdjacentHTML('afterbegin',`<p class="inline-notice" role="status">${icon('info')}Browser saving is unavailable. Your changes last for this session only. Keep this page open to retain them.</p>`);
  if(previewMode&&!accountMode)document.querySelectorAll('.settle-controls').forEach(el=>el.remove());
  if(accountMode) {
    content.insertAdjacentHTML('afterbegin',accountModeHTML());
    document.querySelectorAll('.settle-controls').forEach(el=>el.remove());
    if(route==='bets') {const note=document.querySelector('.workspace-main .inline-notice p');if(note)note.textContent='Results are settled automatically from event results.';}
  }
  redrawChart();
  if(selections.length&&route!=='learn')content.insertAdjacentHTML('beforeend',`<div class="mobile-slip-bar"><span>${selections.length} selection${selections.length===1?'':'s'} in your slip</span><button type="button" class="button primary" data-action="review-slip">Review bet slip</button></div>`);
  document.title=`${route==='overview'?'Overview':route==='sportsbook'?'Sportsbook':route==='bets'?'My bets':'Learn'} | Beter`;
}

document.addEventListener('click',async event=>{
  if(event.target.closest('.skip-link')) {event.preventDefault();document.querySelector('#main').focus();document.querySelector('#main').scrollIntoView();return;}
  const button=event.target.closest('button');if(!button)return;
  try {
    const changesSlip=button.dataset.pick||button.dataset.remove||button.dataset.mode||button.dataset.stake||['clear-slip','revise-quote'].includes(button.dataset.action);
    if(accountMode&&placementInFlight&&changesSlip){showToast('Your bet is being recorded. Please wait.');return;}
    if(button.dataset.pick) {
      const enteringPractice=!accountMode&&previewMode;
      if(enteringPractice)startPersonalPractice({navigate:false});
      placementReceipt='';boardReturnId=button.dataset.pick;
      const selection=accountMode?accountSelection(button.dataset.pick):getSelection(button.dataset.event,Number(button.dataset.market),Number(button.dataset.team));
      if(!selection)throw new Error('This market is unavailable. Refresh the board.');
      invalidateQuote();
      const exists=selections.some(s=>s.id===selection.id);
      if(exists&&!enteringPractice)selections=selections.filter(s=>s.id!==selection.id);
      else if(!exists) {
        if(accountMode){selections=[];mode='single';}
        // Opposite sides of the same market replace one another.
        selections=selections.filter(s=>!(s.eventId===selection.eventId&&s.market===selection.market));
        if(selections.length>=20){showToast('Your slip can contain up to 20 selections.');return;}
        selections.push(selection);
      }
      render();
      if(!exists&&matchMedia('(max-width: 960px)').matches)showToast('Selection added. Your bet slip is below the board.');
    } else if(button.dataset.remove) {invalidateQuote();selections=selections.filter(s=>s.id!==button.dataset.remove);render();}
    else if(button.dataset.mode) {if(accountMode)return;mode=button.dataset.mode;render();}
    else if(button.dataset.stake) {invalidateQuote();stake=button.dataset.stake;document.querySelector('#stake').value=stake;updateSlipCalculation();}
    else if(button.dataset.sport) {updateFilter('sport',button.dataset.sport==='All sports'?'':button.dataset.sport);render();}
    else if(button.dataset.range) {range=button.dataset.range;render();}
    else if(button.dataset.betFilter) {betFilter=button.dataset.betFilter;updateFilter('status',betFilter==='All bets'?'':betFilter);if(accountMode)await loadHistoryPage({filter:betFilter});else render();}
    else if(button.dataset.settle) {if(accountMode||previewMode)throw new Error('Sample previews cannot change your practice results.');state=settleBet(state,button.dataset.settle,button.dataset.outcome);saveState();render();showToast(`Practice result set: ${statusLabel(button.dataset.outcome).toLowerCase()}. Your bankroll is updated.`);}
    else if(button.dataset.action==='clear-slip') {invalidateQuote();selections=[];stakeError='';render();focusSlip();}
    else if(button.dataset.action==='clear-filters') {updateFilter('sport','');updateFilter('q','');render();}
    else if(button.dataset.action==='settings')openSettings();
    else if(button.dataset.action==='start-practice')startPersonalPractice();
    else if(button.dataset.action==='sample-preview')viewSamplePortfolio();
    else if(button.dataset.action==='dismiss-receipt'){placementReceipt='';render();document.querySelector('#main').focus();}
    else if(button.dataset.action==='show-all-bets'){betFilter='All bets';updateFilter('status','');if(accountMode)await loadHistoryPage({filter:betFilter});else render();document.querySelector('[data-bet-filter="All bets"]')?.focus();}
    else if(button.dataset.action==='back-to-games'){
      const pick=[...document.querySelectorAll('[data-pick]')].find(node=>node.dataset.pick===boardReturnId)||document.querySelector('[data-pick]');
      (pick||document.querySelector('#markets'))?.scrollIntoView({block:'center',behavior:'instant'});pick?.focus({preventScroll:true});
    }
    else if(button.dataset.action==='retry-account')await loadAccount();
    else if(button.dataset.action==='refresh-board')await loadAccount();
    else if(button.dataset.action==='revise-quote'){invalidateQuote();render();document.querySelector('#stake')?.focus();}
    else if(button.dataset.authMode){authAttempt++;api.cancelAuthentication?.();authBusy=false;authEmail=document.querySelector('#auth-email')?.value||authEmail;authMode=button.dataset.authMode;authError='';authMessage='';renderAuth();focusElement(document.querySelector('#auth-email')||document.querySelector('#auth-password'));}
    else if(button.dataset.action==='resend-recovery')await submitAuth(document.querySelector('#auth-form'),{resend:true});
    else if(button.dataset.action==='signout')await signOutAccount();
    else if(button.dataset.action==='export')await exportCSV();
    else if(button.dataset.action==='cancel-export')exportController?.abort();
    else if(button.dataset.action==='older-history'){const current=currentHistoryPage();if(current.nextCursor)await loadHistoryPage({filter:betFilter,before:current.nextCursor,trail:[...current.trail,current.cursor]});}
    else if(button.dataset.action==='newer-history'){const trail=[...currentHistoryPage().trail];if(trail.length){const before=trail.pop();await loadHistoryPage({filter:betFilter,before,trail});}}
    else if(button.dataset.action==='retry-history'&&historyRetry)await loadHistoryPage(historyRetry);
    else if(button.dataset.action==='review-slip') {document.querySelector('#bet-slip').scrollIntoView({block:'start',behavior:'instant'});document.querySelector('#stake')?.focus({preventScroll:true});}
    for(const key of ['pick','mode','sport','range','betFilter'])if(button.dataset[key]) {document.querySelectorAll(`[data-${key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}]`).forEach(el=>{if(el.dataset[key]===button.dataset[key])el.focus({preventScroll:true});});break;}
    if(button.dataset.remove)focusSlip();
    if(button.dataset.pick||button.dataset.remove||button.dataset.mode||button.dataset.stake||button.dataset.action==='clear-slip'){
      persistSlip();
      const status=document.querySelector('.draft-notice');if(status){status.textContent=draftMessage;status.hidden=!draftMessage;}
    }
  }catch(e){showToast(e.message);}
});
document.addEventListener('input',event=>{
  if(event.target.id==='stake'){invalidateQuote();stake=event.target.value;stakeError='';updateSlipCalculation();persistSlip();const status=document.querySelector('.draft-notice');if(status){status.textContent=draftMessage;status.hidden=!draftMessage;}}
  else if(event.target.id==='market-search'){updateFilter('q',event.target.value);document.querySelector('#market-results').innerHTML=marketResultsHTML(routeInfo().route==='sportsbook');}
  else if(['calc-stake','calc-odds'].includes(event.target.id))updateCalculator();
});
document.addEventListener('focusout',event=>{if(event.target.id==='stake')updateSlipCalculation({validate:true});});
document.addEventListener('submit',async event=>{
  if(event.target.id==='auth-form'){event.preventDefault();await submitAuth(event.target);return;}
  if(event.target.id!=='bet-form')return;
  event.preventDefault();
  if(accountMode){await submitAccountBet();return;}
  try {
    const result=placeBets(state,selections,Number(stake),mode);
    state=result.state;selections=[];clearSlipDraft();saveState();placementReceipt=`${result.bets.length===1?'Your selection is':'Your selections are'} saved in My bets. Set a sample result there to see its effect on your bankroll.`;render();document.querySelector('.placement-receipt')?.focus();
    showToast(`${result.bets.length===1?'Practice bet':result.bets.length+' practice bets'} placed. Open My bets to simulate the result.`);
  }catch(e){stakeError=e.message;const error=document.querySelector('#slip-error');error.textContent=stakeError;document.querySelector('#stake').setAttribute('aria-invalid','true');document.querySelector('#stake').focus();}
});
function openSettings() {
  pendingReset=null;document.querySelector('#reset-confirmation').hidden=true;
  dialog.querySelector('.dialog-description').textContent=accountMode?'Your portfolio is saved to your account. Starting fresh creates another portfolio and preserves the earlier history.':'Your practice is saved in this browser. Sample previews stay separate from your personal results.';
  document.querySelector('#demo-button').closest('.setting-option').hidden=accountMode;
  document.querySelector('#reset-button').previousElementSibling.querySelector('p').textContent=accountMode?'Create another $10,000 virtual portfolio.':'Clear your personal practice bets and begin at $10,000.';
  dialog.querySelector('.dialog-note').textContent=accountMode?'Account results are settled on the server. Previous portfolios remain in your account records.':'Practice outcomes are manually simulated. Markets and odds are illustrative.';
  document.querySelector('#confirm-reset').textContent=accountMode?'Create portfolio':'Replace portfolio';
  dialog.showModal();
}
document.querySelector('#settings-symbol').innerHTML=icon('sliders');
document.querySelector('#settings-button').addEventListener('click',openSettings);
document.querySelector('#footer-reset').addEventListener('click',openSettings);
for(const [id,type] of [['reset-button','fresh'],['demo-button','demo']])document.querySelector('#'+id).addEventListener('click',()=>{
  if(type==='demo'&&!accountMode){dialog.close();viewSamplePortfolio();return;}
  pendingReset=type;document.querySelector('#reset-confirmation').hidden=false;
  document.querySelector('#confirmation-copy').textContent=accountMode?'Create a new $10,000 virtual portfolio? Your previous portfolio and its history will be preserved.':type==='fresh'?'Replace your personal practice bets with a fresh $10,000 virtual bankroll? The sample preview stays available.':'Replace your saved portfolio with the eight-bet sample portfolio?';
  document.querySelector('#confirm-reset').focus();
});
document.querySelector('#cancel-reset').addEventListener('click',()=>{pendingReset=null;document.querySelector('#reset-confirmation').hidden=true;});
document.querySelector('#confirm-reset').addEventListener('click',async()=>{
  if(!pendingReset)return;
  if(accountMode) {
    if(pendingReset!=='fresh')return;
    const button=document.querySelector('#confirm-reset'),generation=accountGeneration;persistSlip();button.disabled=true;
    try {
      const portfolio=adaptPortfolio(await api.newPortfolio('My practice'));
      if(generation!==accountGeneration||!accountMode)return;
      accountGeneration++;placementInFlight=false;stakeError='';accountRequest=null;accountLoading=false;accountError='';refreshError='';betBusy=false;
      state=portfolio;selections=[];draftMessage='';placementReceipt='';restoredScope=null;invalidateQuote();restoreSlip();betFilter='All bets';range='All';dialog.close();render();showToast('New portfolio created. Your earlier history is preserved.');pendingReset=null;
    }
    catch(error){if(generation===accountGeneration)dialog.querySelector('.dialog-note').textContent=error.message;}
    finally{button.disabled=false;}
    return;
  }
  previewMode=false;clearDraft(memoryDraftStorage,'practice');clearDraft(draftStorage(),'practice');state=resetState();selections=[];draftMessage='';placementReceipt='';mode='single';betFilter='All bets';range='All';
  saveState();dialog.close();updateFilter('status','');render();showToast(pendingReset==='fresh'?'Fresh start. Your $10,000 virtual bankroll is ready.':'Sample portfolio loaded. These results are illustrative.');pendingReset=null;
});
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
function syncHistoryScope() {
  const scope=`${accountGeneration}:${accountMode?state.portfolioId:'guest'}`;
  if(scope===historyScope)return;
  historyScope=scope;historyRevision++;historyController?.abort();exportController?.abort();
  historyController=null;exportController=null;historyPage=null;historyBusy=false;historyError='';historyRetry=null;exportBusy=false;exportError='';exportCount=0;
}
function currentHistoryPage() {
  if(historyPage?.filter===betFilter)return historyPage;
  return {filter:betFilter,bets:betFilter==='All bets'?[...state.bets].reverse().slice(0,HISTORY_PAGE_SIZE):[],nextCursor:betFilter==='All bets'?state.historyNextCursor:null,cursor:null,trail:[]};
}
function historyStatus(filter) {return ({Open:'open',Won:'won',Lost:'lost',Voided:'void'})[filter]??null;}
async function loadHistoryPage({filter=betFilter,before=null,trail=[]}={}) {
  if(!accountMode||!state.portfolioId)return;
  const generation=accountGeneration,portfolioId=state.portfolioId,revision=++historyRevision;
  historyController?.abort();const controller=new AbortController();historyController=controller;
  historyBusy=true;historyError='';historyRetry={filter,before,trail:[...trail]};render();
  try {
    const result=await api.history(portfolioId,{before,limit:HISTORY_PAGE_SIZE,status:historyStatus(filter),signal:controller.signal});
    if(generation!==accountGeneration||portfolioId!==state.portfolioId||revision!==historyRevision||!accountMode)return;
    if(!Array.isArray(result.bets)||result.bets.length>HISTORY_PAGE_SIZE)throw new Error('The history response was incomplete. Retry the request.');
    historyPage={filter,bets:result.bets,nextCursor:result.nextCursor,cursor:before,trail:[...trail]};
  } catch(error) {
    if(generation!==accountGeneration||portfolioId!==state.portfolioId||revision!==historyRevision||error.code==='REQUEST_ABORTED')return;
    historyError=error.message;
  } finally {
    if(generation===accountGeneration&&portfolioId===state.portfolioId&&revision===historyRevision){historyBusy=false;historyController=null;render();if(routeInfo().route==='bets')focusElement(document.querySelector(historyError?'#retry-history':'#history-page-status'));}
  }
}
function csvRows(bets) {
  return bets.map(b=>[b.createdAt,b.selections.map(s=>s.team).join(' + '),b.selections.map(s=>s.market).join(' + '),b.selections.map(s=>formatOdds(s.odds)).join(' / '),b.type,b.stake,b.potentialPayout,b.status,b.payout,b.status==='open'?'':Math.round((b.payout-b.stake)*100)/100]);
}
function encodeCsv(rows) {return rows.map(row=>row.map(cell=>`"${String(cell).replaceAll('"','""')}"`).join(',')).join('\r\n');}
function downloadCsv(chunks) {
  const url=URL.createObjectURL(new Blob(chunks,{type:'text/csv;charset=utf-8;'}));
  const a=document.createElement('a');a.href=url;a.download='beter-practice-bets.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function yieldExport() {
  if(typeof globalThis.scheduler?.yield==='function')await globalThis.scheduler.yield();
  else await new Promise(resolve=>setTimeout(resolve,0));
}
async function exportCSV() {
  const header=encodeCsv([['Date','Selection','Market','American odds','Type','Stake','Potential payout','Status','Payout','Profit / loss']]);
  if(!accountMode){
    if(!state.bets.length){showToast('Place your first bet before exporting your history.');return;}
    downloadCsv([header,'\r\n',encodeCsv(csvRows(state.bets))]);showToast('Bet history exported.');return;
  }
  if(exportBusy)return;
  exportError='';
  if(getStats(state).totalBets>EXPORT_BET_LIMIT){exportError='Browser export supports up to 50,000 bets. Contact support for a complete export of this larger history.';render();return;}
  const generation=accountGeneration,portfolioId=state.portfolioId,controller=new AbortController();
  exportController=controller;exportBusy=true;exportCount=0;render();
  const chunks=[header],seen=new Set();let before=null;
  try {
    do {
      const result=await api.history(portfolioId,{before,limit:HISTORY_PAGE_SIZE,status:null,signal:controller.signal});
      if(generation!==accountGeneration||portfolioId!==state.portfolioId||!accountMode||controller.signal.aborted)return;
      exportCount+=result.bets.length;
      if(exportCount>EXPORT_BET_LIMIT)throw new Error('This history exceeds the 50,000-bet browser export limit. No partial file was downloaded.');
      if(result.bets.length)chunks.push('\r\n',encodeCsv(csvRows(result.bets)));
      before=result.nextCursor;
      if(before){if(seen.has(before))throw new Error('The history service repeated a page. Retry the export; no partial file was downloaded.');seen.add(before);}
      render();await yieldExport();
    } while(before);
    if(generation!==accountGeneration||portfolioId!==state.portfolioId||!accountMode||controller.signal.aborted)return;
    downloadCsv(chunks);showToast('Complete bet history exported.');
  } catch(error) {
    if(generation!==accountGeneration||portfolioId!==state.portfolioId||!accountMode)return;
    if(error.code==='REQUEST_ABORTED'||controller.signal.aborted)showToast('Export cancelled.');else exportError=error.message;
  } finally {
    if(generation===accountGeneration&&portfolioId===state.portfolioId&&accountMode){exportBusy=false;exportController=null;render();if(routeInfo().route==='bets')document.querySelector('[data-action="export"]')?.focus();}
  }
}

function accountModeHTML() {
  const local=appConfig.mode==='local';
  const sample=appConfig.dataMode!=='live';
  const label=local?'Local account / Sample feed':sample?'Saved account / Sample feed':'Saved account / Provider odds';
  return `<div class="account-mode-banner">${icon(sample?'info':'shield')}<div><strong>${label}</strong><p>${sample?'Your portfolio is stored on this server. These markets use illustrative data.':'Accepted odds and results are saved to your account. All stakes are virtual.'}</p></div></div><div id="connection-notice" class="connection-notice" ${refreshError?'':'hidden'} role="status">${esc(refreshError)} <button type="button" class="text-button" data-action="refresh-board">Refresh account</button></div>`;
}
function updateAccountChrome() {
  const button=document.querySelector('#account-button');
  const session=api.session();
  const logout=api.logoutState();
  button.textContent=sessionRestoring?'Account…':logout.pending?'Finish sign-out':session?'Account':'Sign in';
  button.disabled=sessionRestoring;
  if(sessionRestoring)button.setAttribute('aria-busy','true');else button.removeAttribute('aria-busy');
  button.setAttribute('aria-label',sessionRestoring?'Checking account':logout.pending?'Finish sign-out':session?'Manage account':'Sign in');
  document.querySelector('#signout-notice').hidden=!logout.pending;
  document.querySelector('#signout-description').textContent=logout.persistent?'Your account is hidden while sign-out is unfinished. Connect to the internet and retry before leaving this device.':'Your account is hidden, but this browser could not remember the sign-out request. Reloading or opening another tab may restore your account. Keep this page open and retry before leaving this device.';
  document.querySelector('#retry-signout').disabled=authBusy;
  if(authBusy)document.querySelector('#retry-signout').setAttribute('aria-busy','true');else document.querySelector('#retry-signout').removeAttribute('aria-busy');
  document.querySelector('#footer-feed-label').textContent=accountMode?(appConfig.dataMode==='live'?'Provider odds, virtual wagers':'Sample feed, no real wagers'):'Sample odds, no real wagers';
}
function accountSelection(id) {
  for(const event of events) {
    const selection=event.selections?.find(s=>s.id===id);
    if(selection)return {...selection,eventId:event.id,eventName:`${event.away_team} at ${event.home_team}`,startsAt:event.starts_at,sport:event.sport,line:selection.market==='Moneyline'?'To win':selection.line};
  }
  return null;
}
function marketsHTML(full=false) {
  if(!accountMode)return demoMarketsHTML(full);
  const {params}=routeInfo();
  const active=sports.includes(params.get('sport'))?params.get('sport'):'All sports';
  return `<section id="markets" aria-labelledby="markets-title"><div class="section-header market-heading"><div><h2 id="markets-title">${full?'Markets':'Explore the board'}</h2><p>Pregame moneyline singles. ${appConfig.dataMode==='live'?'Provider prices, virtual stakes.':'Sample feed, server-held portfolio.'}</p></div><button type="button" class="text-button" data-action="refresh-board">${icon('reset')}Refresh board</button></div><div class="market-toolbar"><div class="sport-tabs" role="group" aria-label="Filter by sport">${sports.map(s=>`<button type="button" class="sport-tab" data-sport="${s}" aria-pressed="${active===s}">${icon(sportIcon(s))}${s}</button>`).join('')}</div><label class="search-field">${icon('search')}<span class="visually-hidden">Search teams</span><input type="search" id="market-search" name="teams" autocomplete="off" placeholder="Search teams" value="${esc(params.get('q')||'')}"></label></div>${marketHelpHTML()}<div id="market-results">${marketResultsHTML(full)}</div><p class="board-note">${icon('info')}${appConfig.dataMode==='live'?'Prices are snapshots from the named bookmaker. Betting closes before the scheduled start.':'Games, times and odds are illustrative. This account uses the sample feed.'} Results are processed on the server.</p></section>`;
}
function marketResultsHTML(full=false) {
  if(!accountMode)return demoMarketResultsHTML(full);
  const {params}=routeInfo(),sport=params.get('sport')||'All sports',query=(params.get('q')||'').toLowerCase().trim();
  let visible=events.filter(e=>(sport==='All sports'||!sports.includes(sport)||e.sport===sport)&&`${e.away_team} ${e.home_team} ${e.league}`.toLowerCase().includes(query));
  if(!full&&sport==='All sports'&&!query)visible=visible.slice(0,3);
  if(!visible.length)return `<div class="empty-state">${icon('search')}<h3>No available games</h3><p>${events.length?'Try another team or sport.':'The provider has no supported markets available. Refresh the board in a moment.'}</p><button type="button" class="button secondary" data-action="${events.length?'clear-filters':'refresh-board'}">${events.length?'Clear filters':'Refresh board'}</button></div>`;
  const abbreviation=name=>name.split(/\s+/).map(part=>part[0]).join('').slice(0,3).toUpperCase();
  return `<div class="board-labels"><span>Game / scheduled start</span><span>Spread</span><span>Moneyline</span><span>Total</span></div>${visible.map(event=>{
    const closed=event.status!=='upcoming'||Date.parse(event.starts_at)<=Date.now()+60000;
    const bookmaker=event.selections?.find(s=>s.market==='Moneyline')?.bookmaker||'Provider';
    const updated=event.provider_updated_at||event.fetched_at;
    return `<article class="event" aria-label="${esc(event.away_team)} at ${esc(event.home_team)}"><div class="event-meta">${icon(sportIcon(event.sport))}<strong>${esc(event.league)}</strong><span>${closed?'Betting closed':appConfig.dataMode==='live'?esc(bookmaker):'Sample fixture'}</span><time datetime="${esc(event.starts_at)}">${new Date(event.starts_at).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time></div>${[['away',event.away_team],['home',event.home_team]].map(([side,name])=>{
      const pick=event.selections?.find(s=>s.market==='Moneyline'&&s.side===side);
      const selected=pick&&selections.some(s=>s.id===pick.id);
      return `<div class="team-row"><div class="team-info"><span class="team-badge" aria-hidden="true">${esc(abbreviation(name))}</span><span class="team-name">${esc(name)}<small>${side==='away'?'Away':'Home'}</small></span></div><span class="unsupported-market" aria-label="Spread is not available in this release">—</span>${pick?`<button type="button" class="odds-button" data-pick="${esc(pick.id)}" aria-pressed="${Boolean(selected)}" aria-label="${esc(pick.team)} Moneyline To win, odds ${formatOdds(pick.odds)}" ${closed||placementInFlight?'disabled':''}><span class="odds">${formatOdds(pick.odds)}</span></button>`:'<span class="unsupported-market">Unavailable</span>'}<span class="unsupported-market" aria-label="Total is not available in this release">—</span></div>`;
    }).join('')}<p class="feed-timestamp">${esc(bookmaker)} / Updated ${updated?new Date(updated).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',second:'2-digit'}):'time unavailable'}</p></article>`;
  }).join('')}`;
}
function invalidateQuote() {
  slipRevision++;
  if(quoteController){quoteController.abort();quoteController=null;betBusy=false;}
  acceptedQuote=null;placementRequestId=null;confirmationAttempted=false;betError='';
  document.querySelector('.quote-review')?.remove();
  if(accountMode){const button=document.querySelector('.place-button');if(button&&!betBusy)button.textContent='Review practice bet';}
}
function slipHTML() {
  if(!accountMode)return demoSlipHTML();
  const selection=selections[0];
  const quoted=acceptedQuote?.selections?.[0];
  let payout=0,total=0;
  try{if(selection){total=stakeInCents()/100;payout=potentialPayout(total,[quoted?{...selection,...quoted}:selection]);}}catch{}
  const quoteChanged=quoted&&(quoted.odds!==selection?.odds||quoted.line!==undefined&&selection?.market!=='Moneyline'&&quoted.line!==selection?.line);
  return `<aside class="right-rail" aria-label="Practice bet slip"><section class="bet-slip" id="bet-slip" aria-labelledby="slip-title"><div class="slip-title"><h2 id="slip-title">${icon('ticket')}Bet slip <span class="count-badge">${selection?1:0}</span></h2>${selection?'<button type="button" class="text-button" data-action="clear-slip">Clear</button>':''}</div>${slipStatusHTML()}${!selection?`<div class="slip-empty"><span class="slip-empty-symbol">${icon('ticket')}</span><h3>Make a considered selection.</h3><p>Choose a moneyline on the board to review a server quote before placing your practice bet.</p><a class="button secondary" href="#sportsbook">Explore markets</a></div>`:`<form id="bet-form" class="slip-content" novalidate><p class="slip-hint">Single bet / ${appConfig.dataMode==='live'?'Provider odds':'Sample feed'}</p><div class="slip-selection"><h3>${esc(selection.team)}</h3><p>${esc(selection.eventName)}</p><div class="selection-market"><span>${esc(selection.market)}</span><strong>${formatOdds(selection.odds)}</strong></div><p class="selection-explanation">${esc(selectionExplanation(selection))}</p><button type="button" class="remove-selection" data-remove="${esc(selection.id)}" aria-label="Remove ${esc(selection.team)}">×</button></div><label class="stake-label" for="stake">Virtual stake<span>${money(state.balance)} available</span></label><div class="stake-input"><span>$</span><input id="stake" name="stake" type="number" inputmode="decimal" step="0.01" min="0.01" autocomplete="off" value="${esc(stake)}" aria-describedby="slip-error" aria-invalid="${Boolean(stakeError)}" required ${betBusy?'disabled':''}></div><div class="quick-stakes">${[25,50,100].map(v=>`<button type="button" data-stake="${v}" ${betBusy?'disabled':''}>$${v}</button>`).join('')}</div>${acceptedQuote?`<section class="quote-review" aria-label="Quote review"><h3>Accepted quote</h3><p>${esc(quoted?.team||selection.team)} <strong>${formatOdds(quoted?.odds||selection.odds)}</strong></p>${quoteChanged?'<p class="quote-change">The price changed. Review the updated odds before confirming.</p>':''}<p>Expires <time datetime="${esc(acceptedQuote.expires_at)}">${new Date(acceptedQuote.expires_at).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',second:'2-digit'})}</time></p><button type="button" class="text-button" data-action="revise-quote" ${betBusy?'disabled':''}>Change selection or stake</button></section>`:''}<div id="slip-calculation">${slipCalculationHTML(total,payout)}</div><button type="submit" class="button primary place-button" ${betBusy?'disabled aria-busy="true"':''}>${betBusy?'Please wait…':acceptedQuote?'Confirm practice bet':'Review practice bet'}</button><p id="slip-error" class="form-error" role="alert">${esc(betError||stakeError)}</p><p class="slip-hint">Review the quoted odds, then confirm. Payout includes your stake. Results are settled on the server.</p></form>`}<div class="slip-footer">${icon('lock')}Virtual funds. Server-held records.</div></section><section class="practice-note">${icon('book')}<h3>Practice with perspective.</h3><p>${appConfig.dataMode==='live'?'Actual market prices help you track your thinking over time.':'Sample markets let you explore your account without a provider connection.'}</p><a href="#learn">Learn the fundamentals</a></section></aside>`;
}
function stakeInCents() {
  const amount=Number(stake),cents=Math.round(amount*100);
  if(!Number.isFinite(amount)||!Number.isSafeInteger(cents)||cents<=0||Math.abs(amount*100-cents)>.000001)throw new Error('Enter a positive stake with up to two decimal places.');
  if(cents>Math.round(state.balance*100))throw new Error('Your stake exceeds your available virtual balance.');
  return cents;
}
function updateAccountCalculation({validate=false}={}) {
  const node=document.querySelector('#slip-calculation');if(!node)return;
  let total=0,payout=0,error='';
  try{total=stakeInCents()/100;payout=potentialPayout(total,selections,'single');}catch(cause){error=cause.message;}
  node.innerHTML=slipCalculationHTML(total,payout);
  stakeError=validate?error:'';
  document.querySelector('#slip-error').textContent=stakeError;
  document.querySelector('#stake').setAttribute('aria-invalid',String(Boolean(stakeError)));
}
async function submitAccountBet() {
  if(betBusy)return;
  let cents;
  try{cents=stakeInCents();if(selections.length!==1)throw new Error('Choose one moneyline selection.');}
  catch(error){stakeError=error.message;render();document.querySelector('#stake')?.focus();return;}
  const generation=accountGeneration;
  let revision=slipRevision;
  const selectionId=selections[0].id;
  const placing=Boolean(acceptedQuote);
  const controller=placing?null:new AbortController();
  if(controller)quoteController=controller;
  placementInFlight=placing;
  betBusy=true;betError='';render();
  try {
    if(!acceptedQuote) {
      const quote=await api.quote([selectionId],{signal:controller.signal});
      if(generation!==accountGeneration||revision!==slipRevision||selectionId!==selections[0]?.id)return;
      if(!quote?.id||!Array.isArray(quote.selections)||quote.selections.length!==1||!Number.isFinite(Date.parse(quote.expires_at)))throw new Error('The quote response was incomplete. Please review again.');
      if(quote.selections[0].id!==selectionId)throw new Error('The quote does not match this selection. Review the current odds again.');
      if(quoteController===controller)quoteController=null;
      acceptedQuote=quote;placementRequestId=crypto.randomUUID();confirmationAttempted=false;
    } else {
      if(!confirmationAttempted&&Date.parse(acceptedQuote.expires_at)<=Date.now()){invalidateQuote();throw new Error('This quote expired. Review the current odds again.');}
      confirmationAttempted=true;
      const result=await api.placeBet(acceptedQuote.id,cents,placementRequestId);
      if(generation!==accountGeneration)return;
      state=adaptPortfolio(result.portfolio);historyScope='';selections=[];clearSlipDraft();invalidateQuote();
      placementReceipt='Your bet is saved in My bets. Results will be settled automatically.';
      showToast('Practice bet recorded. Results will be settled automatically.');
    }
  } catch(error) {
    if(generation!==accountGeneration||(!placing&&revision!==slipRevision)||error.code==='REQUEST_ABORTED')return;
    if(error.status===409||error.code==='QUOTE_EXPIRED'||error.code==='QUOTE_CHANGED'){invalidateQuote();revision=slipRevision;}
    betError=error.message;
  } finally {
    if(quoteController===controller)quoteController=null;
    if(generation===accountGeneration&&(placing||revision===slipRevision)){
      placementInFlight=false;betBusy=false;render();
      const target=placementReceipt?document.querySelector('.placement-receipt'):document.querySelector('.quote-review');
      if(target){target.setAttribute('tabindex','-1');target.focus();}
    }
  }
}
async function loadAccount({quiet=false}={}) {
  if(accountRequest)return accountRequest;
  const generation=accountGeneration;
  if(!quiet){accountLoading=true;accountError='';render();}
  accountRequest=(async()=>{
    try {
      const [portfolio,markets]=await Promise.all([api.portfolio(),api.markets()]);
      if(generation!==accountGeneration||!accountMode)return;
      const updated=adaptPortfolio(portfolio);
      if(!Array.isArray(markets.events))throw new Error('The markets response was invalid.');
      state=updated;events=markets.events;accountError='';refreshError='';
      accountLoading=false;
      restoreSlip();
      if(!quiet||!selections.length&&!authDialog.open&&!dialog.open&&!editingForm())render();
      else {const notice=document.querySelector('#connection-notice');if(notice)notice.hidden=true;}
    } catch(error) {
      if(generation!==accountGeneration||!accountMode)return;
      if(quiet){refreshError='The account could not be refreshed. Prices may be out of date.';const notice=document.querySelector('#connection-notice');if(notice){notice.hidden=false;notice.textContent=refreshError;}}
      else{accountError=error.message;accountLoading=false;render();}
    } finally {if(generation===accountGeneration)accountRequest=null;}
  })();
  return accountRequest;
}
function renderAuth() {
  const managing=authMode==='manage',recovering=authMode==='recover',resetting=authMode==='reset',confirming=authMode==='confirm',signup=authMode==='signup',newPassword=resetting||confirming||signup;
  const title=managing?'Your Beter account':confirming?'Reset your password':resetting?'Choose a new password':recovering?'Recover your account':signup?'Create your Beter account':'Sign in to Beter';
  const description=confirming?'Choose a new password. You’ll sign in again after updating it.':resetting?'Use at least 10 characters. This link is verified by the account service.':recovering?'Enter your email address to request password recovery instructions.':signup?'Start with $10,000 in virtual funds. Your records stay with your account.':'Keep your virtual portfolio and practice history together.';
  authDialog.innerHTML=`<form method="dialog" class="dialog-top"><span class="dialog-symbol">${icon('shield')}</span><button type="submit" class="icon-button" aria-label="Close account dialog">×</button></form>
    <h2 id="auth-title">${title}</h2>${managing?`<p class="dialog-description">${esc(api.session()?.user.email||'Your account')}</p><p class="auth-help">${appConfig.mode==='local'?'This is a local development account. Its portfolio is stored on this server and uses sample markets.':'Your practice portfolios are saved to your account.'}</p><button type="button" class="button secondary auth-submit" data-action="signout" ${authBusy?'disabled':''}>Sign out</button>`:`
    <p class="dialog-description">${description}</p><form id="auth-form" method="post">
    ${resetting?'':`<label for="auth-email">Email address</label><input id="auth-email" name="email" type="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" value="${esc(authEmail)}" required ${confirming?'readonly':''} ${authBusy?'disabled':''}>`}
    ${confirming?`<label for="auth-code">Verification code</label><p id="auth-code-hint" class="auth-help">Enter the 6-digit code from your email. You can paste it here.</p><input id="auth-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" pattern="[0-9]{6}" minlength="6" maxlength="6" aria-describedby="auth-code-hint" required ${authBusy?'disabled':''}>`:''}
    ${recovering?'':`<label for="auth-password">${resetting||confirming?'New password':'Password'}</label>${confirming?'<p id="auth-password-hint" class="auth-help">Use 10 to 200 characters.</p>':''}<input id="auth-password" name="password" type="password" autocomplete="${newPassword?'new-password':'current-password'}" minlength="${newPassword?10:1}" maxlength="200" ${confirming?'aria-describedby="auth-password-hint"':''} required ${authBusy?'disabled':''}>`}
    <button type="submit" class="button primary auth-submit" ${authBusy?'disabled aria-busy="true"':''}>${authBusy?'Please wait…':resetting||confirming?'Update password':recovering?'Send recovery email':signup?'Create account':'Sign in'}</button></form>
    <div class="auth-actions">${confirming?`<button type="button" class="text-button" data-action="resend-recovery" ${authBusy?'disabled':''}>Resend code</button><button type="button" class="text-button" data-auth-mode="recover">Change email</button>`:''}${!resetting?`<button type="button" class="text-button" data-auth-mode="${signup||recovering||confirming?'signin':'signup'}">${signup||recovering||confirming?'Back to sign in':'Create account'}</button>${!signup&&!recovering&&!confirming?'<button type="button" class="text-button" data-auth-mode="recover">Forgot password?</button>':''}`:''}</div>`}
    <p class="form-error" id="auth-error" role="alert">${esc(authError)}</p><p class="auth-message" id="auth-message" role="status">${esc(authMessage)}</p>${!managing&&!resetting?`<p class="auth-help">${appConfig.mode==='local'?'Local development account. Email verification and delivery are not enabled.':'All funds and bets are virtual.'}</p>`:''}`;
}
function openAccount() {
  if(api.logoutState().pending){void signOutAccount();return;}
  authAttempt++;api.cancelAuthentication?.();
  authMode=api.session()?'manage':'signin';authError='';authMessage='';authBusy=false;renderAuth();authDialog.showModal();
  focusElement(document.querySelector('#auth-email')||document.querySelector('#auth-password')||document.querySelector('#auth-title'));
}
async function submitAuth(form,{resend=false}={}) {
  if(authBusy||!form||(resend?!form.elements.email.reportValidity():!form.reportValidity()))return;
  const attempt=++authAttempt;
  const action=resend?'recover':authMode;
  const password=form.elements.password?.value;
  const code=form.elements.code?.value;
  authEmail=form.elements.email?.value.trim()||authEmail;
  authBusy=true;authError='';authMessage='';renderAuth();
  try {
    if(action==='reset') {
      persistSlip();
      if(!recoveryToken)throw new Error('This recovery link is incomplete. Request a new recovery email.');
      await api.updatePassword(password,recoveryToken);if(attempt!==authAttempt)return;recoveryToken=null;
      try{await api.signout();}catch{}
      accountMode=false;accountGeneration++;placementInFlight=false;stakeError='';accountRequest=null;betBusy=false;accountLoading=false;accountError='';refreshError='';events=demoEvents;state=loadState();
      selections=[];restoredScope=null;draftMessage='';placementReceipt='';mode='single';invalidateQuote();restoreSlip();
      authMode='signin';authMessage='Your password has been updated. Sign in with your new password.';render();
    } else if(action==='recover') {
      const result=await api.recover(authEmail);if(attempt!==authAttempt)return;
      if(result.requiresCode)authMode='confirm';
      authMessage=result.message||'If this account exists, check your email for recovery instructions.';
    } else if(action==='confirm') {
      await api.confirmRecovery(authEmail,code,password);if(attempt!==authAttempt)return;
      authMode='signin';authMessage='Your password has been updated. Sign in with your new password.';
    } else {
      const result=await (action==='signup'?api.signup(authEmail,password):api.signin(authEmail,password));
      if(attempt!==authAttempt)return;
      if(result.requiresConfirmation||!api.session()){authMode='signin';authMessage='Check your email to confirm your account, then sign in.';}
      else{persistSlip();accountMode=true;accountGeneration++;placementInFlight=false;stakeError='';accountRequest=null;betBusy=false;selections=[];restoredScope=null;draftMessage='';placementReceipt='';invalidateQuote();mode='single';authDialog.close();await loadAccount();}
    }
  } catch(error){if(attempt===authAttempt&&error.code!=='REQUEST_ABORTED')authError=error.message;}
  finally{if(attempt===authAttempt){authBusy=false;renderAuth();updateAccountChrome();if(authMode==='confirm')focusElement(document.querySelector('#auth-code'));else if(action==='confirm')focusElement(document.querySelector('#auth-password'));}}
}
async function signOutAccount() {
  if(authBusy)return;
  persistSlip();
  authBusy=true;
  const signingOut=api.signout();
  hideAccount();authDialog.close();render();
  try{await signingOut;}catch{}
  authBusy=false;render();
  if(api.logoutState().pending)document.querySelector('#retry-signout').focus();else showToast('Signed out.');
}
function hideAccount() {
  accountGeneration++;placementInFlight=false;stakeError='';accountRequest=null;betBusy=false;accountMode=false;accountLoading=false;accountError='';refreshError='';events=demoEvents;state=loadState();selections=[];restoredScope=null;draftMessage='';placementReceipt='';invalidateQuote();mode='single';restoreSlip();
  authEmail='';authError='';authMessage='';recoveryToken=null;
  authDialog.replaceChildren();
}
document.querySelector('#retry-signout').addEventListener('click',()=>void signOutAccount());
window.addEventListener('storage',event=>{
  if(event.key!=='beter-logout-pending-v1'&&event.key!==null)return;
  if(api.logoutState().pending){api.cancelAuthentication();hideAccount();authDialog.close();}
  render();
});
function publicInfoUrl(value) {
  try{const url=new URL(value);return url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))?url.href:null;}catch{return null;}
}
function openHelp() {
  const support=publicInfoUrl(appConfig.supportUrl),privacy=publicInfoUrl(appConfig.privacyUrl),deletion=publicInfoUrl(appConfig.accountDeletionUrl);
  document.querySelector('#help-content').innerHTML=`<p class="dialog-description">Your email is used for sign-in and account recovery. Account portfolios, accepted bets, and corrections are stored with your account.</p><p class="dialog-description">Starting fresh creates another portfolio; it does not delete your account history. Separate personal practice and drafts stay in this browser.</p><div class="help-links">${support?`<a href="${esc(support)}" rel="noreferrer">Contact support</a>`:''}${privacy?`<a href="${esc(privacy)}" rel="noreferrer">Read the privacy policy</a>`:''}${deletion?`<a href="${esc(deletion)}" rel="noreferrer">Delete account</a>`:''}</div>${!support||!deletion?'<p class="dialog-note">Support and account-deletion links are not available in this preview.</p>':''}`;
  helpDialog.showModal();document.querySelector('#help-title').focus();
}
document.querySelector('#footer-help').addEventListener('click',openHelp);
helpDialog.addEventListener('close',()=>document.querySelector('#footer-help').focus());
function readRecoveryLink() {
  const url=new URL(location.href),fragment=new URLSearchParams(url.hash.slice(1));
  const type=fragment.get('type')||url.searchParams.get('type');
  const token=fragment.get('access_token')||url.searchParams.get('access_token');
  const authKeys=['access_token','refresh_token','expires_at','expires_in','token_type','type','error','error_code','error_description'];
  if(!authKeys.some(key=>fragment.has(key)||url.searchParams.has(key)))return;
  for(const key of authKeys)url.searchParams.delete(key);
  history.replaceState(null,'',url.pathname+(url.searchParams.size?'?'+url.searchParams:'')+'#overview');
  if(type==='recovery'&&token){recoveryToken=token;authMode='reset';authMessage='';authError='';renderAuth();authDialog.showModal();}
  else if(token){authMode='signin';authMessage='Your email link was opened. Sign in to continue.';renderAuth();authDialog.showModal();}
}
document.querySelector('#account-button').addEventListener('click',openAccount);
authDialog.addEventListener('close',()=>{authAttempt++;api.cancelAuthentication?.();authBusy=false;authDialog.querySelectorAll('input[type="password"],#auth-code').forEach(input=>{input.value='';});});
authDialog.addEventListener('click',event=>{if(event.target===authDialog){const rect=authDialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)authDialog.close();}});
function editingForm(){return Boolean(document.activeElement?.matches('input,textarea,select,[contenteditable="true"]'));}
window.addEventListener('focus',()=>{if(accountMode&&!accountLoading&&!selections.length&&!authDialog.open&&!dialog.open&&!editingForm())void loadAccount({quiet:true});});
setInterval(()=>{if(accountMode&&!document.hidden&&!accountLoading&&!selections.length&&!authDialog.open&&!dialog.open&&!editingForm())void loadAccount({quiet:true});},30000);
window.addEventListener('hashchange',()=>{render();window.scrollTo({top:0,behavior:'instant'});document.querySelector('#main').focus({preventScroll:true});});
let resizePending=false;
window.addEventListener('resize',()=>{if(!resizePending){resizePending=true;requestAnimationFrame(()=>{redrawChart();resizePending=false;});}});
if(!accountMode)restoreSlip();
render();
readRecoveryLink();
void (async()=>{
  const generation=accountGeneration;
  const sessionRestore=(api.restoreSession?api.restoreSession().catch(()=>null):Promise.resolve(null)).finally(()=>{
    sessionRestoring=false;updateAccountChrome();
  });
  try{appConfig=await api.config();}catch{appConfig={mode:'unconfigured',dataMode:'sample'};}
  await sessionRestore;
  if(generation!==accountGeneration)return;
  if(api.session()){
    persistSlip();accountMode=true;accountGeneration++;placementInFlight=false;stakeError='';
    selections=[];restoredScope=null;draftMessage='';placementReceipt='';invalidateQuote();
    await loadAccount();
  }else if(!accountMode&&!editingForm())render();
})();
if(storageWarning)showToast('Your saved portfolio could not be loaded. The sample portfolio is open.');
