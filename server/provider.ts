/** Server-side sports-data adapters. Credentials never enter normalized records or errors. */
export type SportName = 'Basketball' | 'Football' | 'Hockey';
export type MarketName = 'Moneyline' | 'Spread' | 'Total';
export type SelectionSide = 'home' | 'away' | 'over' | 'under';
export interface PricedSelection {
  id: string;
  team: string;
  market: MarketName;
  line: number | null;
  side: SelectionSide;
  odds: number;
  bookmaker: string;
  provider_updated_at: string;
  fetched_at: string;
}
export interface SportsEvent {
  id: string;
  sport: SportName;
  league: string;
  home_team: string;
  away_team: string;
  starts_at: string;
  status: 'upcoming' | 'live' | 'final';
  provider_updated_at: string;
  fetched_at: string;
  selections: PricedSelection[];
}
export interface SportsResult {
  id: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  updated_at: string | null;
  evidence: Record<string, unknown>;
}
export interface OddsProvider {
  getEvents(sport?: string): Promise<SportsEvent[]>;
  getResults(sport?: string): Promise<SportsResult[]>;
}
type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
type JsonRecord = Record<string, any>;

const SPORTS: Record<string, { sport: SportName; league: string }> = {
  basketball_nba: { sport: 'Basketball', league: 'NBA' },
  americanfootball_nfl: { sport: 'Football', league: 'NFL' },
  icehockey_nhl: { sport: 'Hockey', league: 'NHL' },
};
const MAX_CLOCK_SKEW = 60_000;

