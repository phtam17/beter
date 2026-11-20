import test from 'node:test';
import assert from 'node:assert/strict';
import { events, sports, marketNames, getSelection } from '../dist/markets.js';
import { americanToDecimal, placeBets, settleBet, getStats, resetState } from '../dist/engine.js';

test('every fixture offers six uniquely identifiable, valid practice selections', () => {
  const ids = new Set();
  assert.equal(events.length, 6);
  for (const event of events) {
    assert.ok(sports.includes(event.sport));
    assert.notEqual(event.away.name, event.home.name);
    assert.equal(event.markets.length, 3);
    for (let marketIndex = 0; marketIndex < 3; marketIndex++) {
      for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
        const pick = getSelection(event.id, marketIndex, sideIndex);
        assert.ok(!ids.has(pick.id), `Duplicate selection: ${pick.id}`);
        ids.add(pick.id);
        assert.equal(pick.eventId, event.id);
        assert.equal(pick.eventName, `${event.away.short} at ${event.home.short}`);
        assert.equal(pick.market, marketNames[marketIndex]);
        assert.ok(americanToDecimal(pick.odds) > 1);
        assert.match(pick.startsAt, /^Sample fixture, /);
      }
    }
  }
  assert.equal(ids.size, 36);
});

test('spread sides have opposite signed lines and the correct team and price', () => {
  for (const event of events) {
    const away = getSelection(event.id, 0, 0);
    const home = getSelection(event.id, 0, 1);
    assert.equal(Number(away.line), -Number(home.line));
    assert.equal(away.team, event.away.name);
    assert.equal(home.team, event.home.name);
    assert.equal(away.odds, event.markets[0][0][1]);
    assert.equal(home.odds, event.markets[0][1][1]);
    assert.match(Number(away.line) > 0 ? away.line : home.line, /^\+/);
  }
});

test('moneylines use the winner price rather than treating odds as a spread', () => {
  for (const event of events) {
    for (let side = 0; side < 2; side++) {
      const pick = getSelection(event.id, 1, side);
      assert.equal(pick.line, 'To win');
      assert.equal(pick.odds, event.markets[1][side][0]);
      assert.equal(pick.team, side === 0 ? event.away.name : event.home.name);
    }
  }
  assert.equal(getSelection('bos-ny', 1, 0).odds, -175);
  assert.equal(getSelection('bos-ny', 1, 1).odds, 150);
});

test('totals pair over and under at one shared threshold independently of teams', () => {
  for (const event of events) {
    const over = getSelection(event.id, 2, 0);
    const under = getSelection(event.id, 2, 1);
    assert.match(over.line, /^O \d+(?:\.\d+)?$/);
    assert.match(under.line, /^U \d+(?:\.\d+)?$/);
    assert.equal(over.line.slice(2), under.line.slice(2));
    assert.equal(over.team, `Total ${over.line}`);
    assert.equal(under.team, `Total ${under.line}`);
    assert.equal(over.odds, event.markets[2][0][1]);
    assert.equal(under.odds, event.markets[2][1][1]);
  }
});

test('all fixture selections can be placed and settled by the simulation engine', () => {
  for (const event of events) {
    const picks = Array.from({ length: 3 }, (_, market) => [getSelection(event.id, market, 0), getSelection(event.id, market, 1)]).flat();
    const placed = placeBets(resetState(), picks, 10);
    assert.equal(placed.bets.length, 6);
    assert.equal(placed.state.balance, 9940);
    let settled = placed.state;
    for (const bet of placed.bets) settled = settleBet(settled, bet.id, 'void');
    assert.equal(settled.balance, 10000);
    assert.equal(getStats(settled).totalProfit, 0);
  }
});

test('distinct fixture selections form a parlay and same-fixture choices are rejected', () => {
  const picks = events.map((event) => getSelection(event.id, 1, 0));
  const placed = placeBets(resetState(), picks, 25, 'parlay');
  assert.equal(placed.bets.length, 1);
  assert.equal(placed.bets[0].selections.length, events.length);
  assert.equal(placed.state.balance, 9975);
  assert.throws(() => placeBets(resetState(), [getSelection('bos-ny', 0, 0), getSelection('bos-ny', 1, 0)], 25, 'parlay'), /one selection per game/);
});

test('unknown fixtures and out-of-range market choices fail explicitly', () => {
  assert.throws(() => getSelection('missing', 0, 0), /unavailable/);
  for (const [market, side] of [[-1, 0], [3, 0], [0, -1], [0, 2], [1.5, 0], [0, 0.5]]) {
    assert.throws(() => getSelection('bos-ny', market, side), /unavailable/);
  }
});
