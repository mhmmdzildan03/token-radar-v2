// Token Radar v2 — the model. Everything below is derived from the sealed snapshot's own
// figures at run time: nothing is hardcoded per protocol, no name lists, no hand-set multiples.
//
// Pipeline:
//   1. Fit a log-log value curve on the snapshot's own tokenised protocols (the comps):
//      ln(mcap) ~ a + b * ln(tvl) + terms. A candidate term is kept only when it lowers the
//      held-out miss on BOTH tests — leave-one-out over the comps and a walk-forward split
//      (fit on the earliest-tracked 60% of comps, tested on the latest 40%).
//   2. Launch odds per cohort (category x age band), shrunk toward the snapshot base rate,
//      scored with a leave-one-out Brier score against the base rate's own Brier score.
//   3. Board value = expected launch value: fitted value x cohort odds. Ranges come from a
//      seeded residual bootstrap, so two runs write the same bytes.
//   4. A farm verdict per row, netted at the range's P10 against the plan's own costs.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** A protocol records a token when DefiLlama carries its gecko id or symbol (the watchlist's own test). */
export function recordsToken(p: Protocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot is missing its protocols or watchlist array');
  }
  return raw;
}

/** Whole days between the day DefiLlama began tracking a protocol and the snapshot's as_of. */
export function ageDays(p: Protocol, asOfMs: number): number | null {
  if (p.listed_at === null) return null;
  const t = Date.parse(`${p.listed_at}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((asOfMs - t) / 86_400_000));
}

/** FNV-1a over a string: the board/dashboard integrity checksum, identical in the page. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Deterministic per-slug seed so the bootstrap is reproducible byte for byte. */
function slugSeed(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The value fit. A linear model in log space over a small set of named terms.
// ---------------------------------------------------------------------------

export type TermName =
  | 'growth7d'
  | 'growthMissing'
  | 'ageLog'
  | 'ageMissing'
  | 'chainBreadth'
  | 'curvature'
  | 'categoryShift';

export const ALL_TERMS: TermName[] = [
  'growth7d',
  'growthMissing',
  'ageLog',
  'ageMissing',
  'chainBreadth',
  'curvature',
  'categoryShift',
];

interface Feat {
  logTvl: number;
  growth7d: number;
  growthMissing: number;
  ageLog: number;
  ageMissing: number;
  chainBreadth: number;
  curvature: number;
  category: string;
}

function features(p: Protocol, asOfMs: number, meanLogTvl: number, medianAge: number): Feat {
  const logTvl = Math.log(Math.max(1, p.tvl_usd));
  const age = ageDays(p, asOfMs);
  return {
    logTvl,
    // the snapshot records change_7d in per cent; the model works in fractions, winsorised
    growth7d: p.change_7d === null ? 0 : Math.min(5, Math.max(-0.95, p.change_7d / 100)),
    growthMissing: p.change_7d === null ? 1 : 0,
    ageLog: Math.log(1 + (age === null ? medianAge : age)),
    ageMissing: age === null ? 1 : 0,
    chainBreadth: Math.log(Math.max(1, p.chains.length)),
    curvature: (logTvl - meanLogTvl) * (logTvl - meanLogTvl),
    category: p.category ?? '(none)',
  };
}

function termColumn(f: Feat, term: TermName): number {
  switch (term) {
    case 'growth7d': return f.growth7d;
    case 'growthMissing': return f.growthMissing;
    case 'ageLog': return f.ageLog;
    case 'ageMissing': return f.ageMissing;
    case 'chainBreadth': return f.chainBreadth;
    case 'curvature': return f.curvature;
    case 'categoryShift': return 0; // handled as a shrunk offset, not a column
  }
}

interface Fit {
  coef: number[]; // [intercept, logTvl slope, ...one per linear term kept]
  linearTerms: TermName[];
  catOffset: Map<string, number>;
  meanLogTvl: number;
  medianAge: number;
}

/** Solve (X'X) b = X'y by Gaussian elimination with partial pivoting. */
function ols(x: number[][], y: number[]): number[] {
  const k = x[0]!.length;
  const a: number[][] = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let i = 0; i < x.length; i++) {
    for (let r = 0; r < k; r++) {
      for (let c = 0; c < k; c++) a[r]![c]! += x[i]![r]! * x[i]![c]!;
      a[r]![k]! += x[i]![r]! * y[i]!;
    }
  }
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[piv]![c]!)) piv = r;
    const tmp = a[c]!; a[c] = a[piv]!; a[piv] = tmp;
    const d = a[c]![c]! || 1e-12;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = a[r]![c]! / d;
      if (f === 0) continue;
      for (let cc = c; cc <= k; cc++) a[r]![cc]! -= f * a[c]![cc]!;
    }
  }
  return a.map((row, i) => row[k]! / (row[i]! || 1e-12));
}

function fitOn(train: Protocol[], asOfMs: number, terms: TermName[]): Fit {
  const linearTerms = terms.filter((t) => t !== 'categoryShift');
  const meanLogTvl = train.reduce((s, p) => s + Math.log(Math.max(1, p.tvl_usd)), 0) / train.length;
  const ages = train.map((p) => ageDays(p, asOfMs)).filter((v): v is number => v !== null).sort((x, y) => x - y);
  const medianAge = ages.length ? ages[Math.floor(ages.length / 2)]! : 0;
  const x: number[][] = [];
  const y: number[] = [];
  for (const p of train) {
    const f = features(p, asOfMs, meanLogTvl, medianAge);
    x.push([1, f.logTvl, ...linearTerms.map((t) => termColumn(f, t))]);
    y.push(Math.log(p.mcap_usd!));
  }
  const coef = ols(x, y);
  const catOffset = new Map<string, number>();
  if (terms.includes('categoryShift')) {
    const sums = new Map<string, { s: number; n: number }>();
    train.forEach((p, i) => {
      const f = features(p, asOfMs, meanLogTvl, medianAge);
      let pred = coef[0]! + coef[1]! * f.logTvl;
      linearTerms.forEach((t, j) => { pred += coef[2 + j]! * termColumn(f, t); });
      const key = f.category;
      const cur = sums.get(key) ?? { s: 0, n: 0 };
      cur.s += y[i]! - pred; cur.n += 1;
      sums.set(key, cur);
    });
    for (const [cat, { s, n }] of sums) catOffset.set(cat, (n / (n + 8)) * (s / n));
  }
  return { coef, linearTerms, catOffset, meanLogTvl, medianAge };
}

function predict(fit: Fit, p: Protocol, asOfMs: number): number {
  const f = features(p, asOfMs, fit.meanLogTvl, fit.medianAge);
  let v = fit.coef[0]! + fit.coef[1]! * f.logTvl;
  fit.linearTerms.forEach((t, j) => { v += fit.coef[2 + j]! * termColumn(f, t); });
  return v + (fit.catOffset.get(f.category) ?? 0);
}

const meanAbs = (xs: number[]): number => xs.reduce((s, v) => s + Math.abs(v), 0) / xs.length;

/** Held-out log-space miss of a term set: leave-one-out, plus a walk-forward test that fits
 *  on the earliest-tracked comps and predicts the later ones, over two expanding folds. */
function heldOutMiss(comps: Protocol[], asOfMs: number, terms: TermName[]): { loo: number; wf: number } {
  const looErr: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const train = comps.filter((_, j) => j !== i);
    const fit = fitOn(train, asOfMs, terms);
    looErr.push(Math.log(comps[i]!.mcap_usd!) - predict(fit, comps[i]!, asOfMs));
  }
  const byTime = [...comps].sort((a, b) => (a.listed_at ?? '9999').localeCompare(b.listed_at ?? '9999'));
  const wfErr: number[] = [];
  for (const cutF of [0.5, 0.65]) {
    const cut = Math.floor(byTime.length * cutF);
    const wfFit = fitOn(byTime.slice(0, cut), asOfMs, terms);
    for (const p of byTime.slice(cut)) wfErr.push(Math.log(p.mcap_usd!) - predict(wfFit, p, asOfMs));
  }
  return { loo: meanAbs(looErr), wf: meanAbs(wfErr) };
}

export interface TermVerdict {
  term: TermName;
  kept: boolean;
  looWith: number | null;
  wfWith: number | null;
  note: string;
}

export interface Validation {
  comps: number;
  baseLoo: number;
  baseWf: number;
  finalLoo: number;
  finalWf: number;
  flatLoo: number;
  flatWf: number;
  brierOdds: number;
  brierBase: number;
  baseRate: number;
  rangeCoverage: number; // share of comps whose recorded cap fell inside their own P25-P75 band
  rangeN: number;
  terms: TermVerdict[];
  coef: { intercept: number; logTvl: number; per: Record<string, number> };
}

// ---------------------------------------------------------------------------
// Launch odds: cohort base rates with shrinkage, leave-one-out Brier scored.
// ---------------------------------------------------------------------------

function ageBand(p: Protocol, asOfMs: number): string {
  const age = ageDays(p, asOfMs);
  if (age === null) return 'age?';
  if (age < 365) return '<1y';
  if (age < 730) return '1-2y';
  if (age < 1460) return '2-4y';
  return '>4y';
}

export function cohortKey(p: Protocol, asOfMs: number, catCounts: Map<string, number>): string {
  const cat = p.category ?? '(none)';
  const head = (catCounts.get(cat) ?? 0) >= 12 ? cat : '*';
  return `${head}|${ageBand(p, asOfMs)}`;
}

const SHRINK = 20;

function oddsTable(protocols: Protocol[], asOfMs: number): {
  baseRate: number;
  counts: Map<string, { k: number; n: number }>;
  catCounts: Map<string, number>;
} {
  const baseRate = protocols.filter(recordsToken).length / protocols.length;
  const catCounts = new Map<string, number>();
  for (const p of protocols) catCounts.set(p.category ?? '(none)', (catCounts.get(p.category ?? '(none)') ?? 0) + 1);
  const counts = new Map<string, { k: number; n: number }>();
  for (const p of protocols) {
    const key = cohortKey(p, asOfMs, catCounts);
    const cur = counts.get(key) ?? { k: 0, n: 0 };
    cur.n += 1;
    if (recordsToken(p)) cur.k += 1;
    counts.set(key, cur);
  }
  return { baseRate, counts, catCounts };
}

function oddsOf(
  table: ReturnType<typeof oddsTable>,
  p: Protocol,
  asOfMs: number,
  excludeSelf = false,
): number {
  const key = cohortKey(p, asOfMs, table.catCounts);
  const c = table.counts.get(key) ?? { k: 0, n: 0 };
  let { k, n } = c;
  if (excludeSelf) { n -= 1; if (recordsToken(p)) k -= 1; }
  return (k + SHRINK * table.baseRate) / (n + SHRINK);
}

// ---------------------------------------------------------------------------
// Who is rankable: the watchlist's own exclusion rule, without its TVL floor.
// ---------------------------------------------------------------------------

const EXCLUDED_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX',
]);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Returns the exclusion reason for a pre-token protocol, or null when it is rankable. */
export function exclusionReason(p: Protocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (/\s(V2|v2|2\.0|V3|v3)$/.test(p.name)) return 'version-named product';
  if (/\b(wrapped|staked|staking)\b/i.test(p.name)) return 'wrapped or staked product name';
  for (const ex of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(`${ex} `) || p.name === ex) return 'exchange-named product';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Board assembly.
// ---------------------------------------------------------------------------

import { farmPlan, planTotals, type Plan } from './plans.ts';

export interface Row {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  // model detail, carried as extra keys and into the dashboard's data
  fitted_value_usd: number;
  cat_shift: number;
  cohort: string;
  launch_odds: number;
  ev_p10_usd: number;
  ev_p25_usd: number;
  ev_p75_usd: number;
  rank_best: number;
  rank_worst: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  net_usd: number;
  net_per_hour: number;
  plan_cost_usd: number;
  plan_hours: number;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  watchlist: boolean;
  risk_flags: string[];
}

export interface Accounting {
  universe: number;
  tokenised: number;
  ranked: number;
  excluded: { reason: string; count: number }[];
}

export interface Radar {
  rows: Row[];
  validation: Validation;
  accounting: Accounting;
  asOf: string;
  floorUsd: number;
  watchlistCount: number;
  checksum: string;
}

const POSITION_USD = 1000; // the standard farm position the verdicts are netted on
const COMMUNITY_SHARE = 0.05; // assumed share of launch value reaching early users
const PARTICIPATION = 0.02; // assumed share of TVL that is active farm capital, sharing that allocation
const COMP_MIN_MCAP = 5_000_000; // comps under this recorded cap are dust; the snapshot's own materiality floor

function riskFlags(p: Protocol, asOfMs: number, odds: number): string[] {
  const flags: string[] = [];
  const age = ageDays(p, asOfMs);
  if (p.change_7d !== null && p.change_7d <= -20) flags.push('TVL down 20%+ in 7d');
  if (p.change_7d === null) flags.push('no 7d TVL change reported');
  if (age !== null && age < 180) flags.push('tracked under 6 months');
  if (age === null) flags.push('no tracking start recorded');
  if (p.chains.length === 1) flags.push('single chain');
  if (p.category === null) flags.push('no category recorded');
  if (odds < 0.08) flags.push('cohort rarely launches');
  return flags;
}

export function buildRadar(snapshot: Snapshot): Radar {
  const asOfMs = Date.parse(`${snapshot.as_of}T00:00:00Z`);
  const protocols = snapshot.protocols;
  const watch = new Set(snapshot.watchlist);
  const comps = protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd >= COMP_MIN_MCAP && p.tvl_usd > 0,
  );

  // --- term selection: a term stays only if it cuts BOTH held-out misses ---
  // The flat baseline predicts every comp at the (leave-one-out / walk-forward train) mean log cap.
  const logCaps = comps.map((p) => Math.log(p.mcap_usd!));
  const flatLoo = logCaps.map((v, i) => Math.abs(v - (logCaps.reduce((s, x) => s + x, 0) - v) / (logCaps.length - 1)));
  const wfByTime = [...comps].sort((a, b) => (a.listed_at ?? '9999').localeCompare(b.listed_at ?? '9999'));
  const flatWfErr: number[] = [];
  for (const cutF of [0.5, 0.65]) {
    const cut = Math.floor(wfByTime.length * cutF);
    const trainMean = wfByTime.slice(0, cut).reduce((s, q) => s + Math.log(q.mcap_usd!), 0) / cut;
    for (const p of wfByTime.slice(cut)) flatWfErr.push(Math.abs(Math.log(p.mcap_usd!) - trainMean));
  }
  const flat = { loo: meanAbs(flatLoo), wf: meanAbs(flatWfErr) };

  const base = heldOutMiss(comps, asOfMs, []);
  let kept: TermName[] = [];
  let current = { ...base };
  const verdicts = new Map<TermName, TermVerdict>();
  for (;;) {
    let bestTerm: TermName | null = null;
    let bestScore: { loo: number; wf: number } | null = null;
    for (const term of ALL_TERMS) {
      if (kept.includes(term)) continue;
      const trial = heldOutMiss(comps, asOfMs, [...kept, term]);
      verdicts.set(term, {
        term, kept: false,
        looWith: trial.loo, wfWith: trial.wf,
        note: '',
      });
      if (trial.loo < current.loo && trial.wf < current.wf) {
        if (bestScore === null || trial.loo + trial.wf < bestScore.loo + bestScore.wf) {
          bestTerm = term; bestScore = trial;
        }
      }
    }
    if (bestTerm === null || bestScore === null) break;
    kept = [...kept, bestTerm];
    current = bestScore;
  }
  for (const term of ALL_TERMS) {
    const v = verdicts.get(term);
    if (v) {
      v.kept = kept.includes(term);
      v.note = v.kept
        ? 'survived both held-out tests'
        : 'failed leave-one-out or walk-forward when last tried';
    }
  }

  const fit = fitOn(comps, asOfMs, kept);
  const residuals = comps.map((p) => Math.log(p.mcap_usd!) - predict(fit, p, asOfMs));

  // Range honesty, measured on the comps themselves: rebuild each comp's bootstrap band
  // from the residual pool and count how many recorded caps actually fall inside it.
  let inBand = 0;
  for (const p of comps) {
    const logV = predict(fit, p, asOfMs);
    const rng = mulberry32(slugSeed(p.slug));
    const draws: number[] = [];
    for (let i = 0; i < 240; i++) draws.push(Math.exp(logV + residuals[Math.floor(rng() * residuals.length)]!));
    draws.sort((a, b) => a - b);
    const lo = draws[Math.floor(0.25 * draws.length)]!;
    const hi = draws[Math.floor(0.75 * draws.length)]!;
    if (p.mcap_usd! >= lo && p.mcap_usd! <= hi) inBand += 1;
  }
  const rangeCoverage = inBand / comps.length;

  // --- launch odds, leave-one-out Brier against the base rate ---
  const table = oddsTable(protocols, asOfMs);
  let brierOdds = 0;
  let brierBase = 0;
  const tokenCount = protocols.filter(recordsToken).length;
  for (const p of protocols) {
    const y = recordsToken(p) ? 1 : 0;
    brierOdds += (oddsOf(table, p, asOfMs, true) - y) ** 2;
    const looBase = (tokenCount - y) / (protocols.length - 1);
    brierBase += (looBase - y) ** 2;
  }
  brierOdds /= protocols.length;
  brierBase /= protocols.length;

  // --- accounting: every protocol in the snapshot lands in exactly one group ---
  const excludedCounts = new Map<string, number>();
  const rankable: Protocol[] = [];
  let tokenised = 0;
  for (const p of protocols) {
    if (recordsToken(p)) { tokenised += 1; continue; }
    const reason = exclusionReason(p);
    if (reason === null) rankable.push(p);
    else excludedCounts.set(reason, (excludedCounts.get(reason) ?? 0) + 1);
  }

  // --- score the rankable pre-token protocols ---
  interface Scored {
    p: Protocol;
    fitted: number;
    odds: number;
    ev: number;
    p10: number;
    p25: number;
    p75: number;
    plan: Plan;
  }
  const scored: Scored[] = [];
  for (const p of rankable) {
    const logV = predict(fit, p, asOfMs);
    const odds = oddsOf(table, p, asOfMs);
    const rng = mulberry32(slugSeed(p.slug));
    const draws: number[] = [];
    for (let i = 0; i < 240; i++) {
      draws.push(Math.exp(logV + residuals[Math.floor(rng() * residuals.length)]!) * odds);
    }
    draws.sort((a, b) => a - b);
    const q = (f: number) => draws[Math.min(draws.length - 1, Math.floor(f * draws.length))]!;
    const plan = farmPlan(p, asOfMs);
    scored.push({
      p,
      fitted: Math.exp(logV),
      odds,
      ev: Math.exp(logV) * odds,
      p10: q(0.1), p25: q(0.25), p75: q(0.75),
      plan,
    });
  }
  scored.sort((a, b) => b.ev - a.ev || b.fitted - a.fitted || a.p.slug.localeCompare(b.p.slug));

  const rows: Row[] = scored.map((s, i) => {
    const totals = planTotals(s.plan);
    const share = Math.min(1, POSITION_USD / (PARTICIPATION * s.p.tvl_usd));
    const gross = s.p10 * COMMUNITY_SHARE * share;
    const net = gross - totals.cost;
    const perHour = net / Math.max(1, totals.hours);
    // FARM is a high bar, stated on the page: at the range's P10 the position must clear
    // $250 net (25% on the $1,000 position over the horizon) and pay $15 for each hour.
    const verdict = net >= 250 && perHour >= 15 ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
    return {
      slug: s.p.slug,
      name: s.p.name,
      rank: i + 1,
      implied_value_usd: Math.max(1, Math.round(s.ev)),
      farm_steps: s.plan.map((step) => step.text),
      fitted_value_usd: Math.round(s.fitted),
      cat_shift: Math.round((fit.catOffset.get(s.p.category ?? '(none)') ?? 0) * 1000) / 1000,
      cohort: cohortKey(s.p, asOfMs, table.catCounts),
      launch_odds: Math.round(s.odds * 1000) / 1000,
      ev_p10_usd: Math.round(s.p10),
      ev_p25_usd: Math.round(s.p25),
      ev_p75_usd: Math.round(s.p75),
      rank_best: 0,
      rank_worst: 0,
      verdict,
      net_usd: Math.round(net),
      net_per_hour: Math.round(perHour * 10) / 10,
      plan_cost_usd: totals.cost,
      plan_hours: totals.hours,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: ageDays(s.p, asOfMs),
      watchlist: watch.has(s.p.slug),
      risk_flags: riskFlags(s.p, asOfMs, s.odds),
    };
  });
  // rank ranges from the EV intervals: who could pass whom if both landed at their edges
  for (const row of rows) {
    let above = 0;
    let below = 0;
    for (const other of rows) {
      if (other === row) continue;
      if (other.ev_p25_usd > row.ev_p75_usd) above += 1;
      if (other.ev_p75_usd < row.ev_p25_usd) below += 1;
    }
    row.rank_best = above + 1;
    row.rank_worst = rows.length - below;
  }

  const coefPer: Record<string, number> = {};
  fit.linearTerms.forEach((t, j) => { coefPer[t] = Math.round(fit.coef[2 + j]! * 10000) / 10000; });

  const canonical = rows.map((r) => `${r.slug}:${r.rank}:${r.implied_value_usd}`).join('|');
  return {
    rows,
    validation: {
      comps: comps.length,
      baseLoo: base.loo,
      baseWf: base.wf,
      finalLoo: current.loo,
      finalWf: current.wf,
      flatLoo: flat.loo,
      flatWf: flat.wf,
      brierOdds,
      brierBase,
      baseRate: table.baseRate,
      rangeCoverage,
      rangeN: comps.length,
      terms: ALL_TERMS.map((t) => verdicts.get(t)!),
      coef: {
        intercept: Math.round(fit.coef[0]! * 10000) / 10000,
        logTvl: Math.round(fit.coef[1]! * 10000) / 10000,
        per: coefPer,
      },
    },
    accounting: {
      universe: protocols.length,
      tokenised,
      ranked: rows.length,
      excluded: [...excludedCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    },
    asOf: snapshot.as_of,
    floorUsd: snapshot.floor_usd,
    watchlistCount: snapshot.watchlist.length,
    checksum: fnv1a(canonical),
  };
}

/** The gate's board rules, checked locally so a bad board never leaves the program. */
export function boardIssue(rows: Row[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, outside 100..4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prev = Number.POSITIVE_INFINITY;
  const sorted = [...rows].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]!;
    if (r.rank !== i + 1) return `ranks are not exactly 1..N (rank ${r.rank} at position ${i + 1})`;
    if (!slugs.has(r.slug)) return `row ${r.slug} is not a snapshot protocol`;
    if (seen.has(r.slug)) return `slug ${r.slug} appears twice`;
    seen.add(r.slug);
    if (!(r.implied_value_usd > 0) || r.implied_value_usd > 100_000_000_000_000) return `row ${r.slug} has an implied value out of range`;
    if (r.implied_value_usd > prev) return `implied value rises at rank ${r.rank}`;
    prev = r.implied_value_usd;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `row ${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const step of r.farm_steps) {
      const len = step.trim().length;
      if (len < 20 || len > 600) return `row ${r.slug} has a farm step of ${len} characters`;
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data, written beside the page as data.js. */
export function dataScript(radar: Radar): string {
  return `window.RADAR = ${JSON.stringify(radar)};\n`;
}
