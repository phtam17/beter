import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

const user={id:'private-user',email:'private@example.test'};
const session=()=>({user,expires_at:Math.floor(Date.now()/1000)+3600});
const portfolio=()=>({id:'private-portfolio',initial_bankroll_cents:1000000,balance_cents:1000000,bets:[],ledger:[{id:'grant',type:'grant',amount_cents:1000000,balance_cents:1000000,bankroll_cents:1000000,created_at:new Date().toISOString()}]});
async function setup(context,{links=false,config={}}={}){
  const state={signedIn:true,failLogout:true,calls:[]};
  await context.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;state.calls.push(path);
    const respond=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/api/config')return respond({mode:'supabase',dataMode:'live',liveOddsConfigured:true,...(links?{supportUrl:'https://example.test/help',privacyUrl:'https://example.test/privacy',accountDeletionUrl:'https://example.test/delete'}:{}),...config});
    if(path==='/api/auth/session')return respond({session:state.signedIn?session():null});
    if(path==='/api/auth/signout'){if(state.failLogout)return route.abort('failed');state.signedIn=false;return respond({ok:true});}
    if(path==='/api/portfolio')return respond(portfolio());
    if(path==='/api/markets')return respond({events:[]});
    return respond({});
  });
  return state;
}
async function signOut(page){await page.getByRole('button',{name:'Manage account',exact:true}).click();await page.getByRole('button',{name:'Sign out',exact:true}).click();}

