import {test,expect} from '@playwright/test';
test.use({viewport:{width:375,height:812}});
const email='verification@example.test',password='a-private-signup-password';
async function setup(page,{invalid=false,delayed=false}={}){
  const calls=[];let release;
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname,body=route.request().postData()?route.request().postDataJSON():null;calls.push({path,body});
    const respond=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)}).catch(()=>{});
    if(path==='/api/config')return respond({mode:'aws',dataMode:'sample',liveOddsConfigured:false});
    if(path==='/api/auth/session')return respond({session:null});
    if(path==='/api/auth/signup')return respond({session:null,requiresConfirmation:true,confirmationMethod:'code'});
    if(path==='/api/auth/resend')return respond({message:'If this account is waiting for confirmation, check your email for a verification code.'});
    if(path==='/api/auth/verify'){
      const finish=()=>invalid?respond({error:{code:'INVALID_CODE',message:'The verification code is invalid or expired. Request a new code and try again.'}},400):respond({ok:true});
      if(delayed){release=finish;return;}return finish();
    }
    return respond({error:{code:'UNEXPECTED',message:'Unexpected endpoint'}},404);
  });
  const config=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/config');await page.goto('/');await config;
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  return{calls,release:()=>release?.()};
}
async function signup(page){
  await page.getByRole('button',{name:'Create account',exact:true}).click();await page.getByLabel('Email address',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('dialog',{name:'Create your Beter account',exact:true}).getByRole('button',{name:'Create account',exact:true}).click();
}
test('signup opens the email code step and verifies without retaining a password or automatically signing in',async({page})=>{
  const {calls}=await setup(page);await signup(page);
  const dialog=page.getByRole('dialog',{name:'Verify your email',exact:true}),code=page.getByLabel('Verification code',{exact:true});await expect(dialog).toBeVisible();await expect(code).toBeFocused();await expect(page.getByLabel('Email address',{exact:true})).toHaveValue(email);
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  for(const [name,value]of Object.entries({type:'text',inputmode:'numeric',autocomplete:'one-time-code',pattern:'[0-9]{6}'}))await expect(code).toHaveAttribute(name,value);
  await code.fill('012345');await dialog.getByRole('button',{name:'Verify email',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Sign in to Beter',exact:true})).toContainText('Your email is verified. Sign in to continue.');
  expect(calls.find(call=>call.path==='/api/auth/verify').body).toEqual({email,code:'012345'});expect(calls.filter(call=>call.path==='/api/auth/signin')).toHaveLength(0);await expect(page.getByLabel('Password',{exact:true})).toHaveValue('');
  const stored=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},url:location.href}));expect(stored).not.toContain(password);expect(stored).not.toContain('012345');
});
test('old unconfirmed accounts can enter email and resend from sign-in without creating another account',async({page})=>{
  const {calls}=await setup(page);await page.getByLabel('Email address',{exact:true}).fill(email);await page.getByRole('button',{name:'Verify email',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Verify your email',exact:true})).toBeVisible();await expect(page.getByLabel('Email address',{exact:true})).toHaveValue(email);
  await page.getByRole('button',{name:'Resend code',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'waiting for confirmation'})).toBeVisible();expect(calls.filter(call=>call.path==='/api/auth/resend')).toHaveLength(1);expect(calls.filter(call=>call.path==='/api/auth/signup')).toHaveLength(0);
});
test('malformed and invalid confirmation codes keep a usable retry and resend path',async({page})=>{
  const {calls}=await setup(page,{invalid:true});await signup(page);await page.getByLabel('Verification code',{exact:true}).fill('12345');await page.getByRole('button',{name:'Verify email',exact:true}).click();expect(calls.filter(call=>call.path==='/api/auth/verify')).toHaveLength(0);
  await page.getByLabel('Verification code',{exact:true}).fill('012345');await page.getByRole('button',{name:'Verify email',exact:true}).click();await expect(page.getByRole('alert')).toContainText('The verification code is invalid or expired.');await expect(page.getByLabel('Verification code',{exact:true})).toHaveValue('');
  await page.getByRole('button',{name:'Resend code',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'waiting for confirmation'})).toBeVisible();
});
test('a late verification cannot replace a switched account screen',async({page})=>{
  const api=await setup(page,{delayed:true});await signup(page);await page.getByLabel('Verification code',{exact:true}).fill('012345');await page.getByRole('button',{name:'Verify email',exact:true}).click();await expect.poll(()=>api.calls.filter(call=>call.path==='/api/auth/verify').length).toBe(1);
  await page.getByRole('button',{name:'Back to sign in',exact:true}).click();await api.release();await expect(page.getByRole('dialog',{name:'Sign in to Beter',exact:true})).toBeVisible();await expect(page.getByText('Your email is verified. Sign in to continue.',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Password',{exact:true})).toHaveValue('');
});
test('a delayed AWS configuration reveals Verify email without erasing credentials already being typed',async({page})=>{
  let release;
  await page.route('**/api/config',route=>{release=()=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({mode:'aws',dataMode:'sample'})});});
  await page.route('**/api/auth/session',route=>route.fulfill({status:200,contentType:'application/json',body:'{"session":null}'}));
  await page.goto('/');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByLabel('Email address',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);await release();
  await expect(page.getByRole('button',{name:'Verify email',exact:true})).toBeVisible();await expect(page.getByLabel('Email address',{exact:true})).toHaveValue(email);await expect(page.getByLabel('Password',{exact:true})).toHaveValue(password);
});
