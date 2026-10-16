import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreDistribution, pointInTimeUniverse, CONFIG, WEIGHTS } from '../lib/distribution.mjs';

// 所有計分特徵都有值、每項都 0 分的基準個股;測試只覆寫要驗的特徵
const BASE = {
  inst_net_20_pct: 0, inst_sell_days_20: 0, trust_net_20_pct: 0,
  big400_down_weeks: 0, holders_chg_4w_pct: 0, big400_chg_4w: 0, tdcc_weeks: 6,
  drawdown_60: 0, dist_ma60: 0, below_ma20: false, dump_days_20: 0,
  sbl_chg_20_pct: 0, margin_chg_20: 0,
  avg_value_20: 100_000_000, ret_20: 0, vol_ratio: 1,
};
const F = (o = {}) => ({ ...BASE, ...o });
const score = (o, ctx) => scoreDistribution(F(o), ctx);
const part = (o, key) => score(o).breakdown[key];

// 每項都拿滿:法人 30、籌碼 25、高檔 20、量能 10、信用 15
const MAX = {
  inst_net_20_pct: -1.0, inst_sell_days_20: 12,
  big400_down_weeks: 3, holders_chg_4w_pct: 0.03, big400_chg_4w: -0.5,
  drawdown_60: -0.05, dist_ma60: 0.05, below_ma20: true, dump_days_20: 2,
  sbl_chg_20_pct: 0.5, margin_chg_20: 0.11,
};

test('配分合計 100,全部拿滿 = 100 分、coverage 1.0', () => {
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
  const r = score(MAX);
  assert.equal(r.score, 100);
  assert.equal(r.coverage, 1);
  assert.equal(r.stage, 'DISTRIBUTION');
  assert.deepEqual(r.breakdown, { inst: 30, dispersion: 25, price: 20, volume: 10, credit: 15 });
});

test('法人調節:淨賣超 % 股本分級(≤ 門檻)、賣超天數分級(≥ 門檻)', () => {
  for (const [v, pts] of [[-1.0, 20], [-0.99, 14], [-0.5, 14], [-0.2, 7], [-0.19, 0], [0.5, 0]]) assert.equal(part({ inst_net_20_pct: v }, 'inst'), pts, `net ${v}`);
  for (const [v, pts] of [[12, 10], [11, 5], [10, 5], [9, 0]]) assert.equal(part({ inst_sell_days_20: v }, 'inst'), pts, `days ${v}`);
});

test('籌碼分散:大戶連減週數、股東人數增加 > 2%(等於不算)、大戶 4 週 ≤ −0.5', () => {
  for (const [v, pts] of [[3, 12], [2, 6], [1, 0]]) assert.equal(part({ big400_down_weeks: v }, 'dispersion'), pts, `weeks ${v}`);
  assert.equal(part({ holders_chg_4w_pct: 0.02 }, 'dispersion'), 0);
  assert.equal(part({ holders_chg_4w_pct: 0.0201 }, 'dispersion'), 8);
  assert.equal(part({ big400_chg_4w: -0.5 }, 'dispersion'), 5);
  assert.equal(part({ big400_chg_4w: -0.49 }, 'dispersion'), 0);
});

test('高檔轉弱:從高點回落 3%~15% 才給分(還在高點或已經崩都不算)、仍在季線上 5% 以上、跌破 MA20', () => {
  for (const [v, pts] of [[-0.15, 10], [-0.03, 10], [-0.151, 0], [-0.029, 0], [0, 0]]) assert.equal(part({ drawdown_60: v }, 'price'), pts, `drawdown ${v}`);
  assert.equal(part({ dist_ma60: 0.05 }, 'price'), 5);
  assert.equal(part({ dist_ma60: 0.049 }, 'price'), 0);
  assert.equal(part({ below_ma20: true }, 'price'), 5);
  assert.equal(part({ below_ma20: null }, 'price'), 0);
});

test('量能異常與信用借券的分級邊界', () => {
  for (const [v, pts] of [[2, 10], [1, 5], [0, 0]]) assert.equal(part({ dump_days_20: v }, 'volume'), pts, `dump ${v}`);
  for (const [v, pts] of [[0.5, 10], [0.2, 5], [0.19, 0]]) assert.equal(part({ sbl_chg_20_pct: v }, 'credit'), pts, `sbl ${v}`);
  assert.equal(part({ margin_chg_20: 0.10 }, 'credit'), 0, '融資增加剛好 10% 不算');
  assert.equal(part({ margin_chg_20: 0.1001 }, 'credit'), 5);
});

