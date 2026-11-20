import {test,expect} from '@playwright/test';

test.use({viewport:{width:375,height:812}});
const email='recovery@example.test',password='a-new-recovery-password';
async function mockRecovery(page,{confirmError=null,confirmStatus=400,delayConfirm=false,delayRecover=false,legacy=false}={}){
  const calls=[];let releaseConfirm,releaseRecover;
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const body=route.request().postData()?route.request().postDataJSON():undefined;
    calls.push({path,body});
    const respond=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});
    if(path==='/api/config')return respond({mode:'aws',dataMode:'sample',authProvider:'cognito',liveOddsConfigured:false});
    if(path==='/api/auth/session')return respond({session:null});
    if(path==='/api/auth/recover'){
      const finish=()=>respond(legacy?{message:'Check your email for a recovery link.'}:{requiresCode:true,message:'If this account exists and is confirmed, check your email for a recovery code.'});
      if(delayRecover){releaseRecover=finish;return;}
      return finish();
    }
    if(path==='/api/auth/confirm'){
      const finish=()=>confirmError?respond({error:confirmError},confirmStatus):respond({ok:true});
      if(delayConfirm){releaseConfirm=finish;return;}
      return finish();
    }
    if(path==='/api/auth/password'||path==='/api/auth/signout')return respond({ok:true});
    return respond({error:{code:'NOT_FOUND',message:'Unknown route'}},404);
  });
  return {calls,releaseConfirm:()=>releaseConfirm?.(),releaseRecover:()=>releaseRecover?.()};
}
async function requestCode(page){
  await page.goto('/');await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Forgot password?',exact:true}).click();
  await page.getByLabel('Email address',{exact:true}).fill(email);
  await page.getByRole('button',{name:'Send recovery email',exact:true}).click();
}
async function enterConfirmation(page,code='012345'){
  await page.getByLabel('Verification code',{exact:true}).fill(code);
  await page.getByLabel('New password',{exact:true}).fill(password);
}

test('email code recovery fits a narrow screen, accepts paste and leading zero, and returns to sign-in without storing secrets',async({page})=>{
  const {calls}=await mockRecovery(page);await requestCode(page);
  const dialog=page.getByRole('dialog',{name:'Reset your password',exact:true}),code=page.getByLabel('Verification code',{exact:true});
  await expect(dialog).toBeVisible();await expect(code).toBeFocused();
  await expect(page.getByLabel('Email address',{exact:true})).toHaveValue(email);
  for(const [attribute,value] of Object.entries({type:'text',inputmode:'numeric',autocomplete:'one-time-code',pattern:'[0-9]{6}'}))await expect(code).toHaveAttribute(attribute,value);
  await expect(page.getByLabel('New password',{exact:true})).toHaveAttribute('autocomplete','new-password');
  await expect(dialog).toContainText('Enter the 6-digit code from your email');
  expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  expect(await code.evaluate(node=>node.dispatchEvent(new Event('paste',{bubbles:true,cancelable:true})))).toBe(true);
  await dialog.screenshot({path:'/tmp/beter-recovery-375.png'});
  await enterConfirmation(page);await page.getByRole('button',{name:'Update password',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Sign in to Beter',exact:true})).toContainText('Your password has been updated. Sign in with your new password.');
  expect(calls.find(call=>call.path==='/api/auth/confirm').body).toEqual({email,code:'012345',password});
  expect(calls.filter(call=>call.path==='/api/auth/signin')).toHaveLength(0);
  await expect(page.getByLabel('Password',{exact:true})).toHaveValue('');
  const stored=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},url:location.href}));
  expect(stored).not.toContain('012345');expect(stored).not.toContain(password);
});

