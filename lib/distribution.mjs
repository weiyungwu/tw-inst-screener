// 出貨評分與分類(純函式)。出貨規格 §7。門檻集中在 CONFIG,和吸籌(lib/score.mjs)不共用。
// 單位同 features:inst_*_pct、sbl_chg_20_pct、big400_* 是 %;ret_20、drawdown_60、dist_ma60、
// margin_chg_20、holders_chg_4w_pct 是小數(0.05 代表 5%)。
//
// ⚠️ d-v0.1 的門檻是依吸籌規格鏡像推估的起始值,還沒有用實際資料校準(規格 §7、§11 P3)。

export const CONFIG = {
  version: 'd-v0.1',
  minAvgValue20: 20_000_000, // EXCLUDED 條件和吸籌相同(規格 §7.2)
  collapsed: { ret20: -0.25, drawdown60: -0.30 }, // ret_20 < 或 drawdown_60 < → COLLAPSED
  stages: { distribution: 70, caution: 55 },
  minCoveragePoints: 85, // coverage ≥ 0.85;以整數配分比較,避免浮點誤差
  inst: {
    netPct: [[-1.0, 20], [-0.5, 14], [-0.2, 7]], // inst_net_20_pct ≤ 門檻 → 分數(取第一個符合)
    sellDays: [[12, 10], [10, 5]], // inst_sell_days_20 ≥ 門檻 → 分數
  },
  dispersion: {
    downWeeks: [[3, 12], [2, 6]],
    holdersRise: [0.02, 8], // holders_chg_4w_pct > +2% → 8
    big400Chg: [-0.5, 5], // big400_chg_4w ≤ −0.5 → 5
  },
  price: {
    drawdown: [-0.15, -0.03, 10], // −15% ≤ drawdown_60 ≤ −3% → 10
    distMa60: [0.05, 5], // dist_ma60 ≥ 5% → 5
    belowMa20: 5,
  },
  dump: [[2, 10], [1, 5]], // dump_days_20 ≥ 門檻 → 分數
  credit: {
    sblChg: [[0.5, 10], [0.2, 5]], // sbl_chg_20_pct ≥ 門檻 → 分數
    marginRise: [0.10, 5], // margin_chg_20 > +10% → 5
  },
  // 訊號標籤門檻:規格只列名稱(trust_selling 除外),其餘沿用計分門檻
  signals: { instSteadySell: { netPct: -0.5, sellDays: 10 }, trustSelling: -0.2, bigHolderFalling: 2 },
  tdccWarmupWeeks: 4,
};

// 每個計分項的配分上限(coverage 的分子)。合計 100
export const WEIGHTS = {
  inst_net_20_pct: 20, inst_sell_days_20: 10,
  big400_down_weeks: 12, holders_chg_4w_pct: 8, big400_chg_4w: 5,
  drawdown_60: 10, dist_ma60: 5, below_ma20: 5,
  dump_days_20: 10,
  sbl_chg_20_pct: 10, margin_chg_20: 5,
};

const tierGe = (v, tiers) => tiers.find(([th]) => v >= th)?.[1] ?? 0;
const tierLe = (v, tiers) => tiers.find(([th]) => v <= th)?.[1] ?? 0;

