import { test, expect } from '@playwright/test';

test.use({ baseURL: process.env.BETER_E2E_URL || process.env.E2E_BASE_URL || 'http://127.0.0.1:4173', viewport: { width: 1280, height: 900 } });
test.setTimeout(15000);

const user = { id: 'user-1', email: 'practice@example.com' };
const session = () => ({ user, expires_at: Math.floor(Date.now()/1000)+3600 });
const iso = offset => new Date(Date.now()+offset).toISOString();
const portfolio = () => ({ id: 'account-portfolio', initial_bankroll_cents:1000000, balance_cents:1000000, bets:[], ledger:[{id:'grant-1',type:'deposit',amount_cents:1000000,balance_cents:1000000,bankroll_cents:1000000,created_at:iso(-10000),bet_id:null}] });
const event = () => ({ id:'nba-real-1',sport:'Basketball',league:'NBA',home_team:'New York Knicks',away_team:'Boston Celtics',starts_at:iso(3600000),status:'upcoming',provider_updated_at:iso(-10000),fetched_at:iso(-1000),selections:[{id:'nba-real-1-home',team:'New York Knicks',market:'Moneyline',line:null,side:'home',odds:150,bookmaker:'draftkings',provider_updated_at:iso(-10000),fetched_at:iso(-1000)},{id:'nba-real-1-away',team:'Boston Celtics',market:'Moneyline',line:null,side:'away',odds:-175,bookmaker:'draftkings',provider_updated_at:iso(-10000),fetched_at:iso(-1000)}] });

async function mockApi(page,{portfolioError=false,quoteError=false,confirmSignup=false,initialSession=false}={}) {
  const calls=[];
  let accountPortfolio=portfolio(),signedIn=initialSession;
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    let body;try{body=request.postDataJSON();}catch{}
    calls.push({path,body,headers:request.headers()});
    const respond=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/api/config')return respond({mode:'local',dataMode:'sample',liveOddsConfigured:false,supabaseConfigured:false});
    if(path==='/api/auth/session')return respond({session:signedIn?session():null});
    if(path==='/api/auth/signin'){signedIn=true;return respond({session:session(),user});}
    if(path==='/api/auth/signup'){signedIn=!confirmSignup;return respond(confirmSignup?{session:null,user,requiresConfirmation:true}:{session:session(),user});}
    if(path==='/api/auth/signout'){signedIn=false;return respond({ok:true});}
    if(path==='/api/auth/recover')return respond({message:'If this account exists, a recovery email has been sent.'});
    if(path==='/api/auth/password')return respond({ok:true});
    if(path==='/api/portfolio')return portfolioError?respond({error:{code:'UNAVAILABLE',message:'Your portfolio could not be loaded.'}},503):respond(accountPortfolio);
    if(path==='/api/markets')return respond({events:[event()]});
    if(path==='/api/quotes')return quoteError?respond({error:{code:'MARKET_STALE',message:'These odds are stale. Please refresh the board.'}},409):respond({id:'quote-1',expires_at:iso(30000),selections:[{...event().selections[0],event_id:'nba-real-1',event_name:'BOS at NYK',starts_at:iso(3600000)}],total_decimal_odds:2.5});
    if(path==='/api/bets') {
      const bet={id:'server-bet-1',stake_cents:body.stakeCents,potential_payout_cents:25000,payout_cents:0,status:'open',created_at:iso(0),settled_at:null,selections:[{...event().selections[0],event_id:'nba-real-1',event_name:'BOS at NYK',starts_at:iso(3600000)}],odds:2.5};
      accountPortfolio={...accountPortfolio,balance_cents:1000000-body.stakeCents,bets:[bet],ledger:[...accountPortfolio.ledger,{id:'stake-1',type:'stake',amount_cents:-body.stakeCents,balance_cents:1000000-body.stakeCents,bankroll_cents:1000000,created_at:iso(0),bet_id:bet.id}]};
      return respond({bet,portfolio:accountPortfolio});
    }
    if(path==='/api/portfolios'){accountPortfolio={...portfolio(),id:'second-portfolio'};return respond(accountPortfolio);}
    return respond({error:{code:'NOT_FOUND',message:'Unknown API route'}},404);
  });
  return calls;
}

async function signin(page) {
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByLabel('Email address',{exact:true}).fill(user.email);
  await page.getByLabel('Password',{exact:true}).fill('correct-horse-battery');
  await page.getByRole('dialog',{name:'Sign in to Beter',exact:true}).getByRole('button',{name:'Sign in',exact:true}).click();
}