export class ProviderError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  constructor(message: string, code = 'provider_unavailable', status = 503, retryable = true) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}
function invalid(): never {
  throw new ProviderError('The odds provider returned invalid data.', 'provider_invalid_data');
}
function sportInfo(sport: string) {
  if (!Object.hasOwn(SPORTS, sport)) throw new ProviderError('Choose a supported sport.', 'unsupported_sport', 400, false);
  return SPORTS[sport];
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 250;
}
function iso(value: unknown, now: Date, providerTime = false): string {
  if (typeof value !== 'string') invalid();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || (providerTime && timestamp > now.getTime() + MAX_CLOCK_SKEW)) invalid();
  return new Date(timestamp).toISOString();
}
function validPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) >= 100;
}
function validLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value * 2);
}
function normalizeEvent(raw: JsonRecord, sport: string, bookmaker: string, now: Date): SportsEvent {
  const info = sportInfo(sport);
  if (!raw || !text(raw.id) || !text(raw.home_team) || !text(raw.away_team) || raw.home_team === raw.away_team || !Array.isArray(raw.bookmakers)) invalid();
  if (raw.sport_key !== undefined && raw.sport_key !== sport) invalid();
  const startsAt = iso(raw.commence_time, now);
  const fetchedAt = now.toISOString();
  const reference = raw.bookmakers.find((book: JsonRecord) => book?.key === bookmaker);
  const selections: PricedSelection[] = [];
  if (reference) {
    const bookUpdated = iso(reference.last_update, now, true);
    if (!Array.isArray(reference.markets)) invalid();
    const seen = new Set<string>();
    for (const market of reference.markets) {
      if (!market || !['h2h', 'spreads', 'totals'].includes(market.key)) continue;
      if (seen.has(market.key)) invalid();
      seen.add(market.key);
      if (!Array.isArray(market.outcomes)) invalid();
      // Three-way markets require different tie rules and are deliberately excluded.
      if (market.outcomes.length !== 2) continue;
      const updated = market.last_update ? iso(market.last_update, now, true) : bookUpdated;
      const sides = new Set<string>();
      const marketSelections: PricedSelection[] = [];
      for (const outcome of market.outcomes) {
        if (!outcome || !validPrice(outcome.price)) invalid();
        let side: SelectionSide;
        let name: MarketName;
        let line: number | null = null;
        let team: string;
        if (market.key === 'totals') {
          if (!['Over', 'Under'].includes(outcome.name) || !validLine(outcome.point) || outcome.point < 0) invalid();
          side = outcome.name === 'Over' ? 'over' : 'under';
          name = 'Total'; line = outcome.point; team = `${outcome.name} ${line}`;
        } else {
          if (outcome.name !== raw.home_team && outcome.name !== raw.away_team) invalid();
          side = outcome.name === raw.home_team ? 'home' : 'away';
          team = outcome.name;
          name = market.key === 'h2h' ? 'Moneyline' : 'Spread';
          if (name === 'Spread') { if (!validLine(outcome.point)) invalid(); line = outcome.point; }
        }
        if (sides.has(side)) invalid();
        sides.add(side);
        marketSelections.push({
          id: [raw.id, bookmaker, market.key, side].map(encodeURIComponent).join(':'),
          team, market: name, side, line, odds: outcome.price, bookmaker,
          provider_updated_at: updated, fetched_at: fetchedAt,
        });
      }
      if (market.key === 'totals' && marketSelections[0].line !== marketSelections[1].line) invalid();
      if (market.key === 'spreads' && marketSelections[0].line! + marketSelections[1].line! !== 0) invalid();
      selections.push(...marketSelections);
    }
  }
  return {
    id: raw.id, ...info, home_team: raw.home_team, away_team: raw.away_team,
    starts_at: startsAt, status: Date.parse(startsAt) <= now.getTime() ? 'live' : 'upcoming',
    // A missing reference has no bettable prices; this timestamp describes that observation.
    provider_updated_at: selections.length ? selections.map(s => s.provider_updated_at).sort()[0] : fetchedAt,
    fetched_at: fetchedAt, selections,
  };
}
function normalizeResult(raw: JsonRecord, now: Date): SportsResult {
  if (!raw || !text(raw.id) || !text(raw.home_team) || !text(raw.away_team) || raw.home_team === raw.away_team || typeof raw.completed !== 'boolean') invalid();
  let homeScore: number | null = null;
  let awayScore: number | null = null;
  if (raw.scores !== null && raw.scores !== undefined) {
    if (!Array.isArray(raw.scores) || raw.scores.length !== 2) invalid();
    const names = new Set<string>();
    for (const score of raw.scores) {
      if (!score || ![raw.home_team, raw.away_team].includes(score.name) || names.has(score.name) || !/^\d+$/.test(String(score.score))) invalid();
      const value = Number(score.score);
      if (!Number.isSafeInteger(value)) invalid();
      names.add(score.name);
      if (score.name === raw.home_team) homeScore = value; else awayScore = value;
    }
  }
  const updatedAt = raw.last_update === null || raw.last_update === undefined ? null : iso(raw.last_update, now, true);
  if (raw.completed && (homeScore === null || awayScore === null || updatedAt === null)) invalid();
  return { id: raw.id, completed: raw.completed, home_team: raw.home_team, away_team: raw.away_team,
    home_score: homeScore, away_score: awayScore, updated_at: updatedAt,
    evidence: { id: raw.id, completed: raw.completed, home_team: raw.home_team, away_team: raw.away_team, scores: raw.scores ?? null, last_update: raw.last_update ?? null },
  };
}

