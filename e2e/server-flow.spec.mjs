import {test,expect} from '@playwright/test';
test('a real local account places a server-held bet and restores it after sign-in',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const email=`browser-${crypto.randomUUID()}@example.test`,password='a-secure-browser-test-password';
  await page.goto('/');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByLabel('Email address',{exact:true}).fill(email);
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('dialog',{name:'Create your Beter account',exact:true}).getByRole('button',{name:'Create account',exact:true}).click();
  await expect(page.getByText('Local account / Sample feed',{exact:true})).toBeVisible();
  await expect(page.locator('.stats-row')).toContainText('$10,000.00');
  await page.getByRole('link',{name:'Sportsbook',exact:true}).click();
  await page.getByRole('button',{name:'New York Knicks Moneyline To win, odds +150',exact:true}).click();
  await page.getByRole('button',{name:'Review practice bet',exact:true}).click();
  await expect(page.getByText('Accepted quote',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Confirm practice bet',exact:true}).click();
  await page.getByRole('link',{name:/^My bets/}).click();
  await expect(page.locator('.stats-row')).toContainText('$9,900 available');
  await expect(page.getByText('Results are settled automatically from event results.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Mark won',exact:true})).toHaveCount(0);
  await page.reload();await expect(page.locator('.stats-row')).toContainText('$9,900 available');
  await page.getByRole('button',{name:'Manage account',exact:true}).click();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByLabel('Email address',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('dialog',{name:'Sign in to Beter',exact:true}).getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.locator('.stats-row')).toContainText('$9,900 available');
  await expect(page.locator('.bet-card')).toHaveCount(1);
  expect(errors).toEqual([]);
  await page.screenshot({path:'artifacts/beter-account-desktop.png',fullPage:true});
});

test('real API clients cannot see another account portfolio or grade their own bet',async({request})=>{
  const signup=async()=>{
    const response=await request.post('/api/auth/signup',{data:{email:`isolation-${crypto.randomUUID()}@example.test`,password:'another-secure-test-password'}});
    expect(response.status()).toBe(201);return(await response.json()).session.access_token;
  };
  const one=await signup(),two=await signup();
  const read=token=>request.get('/api/portfolio',{headers:{Authorization:'Bearer '+token}});
  const first=await(await read(one)).json(),second=await(await read(two)).json();
  expect(first.id).not.toBe(second.id);expect(first.balance_cents).toBe(1000000);expect(second.bets).toHaveLength(0);
  const result=await request.post('/api/jobs/process',{headers:{Authorization:'Bearer '+two},data:{status:'won'}});
  expect([403,503]).toContain(result.status());
  expect((await request.post('/api/settle',{headers:{Authorization:'Bearer '+two},data:{status:'won'}})).status()).toBe(404);
});

test('browser accounts use a private cookie and resume without script-readable session data',async({page})=>{
  const email=`cookie-${crypto.randomUUID()}@example.test`,password='a-safe-cookie-test-password';
  await page.goto('/');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await page.getByLabel('Email address',{exact:true}).fill(email);
  await page.getByLabel('Password',{exact:true}).fill(password);
  const signedUp=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/signup');
  await page.getByRole('dialog',{name:'Create your Beter account',exact:true}).getByRole('button',{name:'Create account',exact:true}).click();
  const payload=await(await signedUp).json();
  const exposesToken=value=>value&&typeof value==='object'&&Object.entries(value).some(([key,child])=>['access_token','refresh_token'].includes(key)||exposesToken(child));
  expect(Boolean(exposesToken(payload)),'browser signup response exposes authentication tokens').toBe(false);
  await expect(page.getByRole('button',{name:'Manage account',exact:true})).toBeVisible();
  const exposed=await page.evaluate(email=>{
    const stored=[...Object.entries(localStorage),...Object.entries(sessionStorage)];
    return {legacySession:localStorage.getItem('beter-session-v1')!==null,email:stored.some(([,value])=>value.includes(email)),tokens:stored.some(([,value])=>/access_token|refresh_token/.test(value)),cookieText:document.cookie};
  },email);
  expect(exposed.legacySession).toBe(false);expect(exposed.email).toBe(false);expect(exposed.tokens).toBe(false);
  const cookies=(await page.context().cookies()).filter(cookie=>cookie.name.includes('beter'));
  expect(cookies.length,'a browser session cookie exists').toBeGreaterThan(0);
  for(const cookie of cookies){expect(cookie.httpOnly).toBe(true);expect(cookie.sameSite).toBe('Lax');expect(cookie.path).toBe('/');expect(exposed.cookieText.includes(cookie.name)).toBe(false);}
  await page.reload();
  await expect(page.getByRole('button',{name:'Manage account',exact:true})).toBeVisible();
  await expect(page.locator('.stats-row')).toContainText('$10,000.00');
  await page.getByRole('button',{name:'Manage account',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Your Beter account',exact:true})).toContainText(email);
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.reload();
  await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();
  expect((await page.context().cookies()).filter(cookie=>cookie.name.includes('beter')).map(cookie=>cookie.name)).toEqual([]);
});
