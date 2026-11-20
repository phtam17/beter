import { test, expect } from '@playwright/test';

const iso = offset => new Date(Date.now() + offset).toISOString();
const accountA = { id: 'behavior-account-a', email: 'account-a@example.test' };
const accountB = { id: 'behavior-account-b', email: 'account-b@example.test' };
const celtics = 'Boston Celtics Moneyline To win, odds -175';
const knicks = 'New York Knicks Moneyline To win, odds +150';
const chiefs = 'Kansas City Chiefs Moneyline To win, odds -145';
const publicSession = user => ({ user, expires_at: Math.floor(Date.now() / 1000) + 3600 });
const portfolio = () => ({ id: 'behavior-portfolio', initial_bankroll_cents: 1000000,
  balance_cents: 1000000, bets: [], ledger: [{ id: 'behavior-grant', type: 'deposit',
    amount_cents: 1000000, balance_cents: 1000000, bankroll_cents: 1000000, created_at: iso(-1000) }] });
const fixture = () => ({ id: 'behavior-game', sport: 'Basketball', league: 'NBA',
  away_team: 'Boston Celtics', home_team: 'New York Knicks', status: 'upcoming', starts_at: iso(3600000),
  selections: [
    { id: 'behavior-celtics', team: 'Boston Celtics', side: 'away', market: 'Moneyline', line: null, odds: -175 },
    { id: 'behavior-knicks', team: 'New York Knicks', side: 'home', market: 'Moneyline', line: null, odds: 150 },
  ] });

async function mockApi(page, { holdQuote = false, holdSigninA = false } = {}) {
  let activeUser = null, heldQuote, heldSignin;
  let quoteReady, signinReady;
  const quoteRequest = new Promise(resolve => { quoteReady = resolve; });
  const signinRequest = new Promise(resolve => { signinReady = resolve; });
  const placements = [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body = {}; try { body = request.postDataJSON() || {}; } catch {}
    const respond = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/config') return respond({ mode: 'local', dataMode: 'sample' });
    if (path === '/api/auth/session') return respond({ session: activeUser ? publicSession(activeUser) : null });
    if (path === '/api/auth/signin') {
      const user = body.email === accountB.email ? accountB : accountA;
      if (holdSigninA && user.id === accountA.id) { heldSignin = route; signinReady(); return; }
      activeUser = user; return respond({ session: publicSession(user), user });
    }
    if (path === '/api/auth/signout') { activeUser = null; return respond({ ok: true }); }
    if (path === '/api/portfolio') return respond(portfolio());
    if (path === '/api/markets') return respond({ events: [fixture()] });
    if (path === '/api/quotes') {
      const selection = fixture().selections.find(item => item.id === body.selectionIds[0]);
      const quote = { id: `quote-for-${selection.id}`, expires_at: iso(30000),
        selections: [{ ...selection, event_id: 'behavior-game' }], total_decimal_odds: selection.odds > 0 ? 2.5 : 1 + 100 / 175 };
      if (holdQuote) { heldQuote = { route, quote }; quoteReady(); return; }
      return respond(quote);
    }
    if (path === '/api/bets') { placements.push(body); return respond({ portfolio: portfolio() }); }
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unexpected behavior-test request.' } }) });
  });
  return {
    quoteRequest, signinRequest, placements,
    async releaseQuote() { await heldQuote.route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(heldQuote.quote) }).catch(() => {}); },
    async releaseSigninA() { await heldSignin.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: publicSession(accountA), user: accountA }) }).catch(() => {}); },
  };
}

