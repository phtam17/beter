import { test, expect } from '@playwright/test';
import { createInitialState, placeBets } from '../dist/engine.js';
import { getSelection } from '../dist/markets.js';

const celtics = 'Boston Celtics Moneyline To win, odds -175';
const chiefs = 'Kansas City Chiefs Moneyline To win, odds -145';
const personalKey = 'beter-practice-personal-v1';
const legacyKey = 'beter-practice-v1';

async function startPractice(page) {
  await page.getByRole('button', { name: 'Start my $10,000 practice', exact: true }).first().click();
  await expect(page).toHaveURL(/#sportsbook/);
}

async function placePersonalBet(page) {
  await startPractice(page);
  await page.getByRole('button', { name: celtics, exact: true }).click();
  await page.getByRole('button', { name: 'Place practice bet', exact: true }).click();
}

async function mockAccount(page) {
  const user = { id: 'draft-user', email: 'drafts@example.test' };
  const calls = [];
  let portfolioId = 'draft-portfolio';
  let signedIn = false;
  let odds = 150;
  const iso = offset => new Date(Date.now() + offset).toISOString();
  const market = () => ({
    id: 'draft-game', sport: 'Basketball', league: 'NBA', away_team: 'Boston Celtics',
    home_team: 'New York Knicks', starts_at: iso(3600000), status: 'upcoming',
    selections: [{ id: 'draft-knicks', team: 'New York Knicks', market: 'Moneyline',
      side: 'home', line: null, odds, bookmaker: 'Example bookmaker' }],
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push(path);
    const respond = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/config') return respond({ mode: 'local', dataMode: 'sample' });
    const publicSession = () => ({ user, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    if (path === '/api/auth/session') return respond({ session: signedIn ? publicSession() : null });
    if (path === '/api/auth/signin') { signedIn = true; return respond({ user, session: publicSession() }); }
    if (path === '/api/auth/signout') { signedIn = false; return respond({ ok: true }); }
    if (path === '/api/auth/password') return respond({ ok: true });
    if (path === '/api/portfolio' || path === '/api/portfolios') {
      if (path === '/api/portfolios') portfolioId = 'another-portfolio';
      return respond({ id: portfolioId, initial_bankroll_cents: 1000000, balance_cents: 1000000,
        bets: [], ledger: [{ id: 'grant', type: 'deposit', amount_cents: 1000000,
          balance_cents: 1000000, bankroll_cents: 1000000, created_at: iso(-10000) }] });
    }
    if (path === '/api/markets') return respond({ events: [market()] });
    if (path === '/api/quotes') return respond({ id: 'fresh-draft-quote', expires_at: iso(30000),
      selections: [{ ...market().selections[0], event_id: 'draft-game', event_name: 'BOS at NYK' }],
      total_decimal_odds: 1 + odds / 100 });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unexpected test API request.' } }) });
  });
  return { calls, user, setOdds(value) { odds = value; }, setPortfolio(value) { portfolioId = value; } };
}

async function signin(page, email) {
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('a-safe-test-password');
  await page.getByRole('dialog', { name: 'Sign in to Beter', exact: true }).getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Local account / Sample feed', { exact: true })).toBeVisible();
}

test('starting personal practice preserves earlier demo history and excludes its sample gains', async ({ page }) => {
  const legacy = placeBets(createInitialState(), [getSelection('bos-ny', 1, 0)], 40).state;
  await page.goto('/');
  await page.evaluate(value => localStorage.setItem('beter-practice-v1', value), JSON.stringify(legacy));
  await page.reload();
  await expect(page.locator('.stats-row')).toContainText('+$1,250.00');
  await startPractice(page);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.stats-row')).toContainText('$10,000.00');
  await expect(page.locator('.stats-row')).toContainText('0 open / 0 settled');
  await expect(page.locator('.stats-row')).not.toContainText('62.5%');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), legacyKey)).toEqual(legacy);
  const personal = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), personalKey);
  expect(personal.balance).toBe(10000);
  expect(personal.bets).toEqual([]);
});

