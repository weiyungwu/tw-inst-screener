// 評分與分類(純函式)。規格 §7。所有門檻集中在 CONFIG,方便日後調整。
// 比例類特徵:inst_*_pct 單位是 %(0.5 代表 0.5%);ret_20、dist_ma60、range_20、margin_chg_20、
// holders_chg_4w_pct 是小數(0.05 代表 5%);big400_* 是 %。

export const CONFIG = {
  // v1.1(2026-10-12):集保滿 5 週後 ACCUMULATION 占可評分 15.9%(規格上限 5%)。
  //   主因是「股東人數 4 週減少」只要減少就給分,133 檔中 128 檔拿到(中位數僅 −1.4%),幾乎沒有分辨力。
  //   改為減少超過 2% 才給分,並把吸籌/觀察門檻由 60/45 提高到 70/55;以 10/08 資料模擬為 40 檔(4.8%)。
  version: 'v1.1',
  minAvgValue20: 20_000_000, // 20 日平均成交值門檻(元)
  overheated: { ret20: 0.25, volRatio: 2.5 },
  stages: { accumulation: 70, watch: 55 },
  inst: {
    netPct: [[1.0, 20], [0.5, 14], [0.2, 7]], // inst_net_20_pct ≥ 門檻 → 分數(取第一個符合)
    buyDays: [[12, 10], [10, 5]],
  },
  concentration: {
    upWeeks: [[3, 15], [2, 8]],
    holdersDecline: [-0.02, 10], // holders_chg_4w_pct < −2% → +10
    big400Chg: [0.5, 5], // big400_chg_4w ≥ 0.5 → +5
  },
  price: {
    ret20: [-0.05, 0.10, 10], // −5% ≤ ret_20 ≤ 10% → 10
    distMa60: [0.10, 5], // |dist_ma60| ≤ 10% → 5
    range20: [0.15, 5], // range_20 ≤ 15% → 5
  },
  volume: { mild: [1.0, 1.8, 10], low: [0.8, 1.0, 5] }, // [下限, 上限, 分數];mild 含上限,low 不含上限
  margin: { strong: [-0.05, 10], mild: [0, 5] }, // margin_chg_20 < 門檻 → 分數
  // 訊號標籤門檻(規格只列名稱,門檻為 v1 自訂)
  signals: {
    instSteadyBuy: { netPct: 0.5, buyDays: 10 },
    trustBuying: 0.2, // trust_net_20_pct ≥ 0.2%
    bigHolderRising: 2, // big400_up_weeks ≥ 2
  },
  tdccWarmupWeeks: 4,
};

const tier = (v, tiers) => tiers.find(([th]) => v >= th)?.[1] ?? 0;

// 回傳 { score, stage, breakdown, signals }
export function scoreStock(f, C = CONFIG) {
  const signals = [];
  // 取特徵;null 時記 missing 並回傳 null(該項 0 分)
  const missing = new Set();
  const need = (name) => {
    if (f[name] == null) missing.add(name);
    return f[name];
  };

  // 法人緩買(30)
  let inst = 0;
  const net = need('inst_net_20_pct');
  if (net != null) inst += tier(net, C.inst.netPct);
  const buyDays = need('inst_buy_days_20');
  if (buyDays != null) inst += tier(buyDays, C.inst.buyDays);

  // 籌碼集中(30)
  let concentration = 0;
  const up = need('big400_up_weeks');
  if (up != null) concentration += tier(up, C.concentration.upWeeks);
  const hc = need('holders_chg_4w_pct');
  if (hc != null && hc < C.concentration.holdersDecline[0]) concentration += C.concentration.holdersDecline[1];
  const bc = need('big400_chg_4w');
  if (bc != null && bc >= C.concentration.big400Chg[0]) concentration += C.concentration.big400Chg[1];

  // 價格未動(20)
  let price = 0;
  const ret = need('ret_20');
  if (ret != null && ret >= C.price.ret20[0] && ret <= C.price.ret20[1]) price += C.price.ret20[2];
  const dist = need('dist_ma60');
  if (dist != null && Math.abs(dist) <= C.price.distMa60[0]) price += C.price.distMa60[1];
  const range = need('range_20');
  if (range != null && range <= C.price.range20[0]) price += C.price.range20[1];

  // 量能溫和(10)
  let volume = 0;
  const vr = need('vol_ratio');
  if (vr != null) {
    if (vr >= C.volume.mild[0] && vr <= C.volume.mild[1]) volume = C.volume.mild[2];
    else if (vr >= C.volume.low[0] && vr < C.volume.low[1]) volume = C.volume.low[2];
  }

  // 融資退場(10)
  let margin = 0;
  const mc = need('margin_chg_20');
  if (mc != null) {
    if (mc < C.margin.strong[0]) margin = C.margin.strong[1];
    else if (mc < C.margin.mild[0]) margin = C.margin.mild[1];
  }

  const breakdown = { inst, concentration, price, volume, margin };
  const score = inst + concentration + price + volume + margin;

  let stage;
  if (f.avg_value_20 == null || f.avg_value_20 < C.minAvgValue20 || ret == null || vr == null) stage = 'EXCLUDED';
  else if (ret > C.overheated.ret20 || vr > C.overheated.volRatio) stage = 'OVERHEATED';
  else if (score >= C.stages.accumulation) stage = 'ACCUMULATION';
  else if (score >= C.stages.watch) stage = 'WATCH';
  else stage = 'NEUTRAL';

  const S = C.signals;
  if (net != null && buyDays != null && net >= S.instSteadyBuy.netPct && buyDays >= S.instSteadyBuy.buyDays) signals.push('inst_steady_buy');
  if (f.trust_net_20_pct != null && f.trust_net_20_pct >= S.trustBuying) signals.push('trust_buying');
  if (up != null && up >= S.bigHolderRising) signals.push('big_holder_rising');
  if (hc != null && hc < C.concentration.holdersDecline[0]) signals.push('holders_declining');
  if (ret != null && ret >= C.price.ret20[0] && ret <= C.price.ret20[1]) signals.push('price_quiet');
  if (range != null && range <= C.price.range20[0]) signals.push('box_compression');
  if (vr != null && vr >= C.volume.mild[0] && vr <= C.volume.mild[1]) signals.push('volume_mild');
  if (mc != null && mc < C.margin.strong[0]) signals.push('margin_exit');
  if (stage === 'OVERHEATED') signals.push('overheated');
  if ((f.tdcc_weeks ?? 0) < C.tdccWarmupWeeks) signals.push('tdcc_warming_up');
  for (const name of missing) signals.push(`missing:${name}`);

  return { score, stage, breakdown, signals };
}
