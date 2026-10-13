import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fourD } from '../lib/fourd.mjs';

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
