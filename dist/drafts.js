// Drafts retain intent only. Prices and quotes always come from the current board.
const PREFIX = 'beter-slip-draft-v1:';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const validId = value => typeof value === 'string' && Boolean(value.trim()) && value.length <= 512;
const validStake = value => typeof value === 'string' && value.length <= 128;
const validMode = value => value === 'single' || value === 'parlay';
const storageKey = scope => validId(scope) ? PREFIX + encodeURIComponent(scope) : null;

export function clearDraft(storage, scope) {
  try {
    const key = storageKey(scope);
    if (!key) return false;
    storage.removeItem(key);
    return true;
  } catch { return false; }
}

export function saveDraft(storage, scope, draft = {}) {
  try {
    const { selections, mode, stake } = draft;
    const key = storageKey(scope);
    if (!key || !Array.isArray(selections)) return false;
    if (!selections.length) return clearDraft(storage, scope);
    const selectionIds = selections.map(selection => selection?.id);
    if (selectionIds.length > 20 || !selectionIds.every(validId) ||
        new Set(selectionIds).size !== selectionIds.length || !validMode(mode) || !validStake(stake)) return false;
    storage.setItem(key, JSON.stringify({ version: 1, selectionIds, mode, stake, savedAt: Date.now() }));
    return true;
  } catch { return false; }
}

export function loadDraft(storage, scope, options = {}) {
  try {
    const { resolveSelection, allowParlay = true, now = Date.now() } = options;
    const key = storageKey(scope);
    if (!key || typeof resolveSelection !== 'function' || !Number.isFinite(now)) return null;
    const saved = storage.getItem(key);
    if (!saved) return null;
    const draft = JSON.parse(saved);
    if (!draft || draft.version !== 1 || !Array.isArray(draft.selectionIds) ||
        !draft.selectionIds.length || draft.selectionIds.length > 20 || !draft.selectionIds.every(validId) ||
        new Set(draft.selectionIds).size !== draft.selectionIds.length || !validMode(draft.mode) ||
        !validStake(draft.stake) || !Number.isSafeInteger(draft.savedAt) || draft.savedAt < 0 ||
        now - draft.savedAt >= MAX_AGE) return null;
    const selections = [];
    for (const id of draft.selectionIds) {
      let selection;
      try { selection = resolveSelection(id); } catch { continue; }
      if (!selection || selection.id !== id || selection.disabled ||
          ['closed', 'suspended', 'settled', 'cancelled'].includes(selection.status)) continue;
      if (allowParlay || !selections.length) selections.push(selection);
    }
    return { selections, mode: allowParlay ? draft.mode : 'single', stake: draft.stake,
      removedCount: draft.selectionIds.length - selections.length };
  } catch { return null; }
}