async function signin(page, user = accountA) {
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill('behavior-safe-password');
  await page.getByRole('dialog', { name: 'Sign in to Beter', exact: true }).getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function startPersonal(page) {
  await page.goto('/#sportsbook');
  await page.getByRole('button', { name: 'Start my $10,000 practice', exact: true }).click();
}

test('a quote response for an earlier selection cannot become confirmable after the slip changes', async ({ page }) => {
  const api = await mockApi(page, { holdQuote: true });
  await page.goto('/#sportsbook'); await signin(page);
  await page.getByRole('button', { name: celtics, exact: true }).click();
  await page.getByRole('button', { name: 'Review practice bet', exact: true }).click();
  await api.quoteRequest;
  await page.getByRole('button', { name: knicks, exact: true }).click();
  await api.releaseQuote(); await page.waitForLoadState('networkidle');
  await expect(page.locator('#bet-slip .slip-selection h3')).toHaveText('New York Knicks');
  await expect(page.getByRole('button', { name: 'Confirm practice bet', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review practice bet', exact: true })).toBeEnabled();
  expect(api.placements).toEqual([]);
});

test('closing an earlier sign-in and completing a newer one prevents the old response replacing the account', async ({ page }) => {
  const api = await mockApi(page, { holdSigninA: true });
  await page.goto('/'); await signin(page, accountA); await api.signinRequest;
  await page.getByRole('button', { name: 'Close account dialog', exact: true }).click();
  await signin(page, accountB);
  await expect(page.getByRole('button', { name: 'Manage account', exact: true })).toBeVisible();
  await api.releaseSigninA(); await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Manage account', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Your Beter account', exact: true })).toContainText(accountB.email);
  await expect(page.getByRole('dialog', { name: 'Your Beter account', exact: true })).not.toContainText(accountA.email);
});

test('clearing a slip by keyboard keeps focus on its meaningful empty heading', async ({ page }) => {
  await startPersonal(page); await page.getByRole('button', { name: celtics, exact: true }).click();
  const clear = page.locator('#bet-slip').getByRole('button', { name: 'Clear', exact: true });
  await clear.focus(); await clear.press('Enter');
  await expect(page.locator('#slip-title')).toBeFocused();
});

test('removing selections focuses the next remove control and finally the empty heading', async ({ page }) => {
  await startPersonal(page);
  await page.getByRole('button', { name: celtics, exact: true }).click();
  await page.getByRole('button', { name: chiefs, exact: true }).click();
  const removeCeltics = page.getByRole('button', { name: 'Remove Boston Celtics', exact: true });
  await removeCeltics.focus(); await removeCeltics.press('Enter');
  const removeChiefs = page.getByRole('button', { name: 'Remove Kansas City Chiefs', exact: true });
  await expect(removeChiefs).toBeFocused();
  await removeChiefs.press('Enter');
  await expect(page.locator('#slip-title')).toBeFocused();
});

test('switching authentication mode focuses the replacement email field', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const create = page.getByRole('button', { name: 'Create account', exact: true });
  await create.focus(); await create.press('Enter');
  await expect(page.getByLabel('Email address', { exact: true })).toBeFocused();
});

test('statistics description groups contain only their terms and descriptions', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.stats-row > .stat')).toHaveCount(4);
  const invalidChildren = await page.locator('.stats-row > .stat').evaluateAll(groups => groups.flatMap(group => [...group.children].filter(child => !['DT', 'DD'].includes(child.tagName)).map(child => child.tagName)));
  expect(invalidChildren).toEqual([]);
});

test('stake calculations stay live while first validation waits for blur and clears during correction', async ({ page }) => {
  await startPersonal(page); await page.getByRole('button', { name: celtics, exact: true }).click();
  const stake = page.locator('#stake');
  await stake.fill('');
  await expect(stake).toBeFocused();
  await expect(stake).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#slip-error')).toBeEmpty();
  await stake.press('Tab');
  await expect(stake).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#slip-error')).not.toBeEmpty();
  await stake.fill('50');
  await expect(stake).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#slip-error')).toBeEmpty();
  await expect(page.locator('#slip-calculation')).toContainText('$78.57');
});

