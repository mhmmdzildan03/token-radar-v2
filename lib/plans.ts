// Farm plans, written per category archetype. Every step names the protocol, its main chain
// and a concrete action, and carries the step's own cost and time, because the verdict in
// model.ts is netted against exactly these figures: planTotals() is the single source the
// dashboard's planner also recomputes from. Small per-protocol jitter (seeded by the slug)
// keeps two protocols of one archetype from reading as the same plan pasted twice.

import { ageDays, type Protocol } from './model.ts';

export interface PlanStep {
  text: string;
  cost: number; // whole US dollars the step is expected to cost in fees and gas
  hours: number; // hours of the farmer's own time, set-up plus tending over the horizon
}

export type Plan = PlanStep[];

export function planTotals(plan: Plan): { cost: number; hours: number } {
  return {
    cost: plan.reduce((s, step) => s + step.cost, 0),
    hours: plan.reduce((s, step) => s + step.hours, 0),
  };
}

function jitter(slug: string, salt: number, span: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % span;
}

export function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

interface Ctx {
  name: string;
  chain: string;
  chains: number;
  tvl: string;
  age: string;
  j: (salt: number, span: number) => number;
}

function ctx(p: Protocol, asOfMs: number): Ctx {
  const age = ageDays(p, asOfMs);
  return {
    name: p.name,
    chain: p.chains[0] ?? 'its main chain',
    chains: p.chains.length,
    tvl: fmtUsd(p.tvl_usd),
    age: age === null ? 'an unrecorded start' : age >= 730 ? `${Math.floor(age / 365)} years tracked` : `${age} days tracked`,
    j: (salt, span) => jitter(p.slug, salt, span),
  };
}

type StepFn = (c: Ctx) => PlanStep;

const openWallet: StepFn = (c) => ({
  text: `Set up a fresh wallet for ${c.name} and fund it on ${c.chain}; keep it separate from your main wallet so any points or eligibility snapshot reads cleanly. Cost: ~$${2 + c.j(1, 3)} in funding gas. Time: ~1h including the transfers.`,
  cost: 2 + c.j(1, 3),
  hours: 1,
});

const readDocs: StepFn = (c) => ({
  text: `Read ${c.name}'s docs and app end to end (${c.tvl} TVL, ${c.age}) and note every action it rewards: deposits, volume, referrals or governance. A protocol records no token yet, so activity now is the whole position. Cost: $0. Time: ~1h of reading.`,
  cost: 0,
  hours: 1,
});