test('code constraints stop malformed submission and an invalid code offers recovery without retaining secrets',async({page})=>{
  const {calls}=await mockRecovery(page,{confirmError:{code:'INVALID_CODE',message:'That recovery code is invalid or has expired. Request a new code.'}});await requestCode(page);
  await enterConfirmation(page,'12345');await page.getByRole('button',{name:'Update password',exact:true}).click();
  expect(calls.filter(call=>call.path==='/api/auth/confirm')).toHaveLength(0);
  await expect(page.getByLabel('Verification code',{exact:true})).toBeFocused();
  await page.getByLabel('Verification code',{exact:true}).fill('012345');await page.getByRole('button',{name:'Update password',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('That recovery code is invalid or has expired. Request a new code.');
  await expect(page.getByLabel('Verification code',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('New password',{exact:true})).toHaveValue('');
  await expect(page.getByLabel('Email address',{exact:true})).toHaveValue(email);
  await page.getByRole('button',{name:'Resend code',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'check your email for a recovery code'})).toBeVisible();
  expect(calls.filter(call=>call.path==='/api/auth/recover')).toHaveLength(2);
});

test('a delayed confirmation cannot replace a different account screen',async({page})=>{
  const api=await mockRecovery(page,{delayConfirm:true});await requestCode(page);await enterConfirmation(page);
  await page.getByRole('button',{name:'Update password',exact:true}).click();
  await expect.poll(()=>api.calls.filter(call=>call.path==='/api/auth/confirm').length).toBe(1);
  await expect(page.getByRole('button',{name:'Please wait…',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Back to sign in',exact:true}).click();await api.releaseConfirm();
  await expect(page.getByRole('dialog',{name:'Sign in to Beter',exact:true})).toBeVisible();
  await expect(page.getByText('Your password has been updated. Sign in with your new password.',{exact:true})).toHaveCount(0);
  await expect(page.getByLabel('Password',{exact:true})).toHaveValue('');
});

test('closing a delayed recovery request does not reopen or advance the account dialog',async({page})=>{
  const api=await mockRecovery(page,{delayRecover:true});await requestCode(page);
  await page.getByRole('button',{name:'Close account dialog',exact:true}).click();await api.releaseRecover();
  await expect(page.locator('#auth-dialog')).not.toBeVisible();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Sign in to Beter',exact:true})).toBeVisible();
  await expect(page.getByLabel('Verification code',{exact:true})).toHaveCount(0);
});

test('email can be corrected and Supabase link-based recovery remains available',async({page})=>{
  const api=await mockRecovery(page);await requestCode(page);
  await page.getByRole('button',{name:'Change email',exact:true}).click();
  await expect(page.getByLabel('Email address',{exact:true})).toHaveValue(email);
  await page.getByLabel('Email address',{exact:true}).fill('corrected@example.test');
  await page.getByRole('button',{name:'Send recovery email',exact:true}).click();
  await expect(page.getByLabel('Email address',{exact:true})).toHaveValue('corrected@example.test');
  expect(api.calls.filter(call=>call.path==='/api/auth/recover').at(-1).body.email).toBe('corrected@example.test');
  await page.goto('/?legacy-recovery=1#access_token=legacy-recovery-token&type=recovery');
  await expect(page.getByRole('dialog',{name:'Choose a new password',exact:true})).toBeVisible();
  await expect(page).not.toHaveURL(/legacy-recovery-token/);
  await page.getByLabel('New password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Update password',exact:true}).click();
  await expect(page.getByText('Your password has been updated. Sign in with your new password.',{exact:true})).toBeVisible();
});

test('closing the code screen clears its secrets and native Escape returns focus to the account opener',async({page})=>{
  await mockRecovery(page);await requestCode(page);await enterConfirmation(page);
  await page.keyboard.press('Escape');await expect(page.locator('#auth-dialog')).not.toBeVisible();
  await expect(page.locator('#auth-code')).toHaveValue('');
  await expect(page.locator('#auth-password')).toHaveValue('');
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeFocused();
});

test('an incomplete remote reset explains the uncertainty and leaves a usable sign-in path',async({page})=>{
  const message='Your password may have changed. Try signing in with the new password, or request another recovery code.';
  const {calls}=await mockRecovery(page,{confirmError:{code:'PASSWORD_RESET_INCOMPLETE',message},confirmStatus:503});
  await requestCode(page);await enterConfirmation(page);await page.getByRole('button',{name:'Update password',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText(message);
  await expect(page.getByRole('button',{name:'Update password',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Back to sign in',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Sign in to Beter',exact:true})).toBeVisible();
  expect(calls.filter(call=>call.path==='/api/auth/confirm')).toHaveLength(1);
  expect(calls.filter(call=>call.path==='/api/auth/signin')).toHaveLength(0);
});

test('link recovery instructions are preserved when the account service does not request a code',async({page})=>{
  await mockRecovery(page,{legacy:true});await requestCode(page);
  await expect(page.getByRole('dialog',{name:'Recover your account',exact:true})).toContainText('Check your email for a recovery link.');
  await expect(page.getByLabel('Verification code',{exact:true})).toHaveCount(0);
});

test('the recovery form remains readable and scrollable with doubled text at 375px',async({page})=>{
  await mockRecovery(page);await requestCode(page);
  await page.evaluate(()=>document.documentElement.style.fontSize='200%');
  const dialog=page.getByRole('dialog',{name:'Reset your password',exact:true});
  expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.getByLabel('Verification code',{exact:true}).fill('012345');
  await page.getByLabel('New password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Update password',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Sign in to Beter',exact:true})).toContainText('Your password has been updated.');
});

test('AWS sessions render the saved account and account management without local or vendor assumptions',async({page})=>{
  await mockRecovery(page);
  const user={id:'11111111-1111-4111-8111-111111111111',email};
  const respond=(route,value)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(value)});
  await page.route('**/api/auth/session',route=>respond(route,{session:{user,expires_at:Math.floor(Date.now()/1000)+3600}}));
  await page.route('**/api/portfolio',route=>respond(route,{id:'22222222-2222-4222-8222-222222222222',initial_bankroll_cents:1000000,balance_cents:1000000,bets:[],ledger:[]}));
  await page.route('**/api/markets',route=>respond(route,{events:[]}));
  await page.goto('/');
  await expect(page.getByText('Saved account / Sample feed',{exact:true})).toBeVisible();
  await expect(page.locator('.stats-row')).toContainText('$10,000.00');
  await page.getByRole('button',{name:'Manage account',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Your Beter account',exact:true})).toContainText('Your practice portfolios are saved to your account.');
  await expect(page.getByText('This is a local development account.',{exact:false})).toHaveCount(0);
});
