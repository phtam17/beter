import type { PricedSelection, SportsEvent, SportsResult } from './provider.ts';

export type GradedOutcome = { selection_id: string; status: 'won' | 'lost' | 'void' };
type GradingSelection = Pick<PricedSelection, 'id' | 'market' | 'side' | 'line' | 'team'>;
type GradingEvent = Pick<SportsEvent, 'id' | 'home_team' | 'away_team'>;
type GradingResult = Pick<SportsResult, 'id' | 'completed' | 'home_team' | 'away_team' | 'home_score' | 'away_score' | 'updated_at'>;

function validateFinal(result: GradingResult): asserts result is GradingResult & { home_score: number; away_score: number } {
  if (!result || result.completed !== true) throw new Error('A confirmed final result is required.');
  if (!result.id || !result.home_team || !result.away_team || result.home_team === result.away_team ||
    !Number.isSafeInteger(result.home_score) || Number(result.home_score) < 0 ||
    !Number.isSafeInteger(result.away_score) || Number(result.away_score) < 0 || !result.updated_at || !Number.isFinite(Date.parse(result.updated_at))) {
    throw new Error('The final score evidence is invalid.');
  }
}

/** Full-game markets use the provider's final totals, including overtime/shootout accounting. */
export function gradeSelections(event: GradingEvent, selections: GradingSelection[], result: GradingResult): GradedOutcome[] {
  validateFinal(result);
  if (!event || event.id !== result.id || event.home_team !== result.home_team || event.away_team !== result.away_team) throw new Error('The final result does not match this event.');
  if (!Array.isArray(selections) || !selections.length) throw new Error('At least one selection is required.');
  const seen = new Set<string>();
  return selections.map(selection => {
    if (!selection || typeof selection.id !== 'string' || !selection.id || seen.has(selection.id)) throw new Error('The selection is invalid or duplicated.');
    seen.add(selection.id);
    let margin: number;
    if (selection.market === 'Moneyline' || selection.market === 'Spread') {
      if (!['home', 'away'].includes(selection.side)) throw new Error('The selection side is invalid for this market.');
      const home = selection.side === 'home';
      if (selection.team !== (home ? event.home_team : event.away_team)) throw new Error('The selection team does not match the event.');
      margin = home ? result.home_score - result.away_score : result.away_score - result.home_score;
      if (selection.market === 'Spread') {
        if (typeof selection.line !== 'number' || !Number.isSafeInteger(selection.line * 2)) throw new Error('The spread line is invalid.');
        margin += selection.line;
      } else if (selection.line !== null && selection.line !== undefined) throw new Error('A moneyline selection cannot include a line.');
    } else if (selection.market === 'Total') {
      if (!['over', 'under'].includes(selection.side) || typeof selection.line !== 'number' || !Number.isSafeInteger(selection.line * 2) || selection.line < 0) throw new Error('The total selection or line is invalid.');
      margin = result.home_score + result.away_score - selection.line;
      if (selection.side === 'under') margin *= -1;
    } else throw new Error('This market is not supported for automatic grading.');
    return { selection_id: selection.id, status: margin === 0 ? 'void' : margin > 0 ? 'won' : 'lost' };
  });
}

/** Canonical, stable evidence identity; corrected scores/timestamps produce a new revision. */
export function resultVersion(result: GradingResult): string {
  validateFinal(result);
  return `v1:${JSON.stringify([result.id, result.home_team, result.away_team, result.home_score, result.away_score, new Date(result.updated_at!).toISOString()])}`;
}
