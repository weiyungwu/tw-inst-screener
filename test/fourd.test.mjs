import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fourD, fourDBear } from '../lib/fourd.mjs';

// 基準:四顆燈全紅的個股。各測試只改一個條件,確認那顆燈會翻轉,其他燈不受影響
const base = () => ({
  features: { inst_net_20_pct: 0.5, inst_buy_days_20: 12, inst_net_5: 1000, vol_ratio: 1.2 },
  levels: {
    close: 110, prev_close: 105, volume: 1000, vol_ma5_prev: 1000,
    ma5: 108, ma10: 106, ma20: 104, ma60: 100, high_19_prev: 109, high_59_prev: 115,
  },
});
const run = (mut) => { const x = base(); mut?.(x); return fourD(x); };

test('全部條件成立 → 4 紅、有效 4', () => {
  assert.deepEqual(run(), { chip: 'red', volume: 'red', ma: 'red', pattern: 'red', red: 4, valid: 4 });
});

test('籌碼:三條要全部成立,只差一條就不算主力在買', () => {
  assert.equal(run((x) => { x.features.inst_net_20_pct = 0.19; }).chip, 'green'); // 未達 0.2% 股本
  assert.equal(run((x) => { x.features.inst_buy_days_20 = 9; }).chip, 'green'); // 買超集中在少數幾天
  assert.equal(run((x) => { x.features.inst_net_5 = 0; }).chip, 'green'); // 近 5 日已轉賣
  assert.equal(run((x) => { x.features.inst_net_20_pct = 0.2; x.features.inst_buy_days_20 = 10; }).chip, 'red'); // 門檻含等於
});

test('量能:帶量上攻或健康量價任一成立;爆量長黑否決健康量價', () => {
  // 量比不在健康區間,但當天量 ≥ 1.5 倍前 5 日均量且收紅 → 帶量上攻
  assert.equal(run((x) => { x.features.vol_ratio = 2.0; x.levels.volume = 1500; }).volume, 'red');
  // 同樣放量但收黑 → 不是上攻
  assert.equal(run((x) => { x.features.vol_ratio = 2.0; x.levels.volume = 1500; x.levels.close = 104; }).volume, 'green');
  // 無量
  assert.equal(run((x) => { x.features.vol_ratio = 0.7; }).volume, 'green');
  // 量比健康,但當天 2 倍量、跌 3% → 爆量長黑,不可亮紅
  assert.equal(run((x) => { x.levels.volume = 2000; x.levels.close = 101.85; }).volume, 'green');
  // 跌 3% 但量沒到 2 倍 → 只是下跌,量比仍健康
  assert.equal(run((x) => { x.levels.volume = 1900; x.levels.close = 101.85; }).volume, 'red');
});

test('量能用「前 5 日均量」:當天的量不能稀釋自己', () => {
  // 前 5 日均量 1000、當天 1500 → 1.5 倍成立。若誤用含當天的均量 (4×1000+1500)/5=1100,就只有 1.36 倍
  assert.equal(run((x) => { x.features.vol_ratio = 2.0; x.levels.volume = 1500; x.levels.vol_ma5 = 1100; }).volume, 'red');
});

test('均線:收盤要同時高於四條均線,等於不算站上', () => {
  assert.equal(run((x) => { x.levels.ma60 = 110; }).ma, 'green');
  assert.equal(run((x) => { x.levels.ma5 = 111; }).ma, 'green');
});

test('型態:突破前 19 日高點,或站上前 59 日高點', () => {
  assert.equal(run((x) => { x.levels.high_19_prev = 110; }).pattern, 'green'); // 只追平箱頂不算突破
  assert.equal(run((x) => { x.levels.high_19_prev = 112; x.levels.high_59_prev = 110; }).pattern, 'red'); // 追平季高即算
  assert.equal(run((x) => { x.levels.high_19_prev = 112; x.levels.high_59_prev = 111; }).pattern, 'green');
});

test('資料不足 → null(⚪),不可當成綠燈,也不計入有效燈數', () => {
  const r = run((x) => { x.levels.ma60 = null; x.features.inst_net_5 = null; });
  assert.equal(r.ma, null);
  assert.equal(r.chip, null);
  assert.equal(r.red, 2);
  assert.equal(r.valid, 2);
});

