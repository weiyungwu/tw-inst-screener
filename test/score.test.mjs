import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreStock } from '../lib/score.mjs';

// 典型吸籌:法人緩買 0.8% 股本、13 天買超;大戶連增 3 週、股東人數減、大戶 4 週 +0.6;
// 20 日漲 3%、貼近季線、箱型 12%;量比 1.2;融資 20 日 −6.4%
const accumulation = {
  avg_value_20: 80_000_000,
  inst_net_20_pct: 0.8, inst_buy_days_20: 13, trust_net_20_pct: 0.3,
  big400_up_weeks: 3, holders_chg_4w_pct: -0.021, big400_chg_4w: 0.6, tdcc_weeks: 8,
  ret_20: 0.03, dist_ma60: 0.04, range_20: 0.12,
  vol_ratio: 1.2,
  margin_chg_20: -0.064,
};

test('典型吸籌 → ACCUMULATION,各群組依規格給分', () => {
  const r = scoreStock(accumulation);
  assert.deepEqual(r.breakdown, { inst: 14 + 10, concentration: 15 + 10 + 5, price: 20, volume: 10, margin: 10 });
  assert.equal(r.score, 94);
  assert.equal(r.stage, 'ACCUMULATION');
  for (const s of ['inst_steady_buy', 'trust_buying', 'big_holder_rising', 'holders_declining', 'price_quiet', 'box_compression', 'volume_mild', 'margin_exit']) {
    assert.ok(r.signals.includes(s), s);
  }
  assert.equal(r.signals.some((s) => s.startsWith('missing:') || s === 'tdcc_warming_up'), false);
});

test('法人大買但 20 日已漲 30% → OVERHEATED(不論分數多高,吸籌已經不是「默默」)', () => {
  const r = scoreStock({ ...accumulation, inst_net_20_pct: 3.0, ret_20: 0.30 });
  assert.equal(r.stage, 'OVERHEATED');
  assert.ok(r.signals.includes('overheated'));
  assert.equal(r.signals.includes('price_quiet'), false);
});

test('量比 > 2.5 也是 OVERHEATED', () => {
  assert.equal(scoreStock({ ...accumulation, vol_ratio: 2.6 }).stage, 'OVERHEATED');
});

test('成交值不足 2,000 萬 → EXCLUDED,即使分數很高(小型股籌碼數字容易被少量交易放大)', () => {
  const r = scoreStock({ ...accumulation, avg_value_20: 19_999_999 });
  assert.equal(r.stage, 'EXCLUDED');
  assert.equal(r.score, 94); // 分數照算,保留給回測
});

test('價格資料不足(ret_20 或量比為 null)→ EXCLUDED', () => {
  assert.equal(scoreStock({ ...accumulation, ret_20: null }).stage, 'EXCLUDED');
  assert.equal(scoreStock({ ...accumulation, vol_ratio: null }).stage, 'EXCLUDED');
});

test('集保只有 1 週 → tdcc_warming_up,籌碼集中只拿得到部分分數,缺的特徵標 missing', () => {
  const r = scoreStock({ ...accumulation, big400_up_weeks: null, holders_chg_4w_pct: null, big400_chg_4w: null, tdcc_weeks: 1 });
  assert.ok(r.signals.includes('tdcc_warming_up'));
  assert.ok(r.breakdown.concentration < 30);
  for (const k of ['big400_up_weeks', 'holders_chg_4w_pct', 'big400_chg_4w']) assert.ok(r.signals.includes(`missing:${k}`), k);
  assert.equal(r.score, 94 - 30);
  // v1.1 吸籌門檻 70:集保資料不足時只能靠其他四群組(本例 64 分)→ 觀察,
  // 沒有籌碼集中的證據就不列入吸籌
  assert.equal(r.stage, 'WATCH');
});

test('級距邊界:法人 % 與買超天數、量比、融資都依規格的 ≥ / < 判斷', () => {
  const s = (f) => scoreStock({ ...accumulation, ...f }).breakdown;
  assert.equal(s({ inst_net_20_pct: 1.0, inst_buy_days_20: 12 }).inst, 30);
  assert.equal(s({ inst_net_20_pct: 0.19, inst_buy_days_20: 9 }).inst, 0);
  assert.equal(s({ inst_net_20_pct: 0.2, inst_buy_days_20: 10 }).inst, 12);
  assert.equal(s({ vol_ratio: 1.8 }).volume, 10);
  assert.equal(s({ vol_ratio: 0.8 }).volume, 5);
  assert.equal(s({ vol_ratio: 1.81 }).volume, 0);
  assert.equal(s({ margin_chg_20: -0.05 }).margin, 5); // 要 < −5% 才給 10
  assert.equal(s({ margin_chg_20: 0 }).margin, 0);
  assert.equal(s({ big400_up_weeks: 2 }).concentration, 8 + 10 + 5);
  assert.equal(s({ ret_20: -0.06 }).price, 10);
});

test('v1.1 階段門檻:≥ 70 吸籌、55~69 觀察、< 55 中性', () => {
  // 集保與融資都沒加分:法人 24 + 價格 20 + 量能 10 = 54 → 中性
  const base = { ...accumulation, big400_up_weeks: 0, holders_chg_4w_pct: 0.01, big400_chg_4w: 0, margin_chg_20: 0.1 };
  const neutral = scoreStock(base);
  assert.equal(neutral.score, 54);
  assert.equal(neutral.stage, 'NEUTRAL');
  const watch = scoreStock({ ...base, margin_chg_20: -0.064 }); // 融資 +10 → 64
  assert.equal(watch.score, 64);
  assert.equal(watch.stage, 'WATCH');
  const acc = scoreStock({ ...base, margin_chg_20: -0.064, big400_up_weeks: 2 }); // 大戶連增 2 週 +8 → 72
  assert.equal(acc.score, 72);
  assert.equal(acc.stage, 'ACCUMULATION');
  assert.equal(scoreStock({ ...base, margin_chg_20: -0.064, big400_up_weeks: 2, inst_buy_days_20: 10 }).score, 67); // 買超天數降到 10 天(法人 −5)→ 67,回到觀察
});

test('股東人數要減少超過 2% 才算籌碼集中(小幅減少是全市場普遍現象,沒有分辨力)', () => {
  const r = (hc) => scoreStock({ ...accumulation, holders_chg_4w_pct: hc });
  for (const hc of [-0.01, -0.02, 0]) {
    assert.equal(r(hc).breakdown.concentration, 15 + 5, `${hc}`);
    assert.equal(r(hc).signals.includes('holders_declining'), false, `${hc}`);
  }
  assert.equal(r(-0.021).breakdown.concentration, 15 + 10 + 5);
  assert.ok(r(-0.021).signals.includes('holders_declining'));
});
