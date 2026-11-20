import test from 'node:test';
import assert from 'node:assert/strict';
import { americanToDecimal, formatOdds, potentialPayout, createInitialState, placeBets, settleBet, resetState, getStats } from '../dist/engine.js';

const selection = (overrides = {}) => ({ id: 'pick-a', eventId: 'game-a', eventName: 'Boston vs New York', team: 'Boston', market: 'Moneyline', odds: -110, sport: 'NBA', ...overrides });

test('American odds convert in both directions and reject invalid inputs', () => {
  assert.equal(americanToDecimal(150), 2.5);
  assert.equal(americanToDecimal(-200), 1.5);
  assert.equal(formatOdds(150), '+150');
  assert.equal(formatOdds(-110), '-110');
  for (const odds of [0, 90, -99, Infinity, NaN, 'no', 110.1]) assert.throws(() => americanToDecimal(odds));
});

test('single payout includes returned stake and rounds at cents', () => {
  assert.equal(potentialPayout(100, [selection()]), 190.91);
  assert.equal(potentialPayout(0.1, [selection({ odds: 150 })]), 0.25);
  assert.equal(potentialPayout(100, [selection(), selection({ id: 'pick-b', eventId: 'game-b', odds: 150 })]), 440.91);
});

test('half-cent payout boundaries round up without floating point underpayment', () => {
  assert.equal(potentialPayout(50.5, [selection({ odds: 101 })]), 101.51);
  assert.equal(potentialPayout(0.01, [selection({ odds: -200 })]), 0.02);
  assert.equal(potentialPayout(0.5, [selection({ odds: 110 }), selection({ id: 'pick-b', eventId: 'game-b', odds: 110 })], 'parlay'), 2.21);
  const placed = placeBets(resetState(), [selection({ odds: 101 })], 50.5);
  assert.equal(settleBet(placed.state, placed.bets[0].id, 'won').balance, 10051.01);
});

test('unrepresentable odds and excessive parlay returns fail safely', () => {
  assert.throws(() => americanToDecimal(Number.MAX_SAFE_INTEGER + 1));
  const picks = Array.from({ length: 20 }, (_, index) => selection({ id: `pick-${index}`, eventId: `game-${index}`, odds: 10000 }));
  assert.throws(() => potentialPayout(100, picks, 'parlay'), /too large/);
  assert.throws(() => placeBets(resetState(), picks, 100, 'parlay'), /too large/);
});

test('parlay multiplies decimal odds for one stake', () => {
  const picks = [selection({ odds: 100 }), selection({ id: 'pick-b', eventId: 'game-b', odds: 150 })];
  assert.equal(potentialPayout(100, picks, 'parlay'), 500);
  const result = placeBets(resetState(), picks, 100, 'parlay');
  assert.equal(result.state.balance, 9900);
  assert.equal(result.bets.length, 1);
  assert.equal(result.bets[0].potentialPayout, 500);
});

test('singles stake is per pick and original state is unchanged', () => {
  const state = resetState();
  const picks = [selection(), selection({ id: 'pick-b', eventId: 'game-b' })];
  const result = placeBets(state, picks, 100);
  assert.equal(result.state.balance, 9800);
  assert.equal(result.bets.length, 2);
  assert.equal(state.balance, 10000);
  assert.deepEqual(state.bets, []);
  picks[0].team = 'Changed';
  assert.equal(result.bets[0].selections[0].team, 'Boston');
});

test('invalid, zero, negative and sub-cent stakes are rejected', () => {
  for (const stake of [0, -1, 1.001, '', null, NaN, Infinity, 'oops']) {
    assert.throws(() => placeBets(resetState(), [selection()], stake));
  }
});

test('insufficient balance considers all singles, and exact balance can be staked', () => {
  const state = resetState();
  assert.throws(() => placeBets(state, [selection(), selection({ id: 'pick-b', eventId: 'game-b' })], 6000), /exceeds/);
  assert.equal(placeBets(state, [selection()], 10000).state.balance, 0);
});

test('empty, duplicate, unavailable and malformed selections are rejected', () => {
  assert.throws(() => placeBets(resetState(), [], 100));
  assert.throws(() => placeBets(resetState(), [selection(), selection()], 100), /same selection/);
  assert.throws(() => placeBets(resetState(), [selection({ status: 'closed' })], 100), /unavailable/);
  assert.throws(() => placeBets(resetState(), [selection({ eventId: '' })], 100));
});

test('parlays require at least two distinct events', () => {
  assert.throws(() => placeBets(resetState(), [selection()], 100, 'parlay'), /two games/);
  assert.throws(() => placeBets(resetState(), [selection(), selection({ id: 'pick-b', team: 'New York' })], 100, 'parlay'), /one selection per game/);
});

test('winning settlement credits stake and winnings once', () => {
  const { state, bets } = placeBets(resetState(), [selection({ odds: 150 })], 100);
  const settled = settleBet(state, bets[0].id, 'won');
  assert.equal(settled.balance, 10150);
  assert.equal(settled.bets[0].payout, 250);
  assert.equal(state.bets[0].status, 'open');
  assert.throws(() => settleBet(settled, bets[0].id, 'won'), /already/);
});

test('loss credits nothing and void refunds the stake', () => {
  const { state, bets } = placeBets(resetState(), [selection()], 123.45);
  assert.equal(settleBet(state, bets[0].id, 'lost').balance, 9876.55);
  assert.equal(settleBet(state, bets[0].id, 'void').balance, 10000);
  assert.throws(() => settleBet(state, 'missing-id', 'won'), /not be found/);
  assert.throws(() => settleBet(state, bets[0].id, 'unknown'));
});

test('bankroll includes pending stakes and excludes them from profit', () => {
  const { state } = placeBets(resetState(), [selection()], 100);
  assert.deepEqual(getStats(state), { bankroll: 10000, totalProfit: 0, roi: 0, winRate: 0, totalBets: 1, openBets: 1, amountAtRisk: 100, totalStaked: 100, settledBets: 0 });
  assert.equal(state.ledger.at(-1).bankroll, 10000);
});

test('demo history reconciles to its balance and has no pending bets', () => {
  const state = createInitialState();
  assert.equal(state.balance, 11250);
  assert.equal(state.bets.length, 8);
  assert.equal(state.bets.reduce((sum, bet) => sum + bet.payout - bet.stake, 0), 1250);
  assert.equal(state.ledger.at(-1).balance, state.balance);
  assert.equal(getStats(state).totalProfit, 1250);
  assert.equal(getStats(state).openBets, 0);
  assert.equal(getStats(state).winRate, 62.5);
  state.bets[0].status = 'changed';
  assert.equal(createInitialState().bets[0].status, 'won');
});

test('successive fractional stakes do not accumulate floating point drift', () => {
  let state = resetState();
  for (let index = 0; index < 25; index++) state = placeBets(state, [selection()], 0.1).state;
  assert.equal(state.balance, 9997.5);
  assert.equal(getStats(state).amountAtRisk, 2.5);
  assert.equal(getStats(state).bankroll, 10000);
});

test('voids do not count as wins or losses', () => {
  const placed = placeBets(resetState(), [selection()], 100);
  const state = settleBet(placed.state, placed.bets[0].id, 'void');
  assert.equal(getStats(state).winRate, 0);
  assert.equal(getStats(state).roi, 0);
  assert.equal(getStats(state).totalProfit, 0);
});
