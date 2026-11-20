import { test, expect } from '@playwright/test';

async function buildSlip(page) {
  await page.goto('/#sportsbook');
  await page.getByRole('button', { name: 'Boston Celtics Moneyline To win, odds -175', exact: true }).click();
  await expect(page.locator('#stake')).toBeVisible();
}

test('field boundaries remain distinguishable from their adjacent surfaces', async ({ page }) => {
  await buildSlip(page);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const fields = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgb = value => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const luminance = value => rgb(value).map(channel => {
      const normalized = channel / 255;
      return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    return ['.search-field input', '.stake-input', '#auth-email', '#auth-password'].map(selector => {
      const element = document.querySelector(selector);
      let surface = element;
      while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') surface = surface.parentElement;
      const border = getComputedStyle(element).borderTopColor;
      const background = getComputedStyle(surface).backgroundColor;
      const values = [luminance(border), luminance(background)].sort((a, b) => b - a);
      return { selector, border, background, ratio: (values[0] + .05) / (values[1] + .05) };
    });
  });
  for (const field of fields) expect.soft(field.ratio, `${field.selector}: ${field.border} on ${field.background}`).toBeGreaterThanOrEqual(3);
});

test('selected options retain a visible shape distinction in forced colors', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await buildSlip(page);
  await page.evaluate(() => document.activeElement?.blur());
  const states = await page.evaluate(() => [
    '.sport-tab[aria-pressed="true"]',
    '.slip-content .segmented [aria-pressed="true"]',
    '.odds-button[aria-pressed="true"]',
    '.main-nav [aria-current="page"]',
  ].map(selector => {
    const style = getComputedStyle(document.querySelector(selector));
    return { selector, outlineWidth: parseFloat(style.outlineWidth), outlineStyle: style.outlineStyle };
  }));
  for (const state of states) {
    expect.soft(state.outlineWidth, state.selector).toBeGreaterThanOrEqual(2);
    expect.soft(state.outlineStyle, state.selector).toBe('solid');
  }
});

test('scrolling a modal backdrop keeps the underlying page at its original position', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open practice settings', exact: true }).click();
  const position = await page.evaluate(() => scrollY);
  await page.mouse.move(15, 400);
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => scrollY)).toBe(position);
  const containment = await page.locator('#settings-dialog').evaluate(element => ({
    dialog: getComputedStyle(element).overscrollBehavior,
    backdrop: getComputedStyle(element, '::backdrop').overscrollBehavior,
    backdropOverflow: getComputedStyle(element, '::backdrop').overflow,
  }));
  expect(containment).toEqual({ dialog: 'contain', backdrop: 'contain', backdropOverflow: 'hidden' });
  await page.keyboard.press('Escape');
  await page.mouse.wheel(0, 700);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(position);
});

test('tablet touch controls have comfortable targets independently of viewport width', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 768, height: 1024 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await buildSlip(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const targets = await page.locator('.slip-content .segmented button, .remove-selection, .quick-stakes button').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { label: element.getAttribute('aria-label') || element.textContent.trim(), width: rect.width, height: rect.height };
    }));
    for (const target of targets) {
      expect.soft(target.width, target.label).toBeGreaterThanOrEqual(44);
      expect.soft(target.height, target.label).toBeGreaterThanOrEqual(44);
    }
  } finally { await context.close(); }
});

test('critical local stylesheets are discoverable directly in cascade order', async ({ page, request }) => {
  const earlyStylesheets = new Set();
  let releaseStylesheet;
  page.on('request', requested => {
    const path = new URL(requested.url()).pathname;
    if (path === '/tokens.css' || path === '/base.css') earlyStylesheets.add(path);
  });
  await page.route('**/styles.css', route => new Promise(resolve => {
    releaseStylesheet = async () => { await route.continue(); resolve(); };
  }));
  await page.goto('/', { waitUntil: 'commit' });
  try {
    await expect.poll(() => Boolean(releaseStylesheet)).toBe(true);
    await expect.poll(() => [...earlyStylesheets].sort(), { timeout: 2000 }).toEqual(['/base.css', '/tokens.css']);
  } finally { if (releaseStylesheet) await releaseStylesheet(); }
  await page.waitForLoadState('domcontentloaded');
  const links = await page.locator('head link[rel="stylesheet"]').evaluateAll(elements => elements
    .filter(element => new URL(element.href).origin === location.origin)
    .map(element => new URL(element.href).pathname));
  expect(links).toEqual(['/tokens.css', '/base.css', '/styles.css']);
  const stylesheet = await request.get('/styles.css');
  expect(stylesheet.ok()).toBe(true);
  expect(await stylesheet.text()).not.toMatch(/@import\b/);
});