test('sign in and receive a server-held portfolio with a clearly labelled sample feed',async({page})=>{
  const calls=await mockApi(page);await page.goto('/');await signin(page);
  await expect(page.getByText('Local account / Sample feed',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Manage account',exact:true})).toBeVisible();
  await expect(page.locator('.stats-row')).toContainText('$10,000.00');
  expect(calls.find(c=>c.path==='/api/portfolio').headers.authorization).toBeUndefined();
  expect(calls.find(c=>c.path==='/api/portfolio').headers['x-beter-client']).toBe('browser');
});

test('review and confirm a connected bet without exposing manual settlement',async({page})=>{
  const calls=await mockApi(page);await page.goto('/');await signin(page);
  await page.getByRole('link',{name:'Sportsbook',exact:true}).click();
  await page.getByRole('button',{name:'New York Knicks Moneyline To win, odds +150',exact:true}).click();
  await expect(page.getByRole('button',{name:'Parlay',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Review practice bet',exact:true}).click();
  await expect(page.getByText('Accepted quote',{exact:true})).toBeVisible();
  expect(calls.filter(c=>c.path==='/api/bets')).toHaveLength(0);
  await page.getByRole('button',{name:'Confirm practice bet',exact:true}).click();
  expect(calls.find(c=>c.path==='/api/bets').body).toMatchObject({quoteId:'quote-1',stakeCents:10000});
  expect(calls.find(c=>c.path==='/api/bets').body.requestId).toBeTruthy();
  await page.getByRole('link',{name:/^My bets/}).click();
  await expect(page.getByText('Results are settled automatically from event results.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Mark won',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Void bet',exact:true})).toHaveCount(0);
  await expect(page.locator('.stats-row')).toContainText('$9,900 available');
});

test('quote rejection is explicit and does not place or substitute a demo bet',async({page})=>{
  const calls=await mockApi(page,{quoteError:true});await page.goto('/');await signin(page);
  await page.getByRole('button',{name:'New York Knicks Moneyline To win, odds +150',exact:true}).click();
  await page.getByRole('button',{name:'Review practice bet',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('These odds are stale. Please refresh the board.');
  expect(calls.filter(c=>c.path==='/api/bets')).toHaveLength(0);
  await expect(page.locator('.stats-row')).toContainText('$10,000.00');
});

test('an account load failure offers retry and never shows the sample portfolio as account data',async({page})=>{
  await mockApi(page,{portfolioError:true});await page.goto('/');await signin(page);
  await expect(page.getByText('Your portfolio could not be loaded.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry connection',exact:true})).toBeVisible();
  await expect(page.getByText('$11,250.00',{exact:true})).toHaveCount(0);
});

test('saved account sessions restore the authoritative portfolio on reload',async({page})=>{
  await mockApi(page,{initialSession:true});await page.goto('/');
  await expect(page.getByText('Local account / Sample feed',{exact:true})).toBeVisible();
  await expect(page.locator('.stats-row')).toContainText('$10,000.00');
  await page.reload();await expect(page.locator('.stats-row')).toContainText('$10,000.00');
});

test('signup requiring confirmation explains the email step without signing in',async({page})=>{
  await mockApi(page,{confirmSignup:true});await page.goto('/');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByLabel('Email address',{exact:true}).fill(user.email);await page.getByLabel('Password',{exact:true}).fill('correct-horse-battery');
  await page.getByRole('dialog',{name:'Create your Beter account',exact:true}).getByRole('button',{name:'Create account',exact:true}).click();
  await expect(page.getByText('Check your email to confirm your account, then sign in.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Manage account',exact:true})).toHaveCount(0);
});

test('new account portfolios require confirmation and use the server operation',async({page})=>{
  const calls=await mockApi(page);await page.goto('/');await signin(page);
  await page.getByRole('button',{name:'Practice settings',exact:true}).first().click();
  await page.getByRole('button',{name:'Start fresh',exact:true}).click();
  await expect(page.getByText('Your previous portfolio and its history will be preserved.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Create portfolio',exact:true}).click();
  expect(calls.filter(c=>c.path==='/api/portfolios')).toHaveLength(1);
});

test('signout returns to the separate demo portfolio',async({page})=>{
  await mockApi(page);await page.goto('/');await signin(page);
  await page.getByRole('button',{name:'Manage account',exact:true}).click();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  await expect(page.getByText('Sample portfolio',{exact:true}).first()).toBeVisible();
  await expect(page.locator('.stats-row')).toContainText('$11,250.00');
});

test('password recovery removes the URL token and sends it only to the verified password endpoint',async({page})=>{
  const calls=await mockApi(page);
  await page.goto('/#access_token=recovery-link-token&type=recovery');
  await expect(page.getByRole('dialog',{name:'Choose a new password',exact:true})).toBeVisible();
  await expect(page).not.toHaveURL(/recovery-link-token/);
  await page.getByLabel('New password',{exact:true}).fill('a-new-strong-password');
  await page.getByRole('button',{name:'Update password',exact:true}).click();
  await expect(page.getByText('Your password has been updated. Sign in with your new password.',{exact:true})).toBeVisible();
  expect(calls.find(c=>c.path==='/api/auth/password').headers.authorization).toBe('Bearer recovery-link-token');
  expect(await page.evaluate(()=>localStorage.getItem('beter-session-v1'))).toBeNull();
});

test('a delayed configuration response does not erase credentials being entered',async({page})=>{
  await mockApi(page);
  let releaseConfig;
  await page.route('**/api/config',route=>{releaseConfig=()=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({mode:'local',dataMode:'sample'})});});
  await page.goto('/');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByLabel('Email address',{exact:true}).fill(user.email);
  await page.getByLabel('Password',{exact:true}).fill('keep-this-password');
  await releaseConfig();
  await expect(page.getByLabel('Email address',{exact:true})).toHaveValue(user.email);
  await expect(page.getByLabel('Password',{exact:true})).toHaveValue('keep-this-password');
});

test('changed prices are displayed for explicit review before confirmation',async({page})=>{
  const calls=await mockApi(page);
  await page.route('**/api/quotes',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:'updated-quote',expires_at:iso(30000),selections:[{...event().selections[0],odds:175,event_id:'nba-real-1'}],total_decimal_odds:2.75})}));
  await page.goto('/');await signin(page);await page.getByRole('button',{name:'New York Knicks Moneyline To win, odds +150',exact:true}).click();
  await page.getByRole('button',{name:'Review practice bet',exact:true}).click();
  await expect(page.getByText('The price changed. Review the updated odds before confirming.',{exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Quote review',exact:true})).toContainText('+175');
  expect(calls.filter(c=>c.path==='/api/bets')).toHaveLength(0);
});

test('interrupted confirmation retries retain the original request identifier',async({page})=>{
  await mockApi(page);const requests=[];
  await page.route('**/api/bets',async route=>{requests.push(route.request().postDataJSON());if(requests.length===1)return route.abort('failed');return route.fallback();});
  await page.goto('/');await signin(page);await page.getByRole('button',{name:'New York Knicks Moneyline To win, odds +150',exact:true}).click();
  await page.getByRole('button',{name:'Review practice bet',exact:true}).click();await page.getByRole('button',{name:'Confirm practice bet',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Unable to reach Beter.');
  await page.getByRole('button',{name:'Confirm practice bet',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Bet slip 0',exact:true})).toBeVisible();
  expect(requests).toHaveLength(2);expect(requests[0].requestId).toBe(requests[1].requestId);
});

test('mobile account markets keep readable odds and avoid horizontal overflow',async({page})=>{
  await page.setViewportSize({width:375,height:812});await mockApi(page);await page.goto('/');await signin(page);
  await expect(page.getByText('Local account / Sample feed',{exact:true})).toBeVisible();
  const dimensions=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,oddsFont:getComputedStyle(document.querySelector('.odds-button')).fontSize}));
  expect(dimensions).toEqual({overflow:false,oddsFont:'14px'});
});

test('account learning explains automatic settlement and separates demo-only controls',async({page})=>{
  await mockApi(page);await page.goto('/');await signin(page);await page.getByRole('link',{name:'Learn',exact:true}).click();
  await page.getByText('Use the practice room',{exact:true}).click();
  await expect(page.getByText('Account bets are settled automatically. Demo mode supports manual sample outcomes.',{exact:true})).toBeVisible();
  await expect(page.getByText('Pregame moneyline singles are available in your account. Parlays are available in the separate demo.',{exact:true})).toHaveCount(1);
});

test('a late bet confirmation cannot replace a newly created portfolio',async({page})=>{
  await mockApi(page);
  let heldBet;
  const pendingBet=new Promise(resolve=>{heldBet=resolve;});
  await page.route('**/api/bets',route=>heldBet(route));
  await page.goto('/');await signin(page);
  await page.getByRole('button',{name:'New York Knicks Moneyline To win, odds +150',exact:true}).click();
  await page.getByRole('button',{name:'Review practice bet',exact:true}).click();
  await page.getByRole('button',{name:'Confirm practice bet',exact:true}).click();
  const route=await pendingBet;
  await page.getByRole('button',{name:'Practice settings',exact:true}).first().click();
  await page.getByRole('button',{name:'Start fresh',exact:true}).click();
  await page.getByRole('button',{name:'Create portfolio',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Your practice, your pace.',exact:true})).not.toBeVisible();
  await expect(page.locator('.stats-row')).toContainText('$10,000 available');
  const bet={id:'late-bet',stake_cents:10000,potential_payout_cents:25000,payout_cents:0,status:'open',created_at:iso(0),settled_at:null,selections:[{...event().selections[0],event_id:'nba-real-1',event_name:'BOS at NYK',starts_at:iso(3600000)}],odds:2.5};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({bet,portfolio:{...portfolio(),balance_cents:990000,bets:[bet]}})});
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.stats-row')).toContainText('$10,000 available');
  await expect(page.locator('.stats-row')).toContainText('0 open / 0 settled');
  await expect(page.getByRole('link',{name:'My bets 1',exact:true})).toHaveCount(0);
});