test('階段門檻:70 → DISTRIBUTION、55~69 → CAUTION、54 → NEUTRAL', () => {
  // 法人 30 + 籌碼 25 + 量能 10 + 季線 5 = 70
  const s70 = { inst_net_20_pct: -1, inst_sell_days_20: 12, big400_down_weeks: 3, holders_chg_4w_pct: 0.03, big400_chg_4w: -0.5, dump_days_20: 2, dist_ma60: 0.05 };
  assert.deepEqual([score(s70).score, score(s70).stage], [70, 'DISTRIBUTION']);
  const s65 = { ...s70, dump_days_20: 1 };
  assert.deepEqual([score(s65).score, score(s65).stage], [65, 'CAUTION']);
  const s55 = { ...s70, dump_days_20: 0, dist_ma60: 0 }; // 30 + 25
  assert.deepEqual([score(s55).score, score(s55).stage], [55, 'CAUTION']);
  const s54 = { inst_net_20_pct: -1, inst_sell_days_20: 12, big400_down_weeks: 2, holders_chg_4w_pct: 0.03, big400_chg_4w: -0.5, below_ma20: true }; // 30 + 6 + 8 + 5 + 5
  assert.deepEqual([score(s54).score, score(s54).stage], [54, 'NEUTRAL']);
});

test('COLLAPSED 優先於高分(已大跌一段,不適用高檔派發判斷;不代表風險解除)', () => {
  const r = score({ ...MAX, ret_20: -0.26 });
  assert.equal(r.score, 100);
  assert.equal(r.stage, 'COLLAPSED');
  assert.ok(r.signals.includes('collapsed'));
  assert.equal(score({ ...MAX, drawdown_60: -0.31 }).stage, 'COLLAPSED');
  assert.notEqual(score({ ...MAX, ret_20: -0.25 }).stage, 'COLLAPSED', '剛好 −25% 不算');
});

test('EXCLUDED 和吸籌相同:成交值不足、20 日報酬或量比算不出來', () => {
  assert.equal(score({ ...MAX, avg_value_20: 19_999_999 }).stage, 'EXCLUDED');
  assert.equal(score({ ...MAX, avg_value_20: null }).stage, 'EXCLUDED');
  assert.equal(score({ ...MAX, ret_20: null }).stage, 'EXCLUDED');
  assert.equal(score({ ...MAX, vol_ratio: null }).stage, 'EXCLUDED');
  assert.equal(score({ ...MAX, ret_20: -0.5, avg_value_20: 1 }).stage, 'EXCLUDED', 'EXCLUDED 優先於 COLLAPSED');
});

test('只差借券為 null:coverage 1.0 → 0.9、分數少 10、記 missing,仍可正式分類', () => {
  const full = score(MAX);
  const noSbl = score({ ...MAX, sbl_chg_20_pct: null });
  assert.equal(full.coverage, 1);
  assert.equal(noSbl.coverage, 0.9);
  assert.equal(noSbl.score, full.score - 10);
  assert.equal(noSbl.stage, 'DISTRIBUTION');
  assert.ok(noSbl.signals.includes('missing:sbl_chg_20_pct'));
});

test('score 70、coverage 0.8 → PROVISIONAL:缺資料不可當成沒風險(NEUTRAL),也不可當成正式結果(DISTRIBUTION)', () => {
  // 借券與回落各缺 10 分 → coverage 0.8;其餘拿到 30 + 25 + 5 + 10 = 70
  const f = { inst_net_20_pct: -1, inst_sell_days_20: 12, big400_down_weeks: 3, holders_chg_4w_pct: 0.03, big400_chg_4w: -0.5, dist_ma60: 0.05, dump_days_20: 2, sbl_chg_20_pct: null, drawdown_60: null };
  const r = score(f);
  assert.deepEqual([r.score, r.coverage, r.stage], [70, 0.8, 'PROVISIONAL']);
  assert.ok(r.signals.includes('missing:sbl_chg_20_pct') && r.signals.includes('missing:drawdown_60'));
  // 55 分、coverage 0.8 也是 PROVISIONAL
  assert.equal(score({ ...f, dump_days_20: 0, dist_ma60: 0 }).stage, 'PROVISIONAL');
});