// f:features;ctx:{ sblPending, sblWarmingUp, marketAssumed }(市場層級的狀態,由呼叫端判斷)
// 回傳 { score, coverage, stage, breakdown, signals }
// 特徵為 null → 該項 0 分、記 missing:<名稱>、不計入 coverage。0 分代表「無法判斷」不是「沒有風險」,
// 所以分數不依覆蓋率放大,而是由 coverage 決定能不能正式分類(PROVISIONAL)
export function scoreDistribution(f, ctx = {}, C = CONFIG) {
  const missing = [];
  let covered = 0;
  for (const [name, w] of Object.entries(WEIGHTS)) {
    if (f[name] == null) missing.push(name);
    else covered += w;
  }
  const has = (name) => f[name] != null;

  let inst = 0;
  if (has('inst_net_20_pct')) inst += tierLe(f.inst_net_20_pct, C.inst.netPct);
  if (has('inst_sell_days_20')) inst += tierGe(f.inst_sell_days_20, C.inst.sellDays);

  let dispersion = 0;
  if (has('big400_down_weeks')) dispersion += tierGe(f.big400_down_weeks, C.dispersion.downWeeks);
  if (has('holders_chg_4w_pct') && f.holders_chg_4w_pct > C.dispersion.holdersRise[0]) dispersion += C.dispersion.holdersRise[1];
  if (has('big400_chg_4w') && f.big400_chg_4w <= C.dispersion.big400Chg[0]) dispersion += C.dispersion.big400Chg[1];

  let price = 0;
  const offHigh = has('drawdown_60') && f.drawdown_60 >= C.price.drawdown[0] && f.drawdown_60 <= C.price.drawdown[1];
  if (offHigh) price += C.price.drawdown[2];
  if (has('dist_ma60') && f.dist_ma60 >= C.price.distMa60[0]) price += C.price.distMa60[1];
  if (f.below_ma20 === true) price += C.price.belowMa20;

  const volume = has('dump_days_20') ? tierGe(f.dump_days_20, C.dump) : 0;

  let credit = 0;
  if (has('sbl_chg_20_pct')) credit += tierGe(f.sbl_chg_20_pct, C.credit.sblChg);
  if (has('margin_chg_20') && f.margin_chg_20 > C.credit.marginRise[0]) credit += C.credit.marginRise[1];

  const breakdown = { inst, dispersion, price, volume, credit };
  const score = inst + dispersion + price + volume + credit;
  const enough = covered >= C.minCoveragePoints;

  let stage;
  if (f.avg_value_20 == null || f.avg_value_20 < C.minAvgValue20 || f.ret_20 == null || f.vol_ratio == null) stage = 'EXCLUDED';
  else if (f.ret_20 < C.collapsed.ret20 || (has('drawdown_60') && f.drawdown_60 < C.collapsed.drawdown60)) stage = 'COLLAPSED';
  else if (score >= C.stages.caution && !enough) stage = 'PROVISIONAL';
  else if (score >= C.stages.distribution) stage = 'DISTRIBUTION';
  else if (score >= C.stages.caution) stage = 'CAUTION';
  else stage = 'NEUTRAL';

  const S = C.signals;
  const signals = [];
  if (has('inst_net_20_pct') && has('inst_sell_days_20') && f.inst_net_20_pct <= S.instSteadySell.netPct && f.inst_sell_days_20 >= S.instSteadySell.sellDays) signals.push('inst_steady_sell');
  if (has('trust_net_20_pct') && f.trust_net_20_pct <= S.trustSelling) signals.push('trust_selling');
  if (has('big400_down_weeks') && f.big400_down_weeks >= S.bigHolderFalling) signals.push('big_holder_falling');
  if (has('holders_chg_4w_pct') && f.holders_chg_4w_pct > C.dispersion.holdersRise[0]) signals.push('holders_rising');
  if (offHigh) signals.push('off_high');
  if (f.below_ma20 === true) signals.push('below_ma20');
  if (has('dump_days_20') && f.dump_days_20 >= 1) signals.push('dump_bar');
  if (has('sbl_chg_20_pct') && f.sbl_chg_20_pct >= C.credit.sblChg.at(-1)[0]) signals.push('sbl_rising');
  if (has('margin_chg_20') && f.margin_chg_20 > C.credit.marginRise[0]) signals.push('margin_rising');
  if (stage === 'COLLAPSED') signals.push('collapsed');
  if (stage === 'NEUTRAL' && !enough) signals.push('low_coverage');
  if (ctx.sblPending) signals.push('sbl_pending');
  if ((f.tdcc_weeks ?? 0) < C.tdccWarmupWeeks) signals.push('tdcc_warming_up');
  if (ctx.sblWarmingUp) signals.push('sbl_warming_up');
  if (ctx.marketAssumed) signals.push('market_assumed');
  for (const name of missing) signals.push(`missing:${name}`);

  return { score, coverage: covered / 100, stage, breakdown, signals };
}

// 歷史股票池(規格 §7.6,只用於出貨評分與回測;吸籌的迴圈不改)。
// universe(t) = price_daily 在 t 日有資料列的代號(收盤為 null 的停牌股也算;t 日沒有列的未上市/已下市股不算)。
// market(t) = sbl_daily.market 在 t 日或往前最近一筆;沒有借券資料才退回 stocks.market,並標 market_assumed。
//   priceRows [{date, code}]、sblRows [{date, code, market}](≤ t 即可,順序不限)、stocks Map<code, market>
// 回傳 Map<code, { market, market_assumed }>
export function pointInTimeUniverse({ t, priceRows, sblRows, stocks }) {
  const latest = new Map(); // code → { date, market },取 ≤ t 最近一筆
  for (const r of sblRows) {
    if (r.date > t) continue;
    const prev = latest.get(r.code);
    if (!prev || r.date > prev.date) latest.set(r.code, r);
  }
  const out = new Map();
  for (const r of priceRows) {
    if (r.date !== t || out.has(r.code)) continue;
    const sbl = latest.get(r.code);
    out.set(r.code, sbl ? { market: sbl.market, market_assumed: false } : { market: stocks.get(r.code) ?? null, market_assumed: true });
  }
  return out;
}
