import {test,expect} from '@playwright/test';
test.use({viewport:{width:375,height:812}});
const email='setup@example.test',password='a-private-setup-password',code='012345';
async function setup(page,{delayed=false,signinError=false,configDelayed=false,fragment=email}={}){
  const calls=[];let release,releaseConfig;const user={id:'11111111-1111-4111-8111-111111111111',email};
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname,body=route.request().postData()?route.request().postDataJSON():null;calls.push({path,body,url:route.request().url()});
    const respond=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});
    if(path==='/api/config'){const finish=()=>respond({mode:'aws',dataMode:'sample',liveOddsConfigured:false});if(configDelayed){releaseConfig=finish;return;}return finish();}
    if(path==='/api/auth/session')return respond({session:null});
    if(path==='/api/auth/confirm'){const finish=()=>respond({ok:true});if(delayed){release=finish;return;}return finish();}
    if(path==='/api/auth/signin')return signinError?respond({error:{code:'AUTH_FAILED',message:'Sign in failed.'}},401):respond({session:{user,expires_at:Math.floor(Date.now()/1000)+3600},user});
    if(path==='/api/portfolio')return respond({id:'22222222-2222-4222-8222-222222222222',initial_bankroll_cents:1000000,balance_cents:1000000,bets:[],ledger:[]});
    if(path==='/api/markets')return respond({events:[]});
    return respond({error:{code:'UNEXPECTED',message:'Unexpected call'}},404);
  });
  await page.goto('/#setup-password='+encodeURIComponent(fragment));
  return{calls,release:()=>release?.(),releaseConfig:()=>releaseConfig?.()};
}
async function fill(page){await page.getByLabel('Verification code',{exact:true}).fill(code);await page.getByLabel('New password',{exact:true}).fill(password);}
test('one setup form resets the password then signs in and loads the private portfolio without sending email automatically',async({page})=>{
  const {calls}=await setup(page);const dialog=page.getByRole('dialog',{name:'Set your password',exact:true});await expect(dialog).toBeVisible();await expect(page).not.toHaveURL(/setup-password|setup%40|setup@/);
  await expect(page.getByLabel('Email address',{exact:true})).toHaveValue(email);await expect(page.getByLabel('Verification code',{exact:true})).toBeFocused();expect(calls.filter(call=>call.body)).toHaveLength(0);expect(calls.some(call=>call.url.includes('setup%40')||call.url.includes(email))).toBe(false);
  await fill(page);await page.getByRole('button',{name:'Set password and sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Manage account',exact:true})).toBeVisible();await expect(dialog).not.toBeVisible();await expect(page.getByText('Saved account / Sample feed',{exact:true})).toBeVisible();
  expect(calls.filter(call=>['/api/auth/confirm','/api/auth/signin'].includes(call.path)).map(call=>call.path)).toEqual(['/api/auth/confirm','/api/auth/signin']);expect(calls.find(call=>call.path==='/api/auth/confirm').body).toEqual({email,code,password});expect(calls.find(call=>call.path==='/api/auth/signin').body).toEqual({email,password});expect(calls.some(call=>/recover|resend/.test(call.path))).toBe(false);
  const stored=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},url:location.href}));for(const value of [email,password,code])expect(stored).not.toContain(value);
});
for(const cancel of ['close','back'])test(`${cancel} during a delayed reset prevents a later automatic sign-in`,async({page})=>{
  const api=await setup(page,{delayed:true});await fill(page);await page.getByRole('button',{name:'Set password and sign in',exact:true}).click();await expect.poll(()=>api.calls.some(call=>call.path==='/api/auth/confirm')).toBe(true);
  await page.getByRole('button',{name:cancel==='close'?'Close account dialog':'Back to sign in',exact:true}).click();await api.release();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));expect(api.calls.filter(call=>call.path==='/api/auth/signin')).toHaveLength(0);
  if(cancel==='close')await expect(page.locator('#auth-dialog')).not.toBeVisible();else await expect(page.getByRole('dialog',{name:'Sign in to Beter',exact:true})).toBeVisible();
});
test('a successful reset followed by failed sign-in says the password was saved and offers normal sign-in',async({page})=>{
  const {calls}=await setup(page,{signinError:true});await fill(page);await page.getByRole('button',{name:'Set password and sign in',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Sign in to Beter',exact:true});await expect(dialog).toContainText('Your password has been saved. Sign in with your new password to continue.');await expect(page.getByLabel('Email address',{exact:true})).toHaveValue(email);await expect(page.getByLabel('Password',{exact:true})).toHaveValue('');expect(calls.filter(call=>call.path==='/api/auth/confirm')).toHaveLength(1);expect(calls.filter(call=>call.path==='/api/auth/signin')).toHaveLength(1);
});
test('setup intent is scrubbed immediately and survives early AWS configuration without sending another email',async({page})=>{
  const api=await setup(page,{configDelayed:true});await expect(page).not.toHaveURL(/setup-password|setup%40|setup@/);await expect(page.locator('#auth-dialog')).not.toBeVisible();await api.releaseConfig();await expect(page.getByRole('dialog',{name:'Set your password',exact:true})).toBeVisible();await expect(page.getByLabel('Verification code',{exact:true})).toBeFocused();expect(api.calls.filter(call=>call.body)).toHaveLength(0);
});
test('invalid setup email is removed from the address and ignored without auth or email actions',async({page})=>{
  const api=await setup(page,{fragment:'not-an-email'});await expect(page).not.toHaveURL(/setup-password|not-an-email/);await expect(page.locator('#auth-dialog')).not.toBeVisible();expect(api.calls.filter(call=>call.body)).toHaveLength(0);
});
