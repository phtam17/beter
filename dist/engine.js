// Virtual-money simulation. Currency is exposed in dollars and calculated in cents.
const VERSION = 1;
const INITIAL_BANKROLL = 10000;
let idSequence = 0;

const money = (cents) => cents / 100;
const sumCents = (values) => values.reduce((sum, value) => sum + toCents(value), 0);
const identifier = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++idSequence}`}`;

function toCents(value, name = 'Amount') {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${name} must be a number.`);
  if (typeof value === 'string' && !value.trim()) throw new Error(`${name} must be a number.`);
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(cents)) throw new Error(`${name} is too large or invalid.`);
  if (Math.abs(amount * 100 - cents) > 0.000001) throw new Error(`${name} can have at most two decimal places.`);
  return cents;
}

export function americanToDecimal(odds) {
  const value = Number(odds);
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Math.abs(value) < 100) {
    throw new Error('Choose valid American odds of +100 or higher, or −100 or lower.');
  }
  return value > 0 ? 1 + value / 100 : 1 + 100 / Math.abs(value);
}

export function formatOdds(odds) {
  americanToDecimal(odds);
  const value = Number(odds);
  return value > 0 ? `+${value}` : String(value);
}

function validateSelections(selections, mode) {
  if (!['single', 'parlay'].includes(mode)) throw new Error('Choose single bets or a parlay.');
  if (!Array.isArray(selections) || selections.length === 0) throw new Error('Add a selection to your bet slip.');
  if (selections.length > 20) throw new Error('A bet slip can contain up to 20 selections.');
  const selectionIds = new Set();
  const eventIds = new Set();
  for (const selection of selections) {
    if (!selection || typeof selection.id !== 'string' || !selection.id.trim() ||
        typeof selection.eventId !== 'string' || !selection.eventId.trim() ||
        typeof selection.team !== 'string' || !selection.team.trim()) {
      throw new Error('A selection is missing its team or event. Choose it again.');
    }
    americanToDecimal(selection.odds);
    if (selectionIds.has(selection.id)) throw new Error('The same selection is already in your bet slip.');
    if (selection.disabled || ['closed', 'suspended', 'settled'].includes(selection.status)) {
      throw new Error('This market is unavailable. Choose another selection.');
    }
    if (mode === 'parlay' && eventIds.has(selection.eventId)) {
      throw new Error('Use one selection per game in a parlay.');
    }
    selectionIds.add(selection.id);
    eventIds.add(selection.eventId);
  }
  if (mode === 'parlay' && selections.length < 2) throw new Error('A parlay needs at least two games.');
}

function payoutCents(stakeCents, selections, mode) {
  // Keep exact ratios through multiplication so half-cent returns always round up.
  // Floating decimal odds can otherwise turn $101.505 into $101.50499999999998.
  const ratio = (selection) => {
    const odds = BigInt(Number(selection.odds));
    return odds > 0n ? [odds + 100n, 100n] : [-odds + 100n, -odds];
  };
  const roundedReturn = (group) => {
    const [numerator, denominator] = group.reduce(([numerator, denominator], selection) => {
      const [oddsNumerator, oddsDenominator] = ratio(selection);
      return [numerator * oddsNumerator, denominator * oddsDenominator];
    }, [BigInt(stakeCents), 1n]);
    return (2n * numerator + denominator) / (2n * denominator);
  };
  const result = mode === 'parlay'
    ? roundedReturn(selections)
    : selections.reduce((total, selection) => total + roundedReturn([selection]), 0n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The potential return is too large. Reduce your bet.');
  return Number(result);
}

export function potentialPayout(stake, selections, mode = 'single') {
  const stakeCents = toCents(stake, 'Stake');
  if (stakeCents <= 0) throw new Error('Enter a stake greater than $0.');
  validateSelections(selections, mode);
  return money(payoutCents(stakeCents, selections, mode));
}

export function resetState() {
  const at = new Date().toISOString();
  return {
    version: VERSION,
    initialBankroll: INITIAL_BANKROLL,
    balance: INITIAL_BANKROLL,
    bets: [],
    ledger: [{ id: identifier('ledger'), type: 'deposit', amount: INITIAL_BANKROLL, balance: INITIAL_BANKROLL, bankroll: INITIAL_BANKROLL, at, date: at, createdAt: at }],
  };
}

export function placeBets(state, selections, stake, mode = 'single') {
  const stakeCents = toCents(stake, 'Stake');
  if (stakeCents <= 0) throw new Error('Enter a stake greater than $0.');
  validateSelections(selections, mode);
  const totalStake = stakeCents * (mode === 'parlay' ? 1 : selections.length);
  if (!Number.isSafeInteger(totalStake)) throw new Error('The total stake is too large.');
  const balanceCents = toCents(state.balance, 'Balance');
  if (totalStake > balanceCents) throw new Error('Your stake exceeds your available virtual balance.');
  const at = new Date().toISOString();
  const groups = mode === 'parlay' ? [selections] : selections.map((selection) => [selection]);
  const bets = groups.map((group) => ({
    id: identifier('bet'),
    selections: group.map((selection) => ({ ...selection })),
    type: mode,
    mode,
    stake: money(stakeCents),
    odds: group.reduce((decimal, selection) => decimal * americanToDecimal(selection.odds), 1),
    potentialPayout: money(payoutCents(stakeCents, group, mode)),
    status: 'open',
    createdAt: at,
    settledAt: null,
    payout: 0,
  }));
  const balance = money(balanceCents - totalStake);
  const allBets = [...state.bets, ...bets];
  const amountAtRisk = sumCents(allBets.filter((bet) => bet.status === 'open').map((bet) => bet.stake));
  return {
    bets,
    state: {
      ...state,
      balance,
      bets: allBets,
      ledger: [...state.ledger, { id: identifier('ledger'), type: 'stake', amount: -money(totalStake), balance, bankroll: money(balanceCents - totalStake + amountAtRisk), betIds: bets.map((bet) => bet.id), at, date: at, createdAt: at }],
    },
  };
}

export function settleBet(state, betId, outcome) {
  if (!['won', 'lost', 'void'].includes(outcome)) throw new Error('Choose won, lost, or void.');
  const bet = state.bets.find((candidate) => candidate.id === betId);
  if (!bet) throw new Error('This bet could not be found.');
  if (bet.status !== 'open') throw new Error('This bet has already been settled.');
  const payout = outcome === 'won' ? bet.potentialPayout : outcome === 'void' ? bet.stake : 0;
  const balanceCents = toCents(state.balance) + toCents(payout);
  if (!Number.isSafeInteger(balanceCents)) throw new Error('The resulting balance is too large.');
  const balance = money(balanceCents);
  const at = new Date().toISOString();
  const settled = { ...bet, status: outcome, payout, settledAt: at };
  const bets = state.bets.map((candidate) => candidate.id === betId ? settled : candidate);
  const amountAtRisk = sumCents(bets.filter((candidate) => candidate.status === 'open').map((candidate) => candidate.stake));
  return {
    ...state,
    balance,
    bets,
    ledger: [...state.ledger, { id: identifier('ledger'), type: outcome, amount: payout, balance, bankroll: money(toCents(balance) + amountAtRisk), betId, at, date: at, createdAt: at }],
  };
}

export function getStats(state) {
  if(state.accountSummary)return {...state.accountSummary};
  const open = state.bets.filter((bet) => bet.status === 'open');
  const decided = state.bets.filter((bet) => bet.status === 'won' || bet.status === 'lost');
  const settled = state.bets.filter((bet) => bet.status !== 'open');
  const amountAtRiskCents = sumCents(open.map((bet) => bet.stake));
  const bankrollCents = toCents(state.balance) + amountAtRiskCents;
  const profitCents = bankrollCents - toCents(state.initialBankroll);
  const settledStakedCents = sumCents(decided.map((bet) => bet.stake));
  return {
    bankroll: money(bankrollCents),
    totalProfit: money(profitCents),
    roi: settledStakedCents ? profitCents / settledStakedCents * 100 : 0,
    winRate: decided.length ? decided.filter((bet) => bet.status === 'won').length / decided.length * 100 : 0,
    totalBets: state.bets.length,
    openBets: open.length,
    amountAtRisk: money(amountAtRiskCents),
    totalStaked: money(sumCents(state.bets.map((bet) => bet.stake))),
    settledBets: settled.length,
  };
}

export function createInitialState() {
  // Illustrative, reproducible demo history; these are not real event results.
  const history = [
    ['Boston Celtics', 'New York Knicks', 'NBA', 200, 150, 'won'],
    ['Dallas Cowboys', 'Philadelphia Eagles', 'NFL', 100, -110, 'lost'],
    ['Golden State Warriors', 'LA Lakers', 'NBA', 250, 120, 'won'],
    ['New York Rangers', 'Boston Bruins', 'NHL', 150, -115, 'lost'],
    ['Kansas City Chiefs', 'Buffalo Bills', 'NFL', 300, 100, 'won'],
    ['Denver Nuggets', 'Phoenix Suns', 'NBA', 200, 125, 'won'],
    ['Toronto Maple Leafs', 'Montreal Canadiens', 'NHL', 100, -120, 'lost'],
    ['LA Lakers', 'Chicago Bulls', 'NBA', 300, 150, 'won'],
  ];
  const initialAt = '2026-11-11T16:00:00.000Z';
  let balanceCents = INITIAL_BANKROLL * 100;
  const ledger = [{ id: 'demo-ledger-0', type: 'deposit', amount: INITIAL_BANKROLL, balance: INITIAL_BANKROLL, bankroll: INITIAL_BANKROLL, at: initialAt, date: initialAt, createdAt: initialAt }];
  const bets = history.map(([team, opponent, sport, stake, odds, status], index) => {
    const day = String(12 + index).padStart(2, '0');
    const createdAt = `2026-11-${day}T16:00:00.000Z`;
    const settledAt = `2026-11-${day}T20:00:00.000Z`;
    const selection = { id: `demo-selection-${index}`, eventId: `demo-event-${index}`, eventName: `${team} vs ${opponent}`, team, market: 'Moneyline', line: null, odds, sport, startsAt: createdAt };
    const potentialReturn = potentialPayout(stake, [selection]);
    const payout = status === 'won' ? potentialReturn : 0;
    balanceCents += toCents(payout) - toCents(stake);
    const id = `demo-bet-${index}`;
    ledger.push({ id: `demo-ledger-${index + 1}`, type: status, amount: money(toCents(payout) - toCents(stake)), balance: money(balanceCents), bankroll: money(balanceCents), betId: id, at: settledAt, date: settledAt, createdAt: settledAt });
    return { id, selections: [selection], type: 'single', mode: 'single', stake, odds: americanToDecimal(odds), potentialPayout: potentialReturn, status, createdAt, settledAt, payout };
  });
  return { version: VERSION, initialBankroll: INITIAL_BANKROLL, balance: money(balanceCents), bets, ledger };
}