test('failed sign-out stays visible across reload and new tabs until cookie revocation succeeds',async({page,context})=>{
  const state=await setup(context);await page.goto('/');await signOut(page);
  await expect(page.getByRole('alert').filter({hasText:'Sign-out is unfinished'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry sign-out',exact:true})).toBeFocused();
  await expect(page.getByRole('button',{name:'Manage account',exact:true})).toHaveCount(0);
  expect(await page.locator('#auth-dialog').textContent()).not.toContain(user.email);
  expect(await page.evaluate(()=>localStorage.getItem('beter-logout-pending-v1'))).toBe('1');
  state.calls=[];await page.reload();
  await expect(page.getByRole('button',{name:'Retry sign-out',exact:true})).toBeVisible();
  expect(state.calls).not.toContain('/api/auth/session');
  const second=await context.newPage();await second.goto('/');
  await expect(second.getByRole('button',{name:'Retry sign-out',exact:true})).toBeVisible();
  expect(state.calls).not.toContain('/api/portfolio');
  state.failLogout=false;await second.getByRole('button',{name:'Retry sign-out',exact:true}).click();
  await expect(second.getByRole('button',{name:'Retry sign-out',exact:true})).toHaveCount(0);
  expect(await second.evaluate(()=>localStorage.getItem('beter-logout-pending-v1'))).toBeNull();
  await second.reload();await expect(second.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  await second.close();
});

test('an already open tab hides its private account when another tab starts sign-out',async({page,context})=>{
  await setup(context);await page.goto('/');
  const second=await context.newPage();await second.goto('/');
  await expect(second.getByRole('button',{name:'Manage account',exact:true})).toBeVisible();
  await signOut(page);
  await expect(second.getByRole('button',{name:'Manage account',exact:true})).toHaveCount(0);
  await expect(second.getByRole('button',{name:'Retry sign-out',exact:true})).toBeVisible();
  await expect(second.getByText('Saved account / Provider odds',{exact:true})).toHaveCount(0);
  await second.close();
});

test('blocked browser storage explains the remaining sign-out risk and offers retry',async({page,context})=>{
  await setup(context);
  await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage blocked','SecurityError');}}));
  await page.goto('/');await signOut(page);
  await expect(page.getByRole('alert').filter({hasText:'Reloading or opening another tab may restore your account'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Retry sign-out',exact:true})).toBeVisible();
  await expect(page.getByText('Signed out on this device. The server could not be reached.',{exact:true})).toHaveCount(0);
});

test('help and data information exposes configured support and account deletion destinations',async({page,context})=>{
  await setup(context,{links:true});await page.goto('/');
  await page.getByRole('button',{name:'Help and data',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Help and data',exact:true});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('link',{name:'Contact support',exact:true})).toHaveAttribute('href','https://example.test/help');
  await expect(dialog.getByRole('link',{name:'Read the privacy policy',exact:true})).toHaveAttribute('href','https://example.test/privacy');
  await expect(dialog.getByRole('link',{name:'Delete account',exact:true})).toHaveAttribute('href','https://example.test/delete');
  await expect(dialog).toContainText('Your email is used for sign-in and account recovery.');
  await expect(dialog).toContainText('Starting fresh creates another portfolio; it does not delete your account history.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Help and data',exact:true})).toBeFocused();
});

test('help information never invents missing contact or deletion destinations',async({page,context})=>{
  await setup(context);await page.goto('/');
  await page.getByRole('button',{name:'Help and data',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Help and data',exact:true});
  await expect(dialog.getByRole('link',{name:'Contact support',exact:true})).toHaveCount(0);
  await expect(dialog.getByRole('link',{name:'Delete account',exact:true})).toHaveCount(0);
  await expect(dialog).toContainText('Support and account-deletion links are not available in this preview.');
});

test('compact help keeps readable content and rejects executable destination schemes',async({page,context})=>{
  await page.setViewportSize({width:375,height:812});
  await setup(context,{links:true,config:{supportUrl:'javascript:alert(1)',accountDeletionUrl:'data:text/html,delete'}});await page.goto('/');
  await page.getByRole('button',{name:'Help and data',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Help and data',exact:true});
  await expect(dialog.getByRole('link',{name:'Contact support',exact:true})).toHaveCount(0);
  await expect(dialog.getByRole('link',{name:'Delete account',exact:true})).toHaveCount(0);
  await expect(dialog.getByRole('link',{name:'Read the privacy policy',exact:true})).toBeVisible();
  expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
});

test('a real HttpOnly cookie cannot silently restore after an interrupted logout',async({page,context})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByLabel('Email address',{exact:true}).fill(`logout-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('Password',{exact:true}).fill('a-safe-signout-test-password');
  await page.getByRole('dialog',{name:'Create your Beter account',exact:true}).getByRole('button',{name:'Create account',exact:true}).click();
  await expect(page.getByRole('button',{name:'Manage account',exact:true})).toBeVisible();
  let blocked=true;const restored=[];
  await context.route('**/api/auth/signout',route=>blocked?route.abort('failed'):route.continue());
  context.on('request',request=>{if(new URL(request.url()).pathname==='/api/auth/session')restored.push(request.url());});
  await signOut(page);
  expect((await context.cookies()).some(cookie=>cookie.httpOnly&&cookie.name.includes('beter-session'))).toBe(true);
  await page.reload();await expect(page.getByRole('button',{name:'Retry sign-out',exact:true})).toBeVisible();
  expect(restored).toEqual([]);
  await expect(page.getByRole('button',{name:'Manage account',exact:true})).toHaveCount(0);
  blocked=false;await page.getByRole('button',{name:'Retry sign-out',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  expect((await context.cookies()).some(cookie=>cookie.name.includes('beter-session'))).toBe(false);
});

const historyId=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const historyBet=(n,{status='open',team=`Recent selection ${n}`}={})=>({id:historyId(n),stake_cents:100,potential_payout_cents:250,payout_cents:status==='won'?250:0,status,created_at:new Date(Date.now()-200000+n*1000).toISOString(),settled_at:status==='open'?null:new Date().toISOString(),odds:2.5,selections:[{id:`pick-${n}`,event_id:`event-${n}`,event_name:'Example Away at Example Home',team,market:'Moneyline',side:'home',line:null,odds:150}]});
async function setupHistory(context,{total=101}={}){
  const recent=Array.from({length:100},(_,index)=>historyBet(index+1));
  const older=historyBet(101,{status:'won',team:'Older winning selection'}),cursor=historyId(1);
  const data={...portfolio(),id:historyId(500),bets:recent,summary:{total_bets:total,open_bets:total>101?total:100,settled_bets:total>101?0:1,wins:total>101?0:1,losses:0,voids:0,amount_at_risk_cents:(total>101?total:100)*100,total_staked_cents:total*100,settled_staked_cents:total>101?0:100},history_next_cursor:cursor,ledger_sampled:true,ledger_total_points:1000};
  const state={signedIn:true,calls:[],failOlderOnce:false,holdOlder:false,releaseOlder:null,repeatCursor:false,holdFilter:false,releaseFilter:null};
  await context.route('**/api/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname;
    const respond=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/api/config')return respond({mode:'supabase',dataMode:'live',liveOddsConfigured:true});
    if(path==='/api/auth/session')return respond({session:state.signedIn?session():null});
    if(path==='/api/auth/signout'){state.signedIn=false;return respond({ok:true});}
    if(path==='/api/portfolio')return respond(data);
    if(path==='/api/markets')return respond({events:[]});
    if(path==='/api/history'){
      state.calls.push({before:url.searchParams.get('before'),status:url.searchParams.get('status'),limit:url.searchParams.get('limit')});
      if(state.repeatCursor&&state.calls.length>3)return respond({error:{code:'BACKEND_UNAVAILABLE',message:'History could not be loaded.'}},503);
      if(url.searchParams.has('before')&&state.failOlderOnce){state.failOlderOnce=false;return respond({error:{code:'BACKEND_UNAVAILABLE',message:'History could not be loaded. Retry the request.'}},503);}
      if(url.searchParams.has('before')&&state.holdOlder)await new Promise(resolve=>state.releaseOlder=resolve);
      if(url.searchParams.get('status')==='won'&&state.holdFilter)await new Promise(resolve=>state.releaseFilter=resolve);
      return respond(url.searchParams.get('status')==='won'||url.searchParams.has('before')?{bets:[older],nextCursor:state.repeatCursor?cursor:null}:{bets:[...recent].reverse(),nextCursor:cursor});
    }
    return respond({});
  });
  return state;
}

test('account history keeps all-time summaries and identifies sampled chart points',async({page,context},testInfo)=>{
  await setupHistory(context);await page.goto('/');
  await expect(page.locator('.stats-row')).toContainText('101');
  await expect(page.locator('.stats-row')).toContainText('1 won / 0 lost');
  await expect(page.locator('.chart-section')).toContainText(/sampled history points/i);
  if(testInfo.project.name==='chromium'){
    await page.setViewportSize({width:375,height:1100});
    await page.getByRole('link',{name:/^My bets/}).click();
    await page.getByRole('button',{name:'Older bets',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:'artifacts/production-history-mobile.png',fullPage:false});
  }
});

test('account history pages replace cards, offer retry, and return to newer records',async({page,context})=>{
  const state=await setupHistory(context);state.failOlderOnce=true;await page.goto('/#bets');
  await expect(page.locator('.bet-card')).toHaveCount(100);
  await page.getByRole('button',{name:'Older bets',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'History could not be loaded'})).toBeVisible();
  await expect(page.locator('.bet-card')).toHaveCount(100);
  await page.getByRole('button',{name:'Retry history',exact:true}).click();
  await expect(page.locator('.bet-card')).toHaveCount(1);
  await expect(page.locator('.bet-card')).toContainText('Older winning selection');
  await page.getByRole('button',{name:'Newer bets',exact:true}).click();
  await expect(page.locator('.bet-card')).toHaveCount(100);
  await expect(page.locator('.bet-card').filter({hasText:'Older winning selection'})).toHaveCount(0);
  expect(state.calls.every(call=>call.limit==='100')).toBe(true);
});

test('account history result filters search older records on the server',async({page,context})=>{
  const state=await setupHistory(context);state.holdFilter=true;await page.goto('/#bets');
  await page.getByRole('button',{name:'Won',exact:true}).click();
  await expect.poll(()=>typeof state.releaseFilter).toBe('function');
  await expect(page.getByText('Loading bet history…',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'No won bets',exact:true})).toHaveCount(0);
  state.releaseFilter();
  await expect(page.locator('.bet-card')).toHaveCount(1);
  await expect(page.locator('.bet-card')).toContainText('Older winning selection');
  expect(state.calls.some(call=>call.status==='won'&&call.before===null)).toBe(true);
});

test('account CSV includes every page rather than only the visible recent bets',async({page,context})=>{
  const state=await setupHistory(context);await page.goto('/#bets');
  const downloading=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export CSV',exact:true}).click();
  const download=await downloading,contents=await readFile(await download.path(),'utf8');
  expect(contents).toContain('Older winning selection');
  expect(contents.split('\r\n')).toHaveLength(102);
  expect(state.calls.map(call=>call.before)).toEqual([null,historyId(1)]);
  expect(state.calls.every(call=>call.limit==='100'&&call.status===null)).toBe(true);
});

test('account history responses from a signed-out account cannot replace guest content',async({page,context})=>{
  const state=await setupHistory(context);state.holdOlder=true;await page.goto('/#bets');
  await page.getByRole('button',{name:'Older bets',exact:true}).click();
  await expect.poll(()=>typeof state.releaseOlder).toBe('function');
  await signOut(page);state.releaseOlder();
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  await expect(page.locator('.bet-card').filter({hasText:'Older winning selection'})).toHaveCount(0);
  await expect(page.getByText('Saved account / Provider odds',{exact:true})).toHaveCount(0);
});

test('account CSV refuses an oversized export explicitly without downloading a partial file',async({page,context})=>{
  const state=await setupHistory(context,{total:50001});await page.goto('/#bets');
  let downloads=0;page.on('download',()=>downloads++);
  await page.getByRole('button',{name:'Export CSV',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'50,000'})).toBeVisible();
  expect(state.calls).toEqual([]);expect(downloads).toBe(0);
});

test('account CSV rejects a repeated history cursor without a partial download',async({page,context})=>{
  const state=await setupHistory(context);state.repeatCursor=true;await page.goto('/#bets');
  let downloads=0;page.on('download',()=>downloads++);
  await page.getByRole('button',{name:'Export CSV',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'repeated'})).toBeVisible();
  expect(state.calls.length).toBeLessThanOrEqual(2);expect(downloads).toBe(0);
});

test('account CSV export cannot finish after its account signs out',async({page,context})=>{
  const state=await setupHistory(context);state.holdOlder=true;await page.goto('/#bets');
  let downloads=0;page.on('download',()=>downloads++);
  await page.getByRole('button',{name:'Export CSV',exact:true}).click();
  await expect.poll(()=>typeof state.releaseOlder).toBe('function');
  await signOut(page);state.releaseOlder();
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  expect(downloads).toBe(0);
});