export function createOddsProvider({ apiKey, bookmaker = 'draftkings', fetchImpl = fetch, now = () => new Date(), timeoutMs = 10_000 }: {
  apiKey: string;
  bookmaker?: string;
  fetchImpl?: Fetch;
  now?: () => Date;
  timeoutMs?: number;
}): OddsProvider {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new ProviderError('An odds provider key must be configured.', 'provider_configuration', 503, false);
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(bookmaker)) throw new ProviderError('Choose a valid reference bookmaker.', 'provider_configuration', 503, false);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ProviderError('The odds provider timeout must be positive.', 'provider_configuration', 503, false);
  async function request(sport: string, path: 'odds' | 'scores'): Promise<JsonRecord[]> {
    sportInfo(sport);
    const url = new URL(`https://api.the-odds-api.com/v4/sports/${sport}/${path}`);
    url.searchParams.set('apiKey', apiKey);
    if (path === 'odds') {
      url.searchParams.set('bookmakers', bookmaker);
      url.searchParams.set('markets', 'h2h,spreads,totals');
      url.searchParams.set('oddsFormat', 'american');
    } else url.searchParams.set('daysFrom', '3');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new ProviderError('The odds provider request timed out.', 'provider_timeout'));
      }, timeoutMs); });
      const response = await Promise.race([fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal }), timeout]);
      if (!response.ok) throw new ProviderError(response.status === 429 ? 'The odds provider is rate limited. Try again later.' : 'The odds provider is unavailable.', response.status === 429 ? 'provider_rate_limited' : 'provider_unavailable');
      const data: unknown = await Promise.race([response.json(), timeout]);
      if (!Array.isArray(data)) invalid();
      return data;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('The odds provider is unavailable or returned invalid data.');
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  return {
    async getEvents(sport = 'basketball_nba') { const records = await request(sport, 'odds'); return records.map(raw => normalizeEvent(raw, sport, bookmaker, now())); },
    async getResults(sport = 'basketball_nba') { const records = await request(sport, 'scores'); return records.map(raw => normalizeResult(raw, now())); },
  };
}

/** An explicitly synthetic feed for local development; it never calls a real bookmaker. */
export function createSampleProvider({ now = () => new Date() }: { now?: () => Date } = {}): OddsProvider {
  const starts = new Date(now().getTime() + 3_600_000);
  const finalAt = new Date(starts.getTime() + 3 * 3_600_000);
  const fixtures: Record<string, { id: string; home: string; away: string; homeScore: number; awayScore: number; total: number }> = {
    basketball_nba: { id: 'sample-nba-1', home: 'New York Knicks', away: 'Boston Celtics', homeScore: 108, awayScore: 104, total: 224.5 },
    americanfootball_nfl: { id: 'sample-nfl-1', home: 'Buffalo Bills', away: 'Kansas City Chiefs', homeScore: 24, awayScore: 21, total: 47.5 },
    icehockey_nhl: { id: 'sample-nhl-1', home: 'Boston Bruins', away: 'New York Rangers', homeScore: 3, awayScore: 2, total: 5.5 },
  };
  return {
    async getEvents(sport = 'basketball_nba') {
      sportInfo(sport); const fixture = fixtures[sport]; const clock = now();
      const markets = [
        { key: 'h2h', outcomes: [{ name: fixture.away, price: -175 }, { name: fixture.home, price: 150 }] },
        { key: 'spreads', outcomes: [{ name: fixture.away, price: -110, point: -4.5 }, { name: fixture.home, price: -110, point: 4.5 }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: -110, point: fixture.total }, { name: 'Under', price: -110, point: fixture.total }] },
      ];
      const normalized = normalizeEvent({ id: fixture.id, sport_key: sport, home_team: fixture.home, away_team: fixture.away, commence_time: starts.toISOString(), bookmakers: [{ key: 'sample', last_update: clock.toISOString(), markets }] }, sport, 'sample', clock);
      if (clock >= finalAt) normalized.status = 'final';
      return [normalized];
    },
    async getResults(sport = 'basketball_nba') {
      sportInfo(sport); const fixture = fixtures[sport]; const completed = now() >= finalAt;
      return [normalizeResult({ id: fixture.id, completed, home_team: fixture.home, away_team: fixture.away,
        scores: completed ? [{ name: fixture.home, score: String(fixture.homeScore) }, { name: fixture.away, score: String(fixture.awayScore) }] : null,
        last_update: completed ? finalAt.toISOString() : null,
      }, now())];
    },
  };
}