test('coverage 0.85 剛好可以正式分類;低分且覆蓋不足 → NEUTRAL 但帶 low_coverage', () => {
  // 缺籌碼 12 + 季線 5 = 17 分 → 0.83;缺 10 + 5 = 15 → 0.85
  assert.equal(score({ ...MAX, sbl_chg_20_pct: null, dist_ma60: null }).coverage, 0.85);
  assert.equal(score({ ...MAX, sbl_chg_20_pct: null, dist_ma60: null }).stage, 'DISTRIBUTION');
  assert.equal(score({ ...MAX, big400_down_weeks: null, dist_ma60: null }).stage, 'PROVISIONAL');
  const low = score({ sbl_chg_20_pct: null, drawdown_60: null });
  assert.equal(low.stage, 'NEUTRAL');
  assert.ok(low.signals.includes('low_coverage'));
  assert.ok(!score({}).signals.includes('low_coverage'), '覆蓋足夠的 NEUTRAL 不帶');
});

test('訊號標籤與呼叫端傳入的市場狀態', () => {
  const r = score({ ...MAX, trust_net_20_pct: -0.2, inst_sell_days_20: 10, tdcc_weeks: 3 }, { sblPending: true, sblWarmingUp: true, marketAssumed: true });
  for (const s of ['inst_steady_sell', 'trust_selling', 'big_holder_falling', 'holders_rising', 'off_high', 'below_ma20', 'dump_bar', 'sbl_rising', 'margin_rising', 'sbl_pending', 'sbl_warming_up', 'market_assumed', 'tdcc_warming_up']) {
    assert.ok(r.signals.includes(s), s);
  }
  assert.deepEqual(score({}).signals, [], '基準個股沒有任何訊號');
  assert.equal(CONFIG.version, 'd-v0.1');
});

test('歷史股票池:t 之後才上市、t 之前已下市都不在 universe(t);t 之後才轉上市的 market(t) 是上櫃', () => {
  const t = '2026-10-15';
  const priceRows = [
    { date: '2026-10-15', code: '2330' },
    { date: '2026-10-15', code: '8908' }, // 10-16 才轉上市
    { date: '2026-10-15', code: '1111' }, // 停牌:有列但收盤為 null,仍在股票池
    { date: '2026-10-14', code: '9999' }, // 10-15 前已下市
    { date: '2026-10-16', code: '7777' }, // 10-16 才上市
    { date: '2026-10-16', code: '8908' },
  ];
  const sblRows = [
    { date: '2026-10-15', code: '2330', market: 'TWSE' },
    { date: '2026-10-15', code: '8908', market: 'TPEX' },
    { date: '2026-10-16', code: '8908', market: 'TWSE' }, // t 之後的不可用
    { date: '2026-10-13', code: '1111', market: 'TPEX' }, // 停牌前最近一筆
  ];
  const stocks = new Map([['2330', 'TWSE'], ['8908', 'TWSE'], ['1111', 'TWSE'], ['9999', 'TWSE'], ['7777', 'TWSE'], ['5555', 'TPEX']]);
  const u = pointInTimeUniverse({ t, priceRows, sblRows, stocks });
  assert.deepEqual([...u.keys()].sort(), ['1111', '2330', '8908']);
  assert.deepEqual(u.get('8908'), { market: 'TPEX', market_assumed: false }, 'stocks.market 是最新的 TWSE,不可拿來回溯');
  assert.deepEqual(u.get('1111'), { market: 'TPEX', market_assumed: false }, '用 t 往前最近一筆借券');
});

test('歷史股票池:沒有借券資料時退回 stocks.market 並標 market_assumed', () => {
  const u = pointInTimeUniverse({ t: 'd2', priceRows: [{ date: 'd2', code: '5555' }], sblRows: [], stocks: new Map([['5555', 'TPEX']]) });
  assert.deepEqual(u.get('5555'), { market: 'TPEX', market_assumed: true });
});
