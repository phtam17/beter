import test from 'node:test';
import assert from 'node:assert/strict';
import { saveDraft, loadDraft, clearDraft } from '../dist/drafts.js';

function memoryStorage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const pick = (id, odds = 150) => ({ id, team: 'Example team', odds });
const draft = (ids = ['one']) => ({ selections: ids.map(id => pick(id)), mode: 'single', stake: '25.50' });
const key = scope => 'beter-slip-draft-v1:' + encodeURIComponent(scope);
const restore = (storage, scope, options = {}) => loadDraft(storage, scope, { resolveSelection: id => pick(id), ...options });

test('drafts are isolated by practice, account, and portfolio scope', () => {
  const storage = memoryStorage();
  for (const scope of ['practice', 'account:one:portfolio-one', 'account:two:portfolio-one', 'account:one:portfolio-two']) {
    assert.equal(saveDraft(storage, scope, { ...draft([scope]), stake: scope }), true);
  }
  for (const scope of ['practice', 'account:one:portfolio-one', 'account:two:portfolio-one', 'account:one:portfolio-two']) {
    assert.equal(restore(storage, scope).stake, scope);
    assert.equal(restore(storage, scope).selections[0].id, scope);
  }
  assert.equal(restore(storage, 'account:missing:portfolio-one'), null);
});

test('saved data contains only intent, and restoration uses current resolver prices', () => {
  const storage = memoryStorage();
  saveDraft(storage, 'practice', { selections: [{ ...pick('one'), quote: 'secret', token: 'private' }], mode: 'parlay', stake: '' });
  const saved = JSON.parse(storage.getItem(key('practice')));
  assert.deepEqual(Object.keys(saved).sort(), ['mode', 'savedAt', 'selectionIds', 'stake', 'version']);
  assert.deepEqual(saved.selectionIds, ['one']);
  assert.equal(JSON.stringify(saved).includes('secret'), false);
  const current = pick('one', 175);
  const loaded = loadDraft(storage, 'practice', { resolveSelection: () => current });
  assert.equal(loaded.selections[0], current);
  assert.equal(loaded.stake, '');
  assert.equal(loaded.mode, 'parlay');
  assert.equal(loaded.removedCount, 0);
});

test('missing, closed, disabled, mismatched and throwing selections are removed individually', () => {
  const storage = memoryStorage();
  const ids = ['current', 'missing', 'closed', 'disabled', 'mismatch', 'throws'];
  saveDraft(storage, 'practice', draft(ids));
  const loaded = loadDraft(storage, 'practice', { resolveSelection: id => {
    if (id === 'missing') return null;
    if (id === 'closed') return { ...pick(id), status: 'closed' };
    if (id === 'disabled') return { ...pick(id), disabled: true };
    if (id === 'mismatch') return pick('different-id');
    if (id === 'throws') throw new Error('Unavailable');
    return pick(id);
  } });
  assert.deepEqual(loaded.selections.map(selection => selection.id), ['current']);
  assert.equal(loaded.removedCount, 5);
  const none = loadDraft(storage, 'practice', { resolveSelection: () => null });
  assert.deepEqual(none.selections, []);
  assert.equal(none.removedCount, 6);
});

test('account restoration keeps one valid single, even if an older draft was a parlay', () => {
  const storage = memoryStorage();
  saveDraft(storage, 'account:user:portfolio', { ...draft(['one', 'two']), mode: 'parlay' });
  const loaded = restore(storage, 'account:user:portfolio', { allowParlay: false });
  assert.deepEqual(loaded.selections.map(selection => selection.id), ['one']);
  assert.equal(loaded.mode, 'single');
  assert.equal(loaded.removedCount, 1);
});

test('invalid stake text is retained for inline correction instead of coerced', () => {
  const storage = memoryStorage();
  for (const stake of ['', '0', '-20', '1.234', 'not a number']) {
    assert.equal(saveDraft(storage, 'practice', { ...draft(), stake }), true);
    assert.equal(restore(storage, 'practice').stake, stake);
  }
});

test('drafts expire after seven days', () => {
  const storage = memoryStorage();
  saveDraft(storage, 'practice', draft());
  const { savedAt } = JSON.parse(storage.getItem(key('practice')));
  const week = 7 * 24 * 60 * 60 * 1000;
  assert.ok(restore(storage, 'practice', { now: savedAt + week - 1 }));
  assert.equal(restore(storage, 'practice', { now: savedAt + week }), null);
});

test('clearing and saving an empty slip remove only the matching draft', () => {
  const storage = memoryStorage();
  saveDraft(storage, 'practice', draft());
  saveDraft(storage, 'account:user:portfolio', draft());
  assert.equal(saveDraft(storage, 'practice', { selections: [] }), true);
  assert.equal(restore(storage, 'practice'), null);
  assert.ok(restore(storage, 'account:user:portfolio'));
  assert.equal(clearDraft(storage, 'account:user:portfolio'), true);
  assert.equal(storage.values.size, 0);
});

test('missing, corrupt, incompatible and malformed stored drafts fail gracefully', () => {
  const storage = memoryStorage();
  assert.equal(restore(storage, 'practice'), null);
  saveDraft(storage, 'practice', draft());
  const saved = JSON.parse(storage.getItem(key('practice')));
  const invalid = [null, [], {}, { ...saved, version: 2 }, { ...saved, selectionIds: [] },
    { ...saved, selectionIds: ['same', 'same'] }, { ...saved, selectionIds: [null] },
    { ...saved, selectionIds: [''] }, { ...saved, selectionIds: ['x'.repeat(513)] },
    { ...saved, selectionIds: Array.from({ length: 21 }, (_, index) => String(index)) },
    { ...saved, mode: 'unknown' }, { ...saved, stake: 100 }, { ...saved, stake: '1'.repeat(129) },
    { ...saved, savedAt: -1 }, { ...saved, savedAt: 'yesterday' }];
  for (const value of invalid) {
    storage.setItem(key('practice'), JSON.stringify(value));
    assert.equal(restore(storage, 'practice'), null, JSON.stringify(value));
  }
  storage.setItem(key('practice'), '{broken');
  assert.equal(restore(storage, 'practice'), null);
  assert.equal(loadDraft(storage, 'practice'), null);
  assert.equal(loadDraft(storage, 'practice', null), null);
});

test('invalid save inputs are refused without overwriting a valid draft', () => {
  const storage = memoryStorage();
  saveDraft(storage, 'practice', draft());
  const saved = storage.getItem(key('practice'));
  for (const value of [null, undefined, {}, { ...draft(), selections: [null] }, draft(['same', 'same']),
    { ...draft(), mode: 'invalid' }, { ...draft(), stake: 0 }, { ...draft(), stake: 'x'.repeat(129) },
    draft(Array.from({ length: 21 }, (_, index) => String(index)))]) {
    assert.equal(saveDraft(storage, 'practice', value), false);
    assert.equal(storage.getItem(key('practice')), saved);
  }
  for (const scope of ['', null, 'x'.repeat(513), '\ud800']) {
    assert.equal(saveDraft(storage, scope, draft()), false);
    assert.equal(restore(storage, scope), null);
    assert.equal(clearDraft(storage, scope), false);
  }
});

test('unavailable storage and quota failures never interrupt the interface', () => {
  const denied = { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Quota'); }, removeItem() { throw new Error('Denied'); } };
  for (const storage of [undefined, null, {}, denied]) {
    assert.equal(saveDraft(storage, 'practice', draft()), false);
    assert.equal(restore(storage, 'practice'), null);
    assert.equal(clearDraft(storage, 'practice'), false);
  }
});