test('selecting odds from sample preview starts an independent personal slip', async ({ page }) => {
  await page.goto('/#sportsbook');
  await page.getByRole('button', { name: celtics, exact: true }).click();
  await expect(page.locator('#bet-slip')).toContainText('Boston Celtics');
  await expect(page.locator('#bet-slip')).toContainText('$10,000.00 available');
  await page.getByRole('button', { name: 'Place practice bet', exact: true }).click();
  await page.getByRole('link', { name: /^My bets/ }).click();
  await expect(page.locator('.bet-card')).toHaveCount(1);
  await expect(page.locator('.stats-row')).toContainText('1 open / 0 settled');
  await expect(page.locator('.stats-row')).not.toContainText('+$1,250.00');
});

test('sample preview can be explored without replacing personal bets', async ({ page }) => {
  await page.goto('/');
  await placePersonalBet(page);
  await page.getByRole('button', { name: 'View sample portfolio', exact: true }).first().click();
  await page.getByRole('link', { name: /^My bets/ }).click();
  await expect(page.locator('.bet-card')).toHaveCount(8);
  await expect(page.getByRole('button', { name: 'Mark won', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Return to my practice', exact: true }).first().click();
  await page.getByRole('link', { name: /^My bets/ }).click();
  await expect(page.locator('.bet-card')).toHaveCount(1);
  await expect(page.locator('.stats-row')).toContainText('$9,900 available');
  await page.reload();
  await expect(page.locator('.bet-card')).toHaveCount(1);
});

test('market help and selection explanations teach within the betting decision', async ({ page }) => {
  await page.goto('/');
  await startPractice(page);
  await page.getByText('How these markets work', { exact: true }).click();
  await expect(page.locator('.market-help')).toContainText('Moneyline');
  await expect(page.locator('.market-help')).toContainText('Spread');
  await expect(page.locator('.market-help')).toContainText('Total');
  await page.getByRole('button', { name: celtics, exact: true }).click();
  await expect(page.locator('#bet-slip .selection-explanation')).toContainText(/Boston Celtics.*win/i);
  await expect(page.locator('#bet-slip')).toContainText('Potential profit');
  await expect(page.locator('#bet-slip')).toContainText('Payout includes your stake.');
});

test('unfinished parlay selections and stake survive interruption, and Clear remains cleared', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await startPractice(page);
  await page.getByRole('button', { name: celtics, exact: true }).click();
  await page.getByRole('button', { name: chiefs, exact: true }).click();
  await page.getByRole('button', { name: 'Review bet slip', exact: true }).click();
  await page.getByRole('button', { name: 'Parlay', exact: true }).click();
  await page.getByLabel('Parlay stake').fill('37.50');
  await page.reload();
  await expect(page.locator('#stake')).toHaveValue('37.50');
  await expect(page.getByRole('button', { name: 'Parlay', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#bet-slip .slip-selection')).toHaveCount(2);
  await page.locator('#bet-slip').getByRole('button', { name: 'Clear', exact: true }).click();
  await page.reload();
  await expect(page.locator('#bet-slip .slip-selection')).toHaveCount(0);
  await expect(page.locator('#stake')).toHaveCount(0);
});

test('placing a restored draft saves one bet and removes the draft on the next reload', async ({ page }) => {
  await page.goto('/');
  await startPractice(page);
  await page.getByRole('button', { name: celtics, exact: true }).click();
  await page.locator('#stake').fill('42');
  await page.reload();
  await expect(page.locator('#stake')).toHaveValue('42');
  await page.getByRole('button', { name: 'Place practice bet', exact: true }).click();
  await page.reload();
  await expect(page.locator('#bet-slip .slip-selection')).toHaveCount(0);
  await page.getByRole('link', { name: /^My bets/ }).click();
  await expect(page.locator('.bet-card')).toHaveCount(1);
  await expect(page.locator('.bet-card')).toContainText('$42.00');
});

test('empty history filters describe their filter and provide a direct way back to existing bets', async ({ page }) => {
  await page.goto('/#bets');
  await expect(page.locator('.bet-card')).toHaveCount(8);
  for (const status of ['Open', 'Voided']) {
    await page.getByRole('button', { name: status, exact: true }).click();
    await expect(page.getByRole('heading', { name: `No ${status.toLowerCase()} bets`, exact: true })).toBeVisible();
    await expect(page.getByText('Your first bet is a fresh start.', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show all bets', exact: true }).click();
    await expect(page.locator('.bet-card')).toHaveCount(8);
  }
});

test('navigation, history actions, and financial figures adapt across widths and enlarged text', async ({ page }) => {
  await page.goto('/');
  await placePersonalBet(page);
  await page.getByRole('link', { name: /^My bets/ }).click();

  async function expectFitsViewport(label, selector) {
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(dimensions.scrollWidth, `${label} page width`).toBeLessThanOrEqual(dimensions.width + 1);
    const bounds = await page.locator(selector).evaluateAll(elements => elements.flatMap(element => {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return [];
      return [{ label: element.textContent.trim(), left: rect.left, right: rect.right, width: innerWidth }];
    }));
    expect(bounds.length, `${label} visible controls`).toBeGreaterThan(0);
    for (const bound of bounds) {
      expect(bound.left, `${label} ${bound.label} left edge`).toBeGreaterThanOrEqual(-1);
      expect(bound.right, `${label} ${bound.label} right edge`).toBeLessThanOrEqual(bound.width + 1);
    }
  }

  for (const width of [320, 390, 641, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await expectFitsViewport(`${width}px`, '.site-header a, .site-header button, .bets-toolbar button');
    await expect(page.getByRole('link', { name: 'Learn', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export CSV', exact: true })).toBeVisible();
  }

  await page.setViewportSize({ width: 320, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await expectFitsViewport('320px with 200% text', '.main-nav a, .bets-toolbar button, .stat dd');
  const financialFigures = await page.locator('.stat dd').evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = range.getBoundingClientRect();
    return { label: element.textContent, boxLeft: box.left, boxRight: box.right, textLeft: text.left, textRight: text.right, scrollWidth: element.scrollWidth, width: element.clientWidth };
  }));
  for (const figure of financialFigures) {
    expect(figure.textLeft, `${figure.label} text left edge`).toBeGreaterThanOrEqual(figure.boxLeft - 1);
    expect(figure.textRight, `${figure.label} text right edge`).toBeLessThanOrEqual(figure.boxRight + 1);
    expect(figure.scrollWidth, `${figure.label} text overflow`).toBeLessThanOrEqual(figure.width + 1);
  }
});

test('personal and account drafts remain separate across sign-in and sign-out', async ({ page }) => {
  const api = await mockAccount(page);
  await page.goto('/');
  await startPractice(page);
  await page.getByRole('button', { name: celtics, exact: true }).click();
  await page.locator('#stake').fill('33');
  await signin(page, api.user.email);
  await expect(page.locator('#bet-slip .slip-selection')).toHaveCount(0);
  await page.getByRole('button', { name: 'New York Knicks Moneyline To win, odds +150', exact: true }).click();
  await page.locator('#stake').fill('74');
  await page.getByRole('button', { name: 'Manage account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('#stake')).toHaveValue('33');
  await expect(page.locator('#bet-slip .slip-selection')).toContainText('Boston Celtics');
  await signin(page, api.user.email);
  await expect(page.locator('#stake')).toHaveValue('74');
  await expect(page.locator('#bet-slip .slip-selection')).toContainText('New York Knicks');
});

test('account drafts restore current prices, require a fresh quote, and stay within their portfolio', async ({ page }) => {
  const api = await mockAccount(page);
  await page.goto('/');
  await signin(page, api.user.email);
  await page.getByRole('button', { name: 'New York Knicks Moneyline To win, odds +150', exact: true }).click();
  await page.locator('#stake').fill('65');
  await page.getByRole('button', { name: 'Review practice bet', exact: true }).click();
  await expect(page.getByText('Accepted quote', { exact: true })).toBeVisible();
  api.setOdds(175);
  await page.reload();
  await expect(page.locator('#stake')).toHaveValue('65');
  await expect(page.locator('#bet-slip .slip-selection')).toContainText('+175');
  await expect(page.getByText('Accepted quote', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review practice bet', exact: true })).toBeVisible();
  expect(api.calls.filter(path => path === '/api/quotes')).toHaveLength(1);
  await page.getByRole('button', { name: 'Practice settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Start fresh', exact: true }).click();
  await page.getByRole('button', { name: 'Create portfolio', exact: true }).click();
  await expect(page.locator('#bet-slip .slip-selection')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#bet-slip .slip-selection')).toHaveCount(0);
  api.setPortfolio('draft-portfolio');
  await page.reload();
  await expect(page.locator('#stake')).toHaveValue('65');
});

test('storage-blocked practice and drafts survive preview switches within the same session', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'beter-practice-personal-v1' || key.startsWith('beter-slip-draft-v1:')) {
        throw new DOMException('Storage is unavailable for this test.', 'QuotaExceededError');
      }
      return write.call(this, key, value);
    };
  });
  await placePersonalBet(page);
  await page.getByRole('button', { name: 'View sample portfolio', exact: true }).first().click();
  await page.getByRole('button', { name: 'Return to my practice', exact: true }).first().click();
  await page.getByRole('link', { name: /^My bets/ }).click();
  await expect(page.locator('.bet-card')).toHaveCount(1);
  await expect(page.locator('.stats-row')).toContainText('$9,900 available');
  await expect(page.getByText('Browser saving is unavailable. Your changes last for this session only. Keep this page open to retain them.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Sportsbook', exact: true }).click();
  await page.getByRole('button', { name: chiefs, exact: true }).click();
  await page.locator('#stake').fill('27');
  await page.getByRole('button', { name: 'View sample portfolio', exact: true }).first().click();
  await page.getByRole('button', { name: 'Return to my practice', exact: true }).first().click();
  await expect(page.locator('#stake')).toHaveValue('27');
  await expect(page.locator('#bet-slip .slip-selection')).toContainText('Kansas City Chiefs');
});

test('password recovery restores the personal draft and clears the restored account selection', async ({ page }) => {
  const api = await mockAccount(page);
  await page.goto('/');
  await startPractice(page);
  await page.getByRole('button', { name: celtics, exact: true }).click();
  await page.locator('#stake').fill('33');
  await signin(page, api.user.email);
  await page.getByRole('button', { name: 'New York Knicks Moneyline To win, odds +150', exact: true }).click();
  await page.locator('#stake').fill('74');
  await page.getByRole('button', { name: 'Review practice bet', exact: true }).click();
  await expect(page.getByText('Accepted quote', { exact: true })).toBeVisible();

  // A distinct query forces a full recovery-link navigation rather than a hash-only route change.
  await page.goto('/?recovery-test=1#access_token=ui-recovery-token&type=recovery');
  await expect(page.getByRole('dialog', { name: 'Choose a new password', exact: true })).toBeVisible();
  await expect(page.locator('#stake')).toHaveValue('74');
  await expect(page.locator('#bet-slip .slip-selection')).toContainText('New York Knicks');
  await page.getByLabel('New password', { exact: true }).fill('a-recovered-test-password');
  await page.getByRole('button', { name: 'Update password', exact: true }).click();

  await expect(page.getByText('Your password has been updated. Sign in with your new password.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage account', exact: true })).toHaveCount(0);
  await expect(page.locator('#stake')).toHaveValue('33');
  await expect(page.locator('#bet-slip .slip-selection')).toContainText('Boston Celtics');
  await expect(page.locator('#bet-slip .slip-selection')).not.toContainText('New York Knicks');
  await expect(page.getByText('Accepted quote', { exact: true })).toHaveCount(0);
  expect(api.calls).toContain('/api/auth/password');
  expect(api.calls).toContain('/api/auth/signout');
});
