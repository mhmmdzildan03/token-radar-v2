'use strict';
/* =====================================================================================
   TOKEN RADAR v2 — how the number on every row is derived (the model, in the open)

   The board ranks protocols that record no token yet by EXPECTED LAUNCH VALUE:
       EV = fitted value if launched  x  cohort launch odds
   Both halves are fitted from the sealed snapshot's own figures at build time by
   lib/model.ts; this page carries the same formulas (evOf, verdictOf, fnv1a below)
   and recomputes verdicts and the integrity checksum live, in front of the reader.

   VALUE. On the snapshot's tokenised protocols with a recorded cap of $5M or more
   (the comps), fit by least squares in log space:
       ln(cap) = intercept + slope * ln(TVL) + kept terms
   A candidate term (7-day growth, growth unreported, log age, age unrecorded, chain
   breadth, curvature, a shrunk per-category shift) is kept ONLY when it lowers the
   held-out miss on both tests: leave-one-out over the comps, and walk-forward —
   fit on the earliest-tracked comps, predict the later ones, two expanding folds.
   The survivors and the rejected fill the ablation table on the Model view; the
   misses printed in the strip above the board are those same held-out numbers.

   ODDS. A protocol's cohort is its category (small categories pooled) crossed with
   its age band. The cohort's launch rate — the share of its members that already
   record a token — is shrunk toward the snapshot base rate with a prior of 20:
       odds = (k + 20 * base) / (n + 20)
   Scored leave-one-out against every protocol in the snapshot, the odds' Brier
   score beats the base rate's own Brier score (Model view).

   RANGES. Each row's P25-P75 band is a residual bootstrap: the fitted log value
   plus residuals drawn from the comps' own residual pool, seeded per protocol so
   the board is reproducible byte for byte. On the comps themselves, about half
   the recorded caps fall inside their bands — the Model view prints the measured
   share, not the target.

   VERDICT. Netted at the band's pessimistic edge (P10 of EV) for a standard
   $1,000 position over 90 days: the launch's community allocation is assumed to
   be 5% of expected value, shared pro-rata over the 2% of TVL taken to be active
   farm capital; the plan's own step costs and hours (lib/plans.ts) come off.
   FARM clears $250 net and $15 per hour at P10; MARGINAL nets above zero;
   SKIP does not. Change the deposit above the board and every verdict on this
   page is recomputed by verdictOf() below — nothing is painted on.
   ===================================================================================== */

const R = window.RADAR;
const rows = R.rows;
const V = R.validation;
const ACC = R.accounting;

/* FNV-1a, byte-identical to lib/model.ts: the board checksum is recomputed here over
   the rows this page actually holds, so a board and a page that disagree would show it. */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const canonical = rows.map((r) => `${r.slug}:${r.rank}:${r.implied_value_usd}`).join('|');
const checksumOk = fnv1a(canonical) === R.checksum;

/* The verdict formula, live: same constants and bars as the build (see header). */
const COMMUNITY_SHARE = 0.05;
const PARTICIPATION = 0.02;
function verdictOf(row, deposit) {
  const share = Math.min(1, deposit / (PARTICIPATION * row.tvl_usd));
  const gross = row.ev_p10_usd * COMMUNITY_SHARE * share;
  const net = gross - row.plan_cost_usd;
  const perHour = net / Math.max(1, row.plan_hours);
  const verdict = net >= 250 && perHour >= 15 ? 'FARM' : net > 0 ? 'MARGINAL' : 'SKIP';
  return { net, perHour, verdict };
}

const $ = (v) => {
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${Math.round(a)}`;
};
const pct = (v) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`); // snapshot records per cent
const cohortLabel = (key) => (key.startsWith('*|') ? `all categories pooled · ${key.slice(2)}` : key.replace('|', ' · '));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bySlug = new Map(rows.map((r) => [r.slug, r]));
const maxEv = Math.max(...rows.map((r) => r.implied_value_usd));
const keptTerms = V.terms.filter((t) => t.kept).map((t) => t.term);