test('switching away from a pending sign-in cancels its account-changing result', async ({ page }) => {
  const api = await mockApi(page, { holdSigninA: true });
  await page.goto('/'); await signin(page, accountA); await api.signinRequest;
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: 'Create your Beter account', exact: true });
  await expect(createDialog).toBeVisible();
  await api.releaseSigninA(); await page.waitForLoadState('networkidle');
  await expect(createDialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage account', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Email address', { exact: true })).toBeEnabled();
});

test('clearing a pending quote prevents its late response resurrecting the slip', async ({ page }) => {
  const api = await mockApi(page, { holdQuote: true });
  await page.goto('/#sportsbook'); await signin(page);
  await page.getByRole('button', { name: celtics, exact: true }).click();
  await page.getByRole('button', { name: 'Review practice bet', exact: true }).click();
  await api.quoteRequest;
  await page.locator('#bet-slip').getByRole('button', { name: 'Clear', exact: true }).click();
  await api.releaseQuote(); await page.waitForLoadState('networkidle');
  await expect(page.locator('#bet-slip .slip-selection')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Bet slip 0', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm practice bet', exact: true })).toHaveCount(0);
  await expect(page.getByText('Accepted quote', { exact: true })).toHaveCount(0);
  expect(api.placements).toEqual([]);
});

test('an actual placement retains its selection while later pick and Clear actions are blocked', async ({ page }) => {
  await mockApi(page);
  let placementReady;
  const pendingPlacement = new Promise(resolve => { placementReady = resolve; });
  await page.route('**/api/bets', route => placementReady(route));
  await page.goto('/#sportsbook'); await signin(page);
  await page.getByRole('button', { name: celtics, exact: true }).click();
  await page.getByRole('button', { name: 'Review practice bet', exact: true }).click();
  await expect(page.getByText('Accepted quote', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm practice bet', exact: true }).click();
  const request = await pendingPlacement;
  const attempted = request.request().postDataJSON();
  expect(attempted.quoteId).toBe('quote-for-behavior-celtics');
  // Native disabled buttons suppress click; enabled buttons must still honor request ownership.
  await page.getByRole('button', { name: knicks, exact: true }).evaluate(button => button.click());
  await page.locator('#bet-slip').getByRole('button', { name: 'Clear', exact: true }).evaluate(button => button.click());
  await expect(page.locator('#bet-slip .slip-selection')).toHaveCount(1);
  await expect(page.locator('#bet-slip .slip-selection h3')).toHaveText('Boston Celtics');
  const bet = { id: 'behavior-placed-bet', stake_cents: 10000, potential_payout_cents: 15714,
    payout_cents: 0, status: 'open', created_at: iso(0), settled_at: null,
    selections: [{ ...fixture().selections[0], event_id: 'behavior-game', event_name: 'BOS at NYK' }], odds: 1 + 100 / 175 };
  const saved = { ...portfolio(), balance_cents: 990000, bets: [bet] };
  await request.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bet, portfolio: saved }) });
  await expect(page.getByRole('heading', { name: 'Practice bet placed', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /^My bets/ }).click();
  await expect(page.locator('.bet-card')).toHaveCount(1);
  await expect(page.locator('.bet-card')).toContainText('Boston Celtics');
});

test('initial account identity finishes restoring before account actions become available', async ({ page }) => {
  await mockApi(page);
  let identityReady;
  const pendingIdentity = new Promise(resolve => { identityReady = resolve; });
  await page.route('**/api/auth/session', route => identityReady(route));
  await page.goto('/');
  const held = await pendingIdentity;
  await expect(page.locator('#account-button')).toBeDisabled();
  await held.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: publicSession(accountB) }) });
  await expect(page.getByRole('button', { name: 'Manage account', exact: true })).toBeEnabled();
  await expect(page.getByText('Local account / Sample feed', { exact: true })).toBeVisible();
  await expect(page.locator('.stats-row')).toContainText('$10,000.00');
});