// ---- 四維偏空燈號(出貨頁):和偏多燈號對稱,true = 偏空成立、false = 未轉弱、null = 資料不足 ----

// 近 20 日 K:前 10 日最高 100;近 10 日沒有收盤站上 100
const flat = () => Array.from({ length: 20 }, () => ({ high: 100, close: 98 }));
// 基準:四顆燈全部偏空成立的個股
const bearBase = () => ({
  features: { inst_net_20_pct: -0.5, inst_sell_days_20: 12, inst_net_5: -1000, dump_days_20: 1 },
  levels: { close: 90, prev_close: 92, volume: 1000, vol_ma5_prev: 1000, ma5: 93, ma20: 95, low_19_prev: 91 },
  series: flat(),
});
const runBear = (mut) => { const x = bearBase(); mut?.(x); return fourDBear(x); };

test('偏空:全部條件成立 → 4 顆偏空、有效 4', () => {
  assert.deepEqual(runBear(), { chip: true, volume: true, ma: true, pattern: true, bear: 4, valid: 4 });
});

test('偏空籌碼:和偏多籌碼對稱,三條都要成立;只賣一兩天不算法人持續調節', () => {
  assert.equal(runBear((x) => { x.features.inst_net_20_pct = -0.19; }).chip, false);
  assert.equal(runBear((x) => { x.features.inst_sell_days_20 = 9; }).chip, false);
  assert.equal(runBear((x) => { x.features.inst_net_5 = 0; }).chip, false); // 近 5 日已不再賣
  assert.equal(runBear((x) => { x.features.inst_net_20_pct = -0.2; x.features.inst_sell_days_20 = 10; }).chip, true); // 門檻含等於
});

test('偏空量能:當天帶量下跌,或 20 日內有帶量長黑;放量收紅不算', () => {
  assert.equal(runBear((x) => { x.features.dump_days_20 = 0; x.levels.volume = 1500; }).volume, true); // 1.5 倍量收黑
  assert.equal(runBear((x) => { x.features.dump_days_20 = 0; x.levels.volume = 1500; x.levels.close = 93; }).volume, false); // 放量但收紅
  assert.equal(runBear((x) => { x.features.dump_days_20 = 0; }).volume, false); // 沒放量、也沒有長黑
  // 帶量長黑資料不足、當天也沒有帶量下跌 → 無法判斷,不可當成未轉弱
  assert.equal(runBear((x) => { x.features.dump_days_20 = null; }).volume, null);
});

test('偏空均線:跌破月線且 5 日線在月線下;不要求跌破季線(出貨評分抓的是高檔剛轉弱、通常還在季線上)', () => {
  assert.equal(runBear((x) => { x.levels.close = 96; }).ma, false); // 還在月線上
  assert.equal(runBear((x) => { x.levels.ma5 = 96; }).ma, false); // 短均線還沒轉弱
  assert.equal(runBear((x) => { x.levels.ma60 = 80; }).ma, true); // 季線在下方也照樣成立
});

test('偏空型態:跌破前 19 日低點,或疑似假突破(收盤站上前高後又跌回)', () => {
  // 沒跌破前低、也沒有假突破
  assert.equal(runBear((x) => { x.levels.low_19_prev = 89; }).pattern, false);
  // 沒跌破前低,但近 10 日曾收盤 101 > 前 10 日最高 100,最新收盤 98 又跌回 → 疑似假突破
  assert.equal(runBear((x) => { x.levels.low_19_prev = 89; x.series[15].close = 101; }).pattern, true);
  // 站上前高後還守在前高之上 → 不是假突破
  assert.equal(runBear((x) => { x.levels.low_19_prev = 89; x.series[15].close = 101; x.series[19].close = 100.5; }).pattern, false);
  // 日 K 不足 20 筆、也沒跌破前低 → 無法判斷假突破,整顆燈為 null
  assert.equal(runBear((x) => { x.levels.low_19_prev = 89; x.series = flat().slice(0, 19); }).pattern, null);
});

test('偏空:資料不足 → null,不計入有效燈數,也不可當成未轉弱', () => {
  const r = runBear((x) => { x.features.inst_sell_days_20 = null; x.levels.ma20 = null; });
  assert.equal(r.chip, null);
  assert.equal(r.ma, null);
  assert.equal(r.valid, 2);
  assert.equal(r.bear, 2);
});