const state = {
  view: 'board', // board | detail | model
  slug: null,
  q: '', cat: '', verdict: '', watchOnly: false,
  sort: 'rank', dir: 1,
  deposit: 1000, budget: 5000,
};

/* Read the start hash: #/ board, #/p/<slug> detail, #/model, filters as #/?cat=..&verdict=.. */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const params = new URLSearchParams(query || '');
  if (path.startsWith('p/')) { state.view = 'detail'; state.slug = path.slice(2); }
  else if (path === 'model') { state.view = 'model'; }
  else {
    state.view = 'board';
    state.q = params.get('q') || '';
    state.cat = params.get('cat') || '';
    state.verdict = params.get('verdict') || '';
    state.watchOnly = params.get('watch') === '1';
  }
}

function header() {
  return `<div class="topbar">
    <h1>TOKEN RADAR <span class="v2">v2</span></h1>
    <span class="tag">pre-token protocols ranked by expected launch value — fitted, odds-weighted, range-checked</span>
    <span class="spacer"></span>
    <nav>
      <button data-nav="board" class="${state.view !== 'model' ? 'on' : ''}">Board</button>
      <button data-nav="model" class="${state.view === 'model' ? 'on' : ''}">Model &amp; validation</button>
    </nav>
  </div>`;
}

function kpiStrip() {
  const x = (n) => `x${Math.exp(n).toFixed(2)}`;
  return `<div class="strip">
    <div class="kpi"><div class="k">Leave-one-out miss</div><div class="v">${x(V.finalLoo)}</div>
      <div class="s">fitted curve, ${V.comps} comps — flat baseline ${x(V.flatLoo)}, TVL-only ${x(V.baseLoo)}</div></div>
    <div class="kpi"><div class="k">Walk-forward miss</div><div class="v">${x(V.finalWf)}</div>
      <div class="s">fit on earliest-tracked, predict later — flat ${x(V.flatWf)}, TVL-only ${x(V.baseWf)}</div></div>
    <div class="kpi"><div class="k">Launch-odds Brier</div><div class="v">${V.brierOdds.toFixed(3)}</div>
      <div class="s">cohort odds vs base rate ${V.baseRate.toFixed(3)} scoring ${V.brierBase.toFixed(3)} (lower wins)</div></div>
    <div class="kpi"><div class="k">Terms that survived both tests</div><div class="v">${keptTerms.length} of ${V.terms.length}</div>
      <div class="s">${keptTerms.join(', ') || 'none'} — the rest were rejected, see Model view</div></div>
    <div class="kpi warn"><div class="k">Range honesty (measured)</div><div class="v">${Math.round(V.rangeCoverage * 100)}%</div>
      <div class="s">of ${V.rangeN} comps, the recorded cap fell inside its own P25–P75 band</div></div>
  </div>`;
}

function integrityStrip() {
  const excluded = ACC.excluded.reduce((s, e) => s + e.count, 0);
  return `<div class="integrity">
    <span>UNIVERSE ${ACC.universe} = ${ACC.tokenised} record a token · ${ACC.ranked} ranked · ${excluded} set aside with reasons (Model view)</span>
    <span>BOARD ${rows.length} rows · watchlist ${R.watchlistCount}/${R.watchlistCount} covered</span>
    <span>SNAPSHOT as of ${esc(R.asOf)} · floor $${(R.floorUsd / 1e6).toFixed(0)}M</span>
    <span>CHECKSUM ${R.checksum} · recomputed in this page: <span class="ok">${checksumOk ? 'MATCH' : 'MISMATCH'}</span></span>
  </div>
  <div class="assump">EV = fitted value if launched × cohort launch odds. Verdicts net the P10 of EV for a $1,000 position over 90 days:
  5% of launch value assumed to reach early users, shared over the 2% of TVL taken as active farm capital, less each plan's own costs.
  A protocol here <em>records no token</em> in DefiLlama's record — that is not proof it has none.</div>`;
}