const ARCHETYPES: Record<string, StepFn[]> = {
  dex: [
    openWallet,
    readDocs,
    (c) => ({
      text: `Make your first swaps on ${c.name} on ${c.chain}: trade the deepest pairs in sizes of $100-$500 so the volume looks like real use, not wash trading. Cost: ~$${6 + c.j(2, 6)} in swap fees and gas. Time: ~1h spread over the first week.`,
      cost: 6 + c.j(2, 6),
      hours: 1,
    }),
    (c) => ({
      text: `Add a small liquidity position on ${c.name}'s busiest pair and leave it in range; concentrated ranges earn the fees that most snapshots weight. Cost: ~$${3 + c.j(3, 4)} in gas to open and adjust. Time: ~2h including one rebalance.`,
      cost: 3 + c.j(3, 4),
      hours: 2,
    }),
    (c) => ({
      text: `Trade on ${c.name} every week for the 90-day horizon, varying pairs and sizes, and keep total volume growing with its ${c.tvl} TVL rather than front-loading it. Cost: ~$${10 + c.j(4, 10)} in fees over the horizon. Time: ~4h in short weekly sessions.`,
      cost: 10 + c.j(4, 10),
      hours: 4,
    }),
    (c) => ({
      text: `Join ${c.name}'s community channels and any trader leaderboard or quest it runs, and link the same wallet everywhere so the activity joins up. Cost: $0. Time: ~1h across the horizon.`,
      cost: 0,
      hours: 1,
    }),
  ],
  lending: [
    openWallet,
    readDocs,
    (c) => ({
      text: `Supply the standard position ($1,000 of a major stablecoin or ETH) to ${c.name} on ${c.chain} and leave it supplied; supplied balance over time is the record lenders are usually read from. Cost: ~$${2 + c.j(2, 4)} in approval and supply gas. Time: ~1h.`,
      cost: 2 + c.j(2, 4),
      hours: 1,
    }),
    (c) => ({
      text: `Borrow a small amount against the position on ${c.name} (under 40% of its borrow limit) and repay it, so the wallet shows both sides of the market. Cost: ~$${3 + c.j(3, 5)} in gas plus a few dollars of borrow interest. Time: ~1h.`,
      cost: 3 + c.j(3, 5),
      hours: 1,
    }),
    (c) => ({
      text: `Keep the position live for the full 90-day horizon, topping up after any large withdrawal elsewhere, and check its health factor weekly. Cost: ~$${2 + c.j(4, 3)} in tending gas. Time: ~3h of weekly checks.`,
      cost: 2 + c.j(4, 3),
      hours: 3,
    }),
    (c) => ({
      text: `Use ${c.name} on a second market it offers${c.chains > 1 ? ` (it runs on ${c.chains} chains)` : ''} with a smaller deposit, so the wallet is not a one-market record. Cost: ~$${3 + c.j(5, 4)} in gas. Time: ~1h.`,
      cost: 3 + c.j(5, 4),
      hours: 1,
    }),
  ],
  derivatives: [
    openWallet,
    readDocs,
    (c) => ({
      text: `Deposit the standard position ($1,000) as margin on ${c.name} on ${c.chain} and open a small first perpetual trade, then close it, to learn its fees and liquidation rules with real money. Cost: ~$${4 + c.j(2, 5)} in trading and gas fees. Time: ~2h.`,
      cost: 4 + c.j(2, 5),
      hours: 2,
    }),
    (c) => ({
      text: `Trade ${c.name} in short weekly sessions across the 90-day horizon, mixing market and limit orders and both directions, sized to its ${c.tvl} TVL so the volume reads as genuine. Cost: ~$${14 + c.j(3, 12)} in fees over the horizon. Time: ~6h total.`,
      cost: 14 + c.j(3, 12),
      hours: 6,
    }),
    (c) => ({
      text: `Provide liquidity or vault capital on ${c.name} if it offers a counterparty vault, alongside the trading, since vault depositors are a separate eligibility class. Cost: ~$${2 + c.j(4, 3)} in gas. Time: ~1h.`,
      cost: 2 + c.j(4, 3),
      hours: 1,
    }),
    (c) => ({
      text: `Keep a trade journal for ${c.name} (dates, sizes, fees) so you can prove sustained use if eligibility is ever reviewed manually. Cost: $0. Time: ~1h across the horizon.`,
      cost: 0,
      hours: 1,
    }),
  ],
  cdp: [
    openWallet,
    readDocs,
    (c) => ({
      text: `Open a vault on ${c.name} on ${c.chain} with the standard position ($1,000 of collateral) and mint its stablecoin at a conservative ratio, well above the liquidation line. Cost: ~$${3 + c.j(2, 4)} in gas. Time: ~1h.`,
      cost: 3 + c.j(2, 4),
      hours: 1,
    }),
    (c) => ({
      text: `Put the minted stablecoin to work in ${c.name}'s own ecosystem (its savings rate or a paired pool) rather than selling it, so both minting and holding read on the record. Cost: ~$${2 + c.j(3, 3)} in gas. Time: ~1h.`,
      cost: 2 + c.j(3, 3),
      hours: 1,
    }),
    (c) => ({
      text: `Hold the vault for the 90-day horizon and check its collateral ratio weekly against ${c.name}'s ${c.tvl} TVL market, topping up if the ratio drifts. Cost: ~$${2 + c.j(4, 3)} in tending gas. Time: ~3h of weekly checks.`,
      cost: 2 + c.j(4, 3),
      hours: 3,
    }),
    (c) => ({
      text: `Repay a slice of the debt and mint again once mid-horizon, so the wallet shows a full borrow-repay cycle rather than a single touch. Cost: ~$${2 + c.j(5, 3)} in gas. Time: ~1h.`,
      cost: 2 + c.j(5, 3),
      hours: 1,
    }),
  ],
  yield: [
    openWallet,
    readDocs,
    (c) => ({
      text: `Deposit the standard position ($1,000) into ${c.name}'s main vault or strategy on ${c.chain}; vault share balance over time is the record this archetype is read from. Cost: ~$${2 + c.j(2, 4)} in approval and deposit gas. Time: ~1h.`,
      cost: 2 + c.j(2, 4),
      hours: 1,
    }),
    (c) => ({
      text: `Split a second, smaller deposit into another ${c.name} strategy with a different risk profile, so the wallet is not riding a single vault. Cost: ~$${2 + c.j(3, 3)} in gas. Time: ~1h.`,
      cost: 2 + c.j(3, 3),
      hours: 1,
    }),
    (c) => ({
      text: `Hold both deposits for the 90-day horizon, compounding or re-staking rewards inside ${c.name} instead of withdrawing them, and review the positions weekly. Cost: ~$${3 + c.j(4, 4)} in tending gas. Time: ~3h of weekly reviews.`,
      cost: 3 + c.j(4, 4),
      hours: 3,
    }),
    (c) => ({
      text: `Vote or signal in ${c.name}'s governance or gauge system if it has one, using the same wallet, since allocator activity is often a separate multiplier. Cost: ~$${1 + c.j(5, 2)} in gas. Time: ~1h across the horizon.`,
      cost: 1 + c.j(5, 2),
      hours: 1,
    }),
  ],
  rwa: [
    openWallet,
    (c) => ({
      text: `Complete ${c.name}'s onboarding and any KYC or accreditation check it requires before depositing; for real-world-asset protocols the verified account, not the wallet alone, is the record. Cost: $0 unless it charges a verification fee. Time: ~2h including document upload.`,
      cost: 0,
      hours: 2,
    }),
    (c) => ({
      text: `Make the standard position ($1,000) into ${c.name}'s flagship asset on ${c.chain} once verified, and hold it rather than trading out. Cost: ~$${2 + c.j(2, 3)} in gas and platform fees. Time: ~1h.`,
      cost: 2 + c.j(2, 3),
      hours: 1,
    }),
    (c) => ({
      text: `Reinvest each yield payment from ${c.name} back into the same asset across the 90-day horizon, so the balance compounds on the record. Cost: ~$${2 + c.j(3, 3)} in gas. Time: ~2h across the payments.`,
      cost: 2 + c.j(3, 3),
      hours: 2,
    }),
    (c) => ({
      text: `Read ${c.name}'s asset reports as they publish (${c.tvl} TVL, ${c.age}) and keep the account active with logins and a small top-up mid-horizon. Cost: ~$${1 + c.j(4, 2)} in gas. Time: ~2h.`,
      cost: 1 + c.j(4, 2),
      hours: 2,
    }),
  ],
  launchpad: [
    openWallet,
    readDocs,
    (c) => ({
      text: `Register the wallet on ${c.name} and complete its participation profile or allowlist steps on ${c.chain} before any sale opens; launchpads read the registration date. Cost: ~$${1 + c.j(2, 3)} in gas. Time: ~1h.`,
      cost: 1 + c.j(2, 3),
      hours: 1,
    }),
    (c) => ({
      text: `Take part in the next ${c.name} sale or staking round with a modest ticket from the standard position, sized so a lock-up does not strand the whole $1,000. Cost: ~$${3 + c.j(3, 4)} in gas and fees. Time: ~2h around the sale window.`,
      cost: 3 + c.j(3, 4),
      hours: 2,
    }),
    (c) => ({
      text: `Stake or hold whatever ${c.name} asks participants to hold for tier weight, for the full 90-day horizon. Cost: ~$${2 + c.j(4, 3)} in gas. Time: ~2h of checks.`,
      cost: 2 + c.j(4, 3),
      hours: 2,
    }),
    (c) => ({
      text: `Join each later ${c.name} round in the horizon, even with small tickets, so the wallet shows repeat participation rather than one sale. Cost: ~$${3 + c.j(5, 4)} in gas and fees. Time: ~2h.`,
      cost: 3 + c.j(5, 4),
      hours: 2,
    }),
  ],
  chain: [
    openWallet,
    (c) => ({
      text: `Bridge a small amount to ${c.name}'s network and make it the wallet's home for this farm: pay gas, use its explorer and keep a balance there. Cost: ~$${4 + c.j(2, 5)} in bridge and gas fees. Time: ~1h.`,
      cost: 4 + c.j(2, 5),
      hours: 1,
    }),
    (c) => ({
      text: `Use two or three of ${c.name}'s native apps (a swap, a lend, a mint) in the first week so the wallet's on-chain history is varied, not a single contract. Cost: ~$${4 + c.j(3, 5)} in fees. Time: ~2h.`,
      cost: 4 + c.j(3, 5),
      hours: 2,
    }),
    (c) => ({
      text: `Stay active on ${c.name} weekly across the 90-day horizon with small real transactions; chain farms are read on active weeks and unique contracts. Cost: ~$${5 + c.j(4, 6)} in gas over the horizon. Time: ~4h in short sessions.`,
      cost: 5 + c.j(4, 6),
      hours: 4,
    }),
    (c) => ({
      text: `Run any faucet, testnet or quest programme ${c.name} operates alongside the mainnet activity, linked to the same wallet. Cost: $0. Time: ~1h across the horizon.`,
      cost: 0,
      hours: 1,
    }),
  ],
  generic: [
    openWallet,
    readDocs,
    (c) => ({
      text: `Make the standard position ($1,000) work on ${c.name} on ${c.chain} through its core action — the deposit, stake or trade its ${c.tvl} TVL is built from — and leave it in place. Cost: ~$${3 + c.j(2, 4)} in gas and fees. Time: ~1h.`,
      cost: 3 + c.j(2, 4),
      hours: 1,
    }),
    (c) => ({
      text: `Use a second feature of ${c.name} in the following weeks (a different market, vault or mode), so the record is not a single touch. Cost: ~$${3 + c.j(3, 4)} in gas and fees. Time: ~2h.`,
      cost: 3 + c.j(3, 4),
      hours: 2,
    }),
    (c) => ({
      text: `Return to ${c.name} weekly for the 90-day horizon with small genuine actions and keep the main position live throughout. Cost: ~$${4 + c.j(4, 5)} in gas and fees. Time: ~4h in short sessions.`,
      cost: 4 + c.j(4, 5),
      hours: 4,
    }),
    (c) => ({
      text: `Join ${c.name}'s community and any points, quest or referral programme it runs, always with the same wallet. Cost: $0. Time: ~1h across the horizon.`,
      cost: 0,
      hours: 1,
    }),
  ],
};

const CATEGORY_ARCHETYPE: Record<string, keyof typeof ARCHETYPES> = {
  Dexs: 'dex',
  Lending: 'lending',
  Derivatives: 'derivatives',
  CDP: 'cdp',
  Yield: 'yield',
  'Yield Aggregator': 'yield',
  Farm: 'yield',
  'Leveraged Farming': 'yield',
  'Onchain Capital Allocator': 'yield',
  'Risk Curators': 'yield',
  RWA: 'rwa',
  Launchpad: 'launchpad',
  Chain: 'chain',
};

export function farmPlan(p: Protocol, asOfMs: number): Plan {
  const key = (p.category !== null && CATEGORY_ARCHETYPE[p.category]) || 'generic';
  const steps = ARCHETYPES[key]!.map((fn) => fn(ctx(p, asOfMs)));
  return steps.map((s) => ({
    ...s,
    text: s.text.trim().slice(0, 600),
  }));
}