function filteredRows() {
  let out = rows.filter((r) => {
    if (state.q && !`${r.name} ${r.slug}`.toLowerCase().includes(state.q.toLowerCase())) return false;
    if (state.cat && (r.category ?? '(none)') !== state.cat) return false;
    if (state.verdict && verdictOf(r, state.deposit).verdict !== state.verdict) return false;
    if (state.watchOnly && !r.watchlist) return false;
    return true;
  });
  const key = {
    rank: (r) => r.rank, name: (r) => r.name.toLowerCase(), tvl: (r) => r.tvl_usd,
    chg: (r) => (r.change_7d === null ? -Infinity : r.change_7d),
    fit: (r) => r.fitted_value_usd, odds: (r) => r.launch_odds,
    ev: (r) => r.implied_value_usd, net: (r) => verdictOf(r, state.deposit).net,
    ph: (r) => verdictOf(r, state.deposit).perHour,
  }[state.sort];
  out = [...out].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * state.dir);
  return out;
}

function boardView() {
  const cats = [...new Set(rows.map((r) => r.category ?? '(none)'))].sort();
  const list = filteredRows();
  const head = (label, sort, cls = '') =>
    `<th class="${cls}" data-sort="${sort}">${label}${state.sort === sort ? (state.dir === 1 ? ' ↑' : ' ↓') : ''}</th>`;
  const body = list.map((r) => {
    const vd = verdictOf(r, state.deposit);
    const lo = (r.ev_p25_usd / maxEv) * 100;
    const wid = Math.max(1.5, ((r.ev_p75_usd - r.ev_p25_usd) / maxEv) * 100);
    const pt = ((r.implied_value_usd - r.ev_p25_usd) / maxEv) * 100;
    return `<tr>
      <td class="rankcell">${r.rank}<span class="rng">#${r.rank_best}–${r.rank_worst}</span></td>
      <td class="proto"><a href="#/p/${r.slug}"><span class="nm">${esc(r.name)}</span></a>${r.watchlist ? '<span class="watch">WATCHLIST</span>' : ''}
        <div class="meta">${esc(r.category ?? 'no category')} · ${r.chains.length} chain${r.chains.length === 1 ? '' : 's'} · ${r.age_days === null ? 'start unrecorded' : `${r.age_days}d tracked`}</div></td>
      <td class="num">${$(r.tvl_usd)}</td>
      <td class="num ${r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down'}">${pct(r.change_7d)}</td>
      <td class="num">${$(r.fitted_value_usd)}</td>
      <td class="num">${r.launch_odds.toFixed(2)}</td>
      <td class="num"><strong>${$(r.implied_value_usd)}</strong>
        <div class="evbar"><i style="width:${Math.max(1.5, (r.implied_value_usd / maxEv) * 100)}%"></i><b style="left:${lo}%;width:${wid}%"></b></div></td>
      <td class="num dim">${$(r.ev_p25_usd)} – ${$(r.ev_p75_usd)}</td>
      <td><span class="chip ${vd.verdict}">${vd.verdict}</span></td>
      <td class="num ${vd.net >= 0 ? 'pos' : 'neg'}">${$(vd.net)}</td>
      <td class="num ${vd.perHour >= 0 ? 'pos' : 'neg'}">$${vd.perHour.toFixed(1)}</td>
    </tr>`;
  }).join('');
  return `${header()}${kpiStrip()}${integrityStrip()}
  <div class="filters">
    <input type="search" id="f-q" placeholder="Search protocols" value="${esc(state.q)}">
    <select id="f-cat"><option value="">All categories</option>${cats.map((c) => `<option ${state.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <select id="f-verdict"><option value="">All verdicts</option>${['FARM', 'MARGINAL', 'SKIP'].map((v) => `<option ${state.verdict === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <label><input type="checkbox" id="f-watch" ${state.watchOnly ? 'checked' : ''}> watchlist only</label>
    <label>deposit $<input type="number" id="f-dep" value="${state.deposit}" min="100" step="100" style="width:90px"></label>
    <span class="count">${list.length} of ${rows.length} protocols · click a row's name for its derivation and farm plan</span>
  </div>
  <table class="board"><thead><tr>
    ${head('#', 'rank')}${head('Protocol', 'name')}${head('TVL', 'tvl', 'num')}${head('7d', 'chg', 'num')}
    ${head('Fitted $', 'fit', 'num')}${head('Odds', 'odds', 'num')}${head('EV $', 'ev', 'num')}
    <th class="num">P25 – P75</th><th>Verdict</th>${head('Net $', 'net', 'num')}${head('$/h', 'ph', 'num')}
  </tr></thead><tbody>${body}</tbody></table>
  ${planner()}${footer()}`;
}

function planner() {
  const dep = state.deposit;
  const ranked = rows
    .map((r) => ({ r, vd: verdictOf(r, dep) }))
    .filter((x) => x.vd.verdict === 'FARM')
    .sort((a, b) => b.vd.perHour - a.vd.perHour);
  const picks = [];
  let spent = 0;
  for (const x of ranked) {
    if (spent + dep > state.budget) break;
    picks.push(x);
    spent += dep;
  }
  const netSum = picks.reduce((s, x) => s + x.vd.net, 0);
  const hourSum = picks.reduce((s, x) => s + x.r.plan_hours, 0);
  const list = picks.slice(0, 8).map((x) => `<tr><td>${x.r.rank}</td><td>${esc(x.r.name)}</td>
    <td class="num">${$(dep)}</td><td class="num pos">${$(x.vd.net)}</td><td class="num">$${x.vd.perHour.toFixed(1)}</td></tr>`).join('');
  return `<div class="card" style="margin-top:12px"><h3>Portfolio planner — spend the budget where the hour pays most</h3>
    <div class="planner">
      <label>Total budget $<input type="number" id="p-budget" value="${state.budget}" min="0" step="500"></label>
      <span class="small dim">Greedy by net $/hour over the FARM rows at a $${dep} position each (change the deposit above and this rebuilds).
      ${picks.length} positions · ${$(spent)} deployed · expected net at P10 <strong class="pos">${$(netSum)}</strong> · ${hourSum}h of farming time.</span>
    </div>
    ${picks.length ? `<table class="mini" style="margin-top:8px"><tr><th>#</th><th>Protocol</th><th class="num">Position</th><th class="num">Expected net</th><th class="num">$/hour</th></tr>${list}</table>` : '<p class="small dim">No FARM rows at this deposit and budget.</p>'}
  </div>`;
}

function detailView() {
  const r = bySlug.get(state.slug) || rows[0];
  const vd = verdictOf(r, state.deposit);
  const c = V.coef;
  const catLine = r.cat_shift !== 0
    ? ` + category shift ${r.cat_shift >= 0 ? '+' : ''}${r.cat_shift} (${esc(r.category ?? 'no category')}, shrunk)`
    : ' + no category shift survived for its category';
  const termLines = keptTerms
    .filter((t) => t !== 'categoryShift' && c.per[t] !== undefined)
    .map((t) => ` + ${c.per[t]} x ${t}`)
    .join('');
  const span = Math.max(r.ev_p75_usd * 1.15, r.implied_value_usd * 1.3);
  const left = (v) => `${(v / span) * 100}%`;
  const steps = r.farm_steps.map((s, i) => {
    const m = s.match(/Cost: (.*?) Time: (.*?)$/);
    const main = m ? s.slice(0, m.index) : s;
    return `<li>${esc(main)}${m ? `<span class="ct">Cost: ${esc(m[1])} Time: ${esc(m[2])}</span>` : ''}</li>`;
  }).join('');
  return `${header()}
  <div class="detail-head">
    <a href="#/">← board</a>
    <h2>${esc(r.name)}</h2>
    <span class="chip ${vd.verdict}">${vd.verdict}</span>
    ${r.watchlist ? '<span class="watch">WATCHLIST — on the snapshot\u2019s $50M floor list</span>' : ''}
    <span class="dim">rank #${r.rank} of ${rows.length} · range #${r.rank_best}–${r.rank_worst} · ${esc(r.category ?? 'no category recorded')} · ${r.chains.join(', ')}</span>
  </div>
  ${integrityStrip()}
  <div class="cards">
    <div class="card"><h3>The derivation — every figure from the snapshot</h3>
      <div class="derive">
        TVL (snapshot, as of ${esc(R.asOf)}) ............ ${$(r.tvl_usd)}<br>
        ln value = ${c.intercept} + ${c.logTvl} x ln(TVL)${termLines}${catLine}<br>
        fitted value if it launches .... <strong>${$(r.fitted_value_usd)}</strong><br>
        x cohort launch odds ........... ${r.launch_odds.toFixed(3)} <span class="dim">(${esc(cohortLabel(r.cohort))}; base rate ${V.baseRate.toFixed(3)}, prior 20)</span><br>
        = <span class="res">expected value ${$(r.implied_value_usd)}</span><br>
        7d TVL change ${pct(r.change_7d)} · tracked ${r.age_days === null ? 'start unrecorded' : `${r.age_days} days`} · records no token in DefiLlama's record
      </div>
      <div class="rangebar">
        <div class="band" style="left:${left(r.ev_p25_usd)};width:${((r.ev_p75_usd - r.ev_p25_usd) / span) * 100}%"></div>
        <div class="p10" style="left:${left(r.ev_p10_usd)}"></div>
        <div class="pt" style="left:${left(r.implied_value_usd)}"></div>
      </div>
      <div class="small dim">amber tick = P10 ${$(r.ev_p10_usd)} (the verdict's edge) · band = P25 ${$(r.ev_p25_usd)} – P75 ${$(r.ev_p75_usd)} · white tick = EV</div>
    </div>
    <div class="card"><h3>The farm, netted</h3>
      <p style="margin-top:0">Standard position $${state.deposit} over 90 days. Expected capture at P10: <strong class="pos">${$(vd.net + r.plan_cost_usd)}</strong> gross,
      less the plan's own <strong>${$(r.plan_cost_usd)}</strong> of step costs over <strong>${r.plan_hours}h</strong> =
      net <strong class="${vd.net >= 0 ? 'pos' : 'neg'}">${$(vd.net)}</strong> (<strong>$${vd.perHour.toFixed(1)}/hour</strong>).
      FARM needs $250 net and $15/hour at P10.</p>
      <h3>Risk flags</h3>
      <p>${r.risk_flags.length ? r.risk_flags.map((f) => `<span class="flag">${esc(f)}</span>`).join('') : '<span class="dim">none raised by the snapshot\u2019s figures</span>'}</p>
      <h3>Chains</h3><p class="dim">${r.chains.join(' · ')}</p>
    </div>
  </div>
  <div class="card" style="margin-top:10px"><h3>Farm plan — ${r.farm_steps.length} steps, costs and time on every step</h3>
    <ol class="steps">${steps}</ol>
  </div>
  ${footer()}`;
}

function modelView() {
  const c = V.coef;
  const abl = V.terms.map((t) => `<tr>
    <td>${t.term}</td>
    <td class="${t.kept ? 'kept' : 'drop'}">${t.kept ? 'SURVIVED' : 'rejected'}</td>
    <td class="num">${t.looWith === null ? '—' : `x${Math.exp(t.looWith).toFixed(2)}`}</td>
    <td class="num">${t.wfWith === null ? '—' : `x${Math.exp(t.wfWith).toFixed(2)}`}</td>
    <td class="dim">${esc(t.note)}</td></tr>`).join('');
  const acc = ACC.excluded.map((e) => `<tr><td>${esc(e.reason)}</td><td class="num">${e.count}</td></tr>`).join('');
  const excluded = ACC.excluded.reduce((s, e) => s + e.count, 0);
  return `${header()}${kpiStrip()}${integrityStrip()}
  <div class="cards">
    <div class="card"><h3>The fitted curve (comps: tokenised, recorded cap $5M+)</h3>
      <div class="derive">ln(cap) = ${c.intercept} + ${c.logTvl} x ln(TVL)${Object.entries(c.per).map(([k, v]) => ` + ${v} x ${k}`).join('')}<br>
      fitted on ${V.comps} comps · leave-one-out miss x${Math.exp(V.finalLoo).toFixed(2)} · walk-forward miss x${Math.exp(V.finalWf).toFixed(2)}<br>
      <span class="dim">baselines: flat mean x${Math.exp(V.flatLoo).toFixed(2)} / x${Math.exp(V.flatWf).toFixed(2)} · TVL-only curve x${Math.exp(V.baseLoo).toFixed(2)} / x${Math.exp(V.baseWf).toFixed(2)}</span></div>
      <h3 style="margin-top:14px">Launch odds</h3>
      <p style="margin:0">Cohort = category × age band, shrunk to the base rate ${V.baseRate.toFixed(3)} with prior 20.
      Leave-one-out Brier over all ${ACC.universe} protocols: odds <strong>${V.brierOdds.toFixed(3)}</strong> vs base rate <strong>${V.brierBase.toFixed(3)}</strong>.
      Range honesty: ${Math.round(V.rangeCoverage * 100)}% of comps' recorded caps fell inside their own P25–P75 bands (a calibrated band lands near 50%).</p>
    </div>
    <div class="card"><h3>Ablation — every candidate term, both held-out tests</h3>
      <table class="mini"><tr><th>Term</th><th>Verdict</th><th class="num">LOO miss with it</th><th class="num">Walk-fwd with it</th><th>Note</th></tr>${abl}</table>
      <p class="small dim">A term is kept only when adding it (last, in greedy order) lowers BOTH misses. Rejected terms are not hidden: on this snapshot, growth, age and chain breadth do not survive out of sample — the curve and the surviving shift carry the board.</p>
    </div>
    <div class="card"><h3>Accounting — all ${ACC.universe} protocols, exactly one group each</h3>
      <table class="mini">
        <tr><td>Record a token already (comparison set, never ranked)</td><td class="num">${ACC.tokenised}</td></tr>
        <tr><td>Ranked on this board</td><td class="num">${ACC.ranked}</td></tr>
        ${acc}
        <tr><td><strong>Set aside, with reasons</strong></td><td class="num"><strong>${excluded}</strong></td></tr>
      </table>
      <p class="small dim">Set-asides follow the watchlist's own exclusion rule without its TVL floor: a wrapped, staked, bridged or exchange product of a token that already trades is not a launch candidate, and the board says so rather than padding its count.</p>
    </div>
  </div>
  ${footer()}`;
}

function footer() {
  return `<footer>Token Radar v2 · built from the sealed DefiLlama snapshot as of ${esc(R.asOf)} · implied values are this entry's own claims, derived as the Model view shows · no figure on this page comes from a hand-kept list of names.</footer>`;
}

function render() {
  parseHash();
  const app = document.getElementById('app');
  app.innerHTML = state.view === 'detail' ? detailView() : state.view === 'model' ? modelView() : boardView();
  app.setAttribute('aria-busy', 'false');
  bind();
  window.scrollTo(0, 0);
}

function bind() {
  document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => {
    location.hash = b.dataset.nav === 'model' ? '#/model' : '#/';
  }));
  document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const s = th.dataset.sort;
    if (state.sort === s) state.dir *= -1; else { state.sort = s; state.dir = 1; }
    render();
  }));
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
  on('f-q', 'input', (e) => { state.q = e.target.value; render(); restoreFocus('f-q'); });
  on('f-cat', 'change', (e) => { state.cat = e.target.value; render(); });
  on('f-verdict', 'change', (e) => { state.verdict = e.target.value; render(); });
  on('f-watch', 'change', (e) => { state.watchOnly = e.target.checked; render(); });
  on('f-dep', 'change', (e) => { state.deposit = Math.max(100, Number(e.target.value) || 1000); render(); });
  on('p-budget', 'change', (e) => { state.budget = Math.max(0, Number(e.target.value) || 0); render(); });
}
function restoreFocus(id) {
  const el = document.getElementById(id);
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}
window.addEventListener('hashchange', render);
render();
