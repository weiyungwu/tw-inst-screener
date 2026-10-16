import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeatures, tdccFeatures } from '../lib/features.mjs';

// 手工構造序列:日期用 d01、d02…(只需要可排序),數值刻意設計成可心算驗證
const mkDays = (n) => Array.from({ length: n }, (_, i) => `d${String(i + 1).padStart(2, '0')}`);
const near = (a, b, msg) => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);

// n 天;close 從 100 起每天 +1;high/low = close ± 1;volume 1000;value = close × 1000
// 法人每天外資 +300、投信 +100、自營 −50;發行股數 1,000,000;外資持股比率每天 +0.1;融資每天 −10
function series(n, { closeOf = (i) => 100 + i, volOf = () => 1000 } = {}) {
  const days = mkDays(n);
  const price = new Map(), inst = new Map(), qfii = new Map(), margin = new Map();
  days.forEach((d, i) => {
    const c = closeOf(i);
    price.set(d, { open: c, high: c + 1, low: c - 1, close: c, volume: volOf(i), value: c * volOf(i) });
    inst.set(d, { foreign_net: 300, trust_net: 100, dealer_net: -50 });
    qfii.set(d, { issued_shares: 1_000_000, foreign_ratio: 10 + i * 0.1 });
    margin.set(d, { margin_balance: 2000 - i * 10 });
  });
  return { days, price, inst, qfii, margin, tdcc: [] };
}

test('25 天:20 日法人、價格、融資特徵數值正確', () => {
  const s = series(25);
  const f = computeFeatures(s);
  assert.equal(f.inst_net_20, 20 * 400);
  near(f.inst_net_20_pct, 0.8, 'inst_net_20_pct'); // 8000 / 1,000,000 × 100
  near(f.trust_net_20_pct, 0.2, 'trust_net_20_pct');
  near(f.dealer_net_20_pct, -0.1, 'dealer_net_20_pct');
  assert.equal(f.inst_buy_days_20, 20);
  near(f.foreign_ratio_chg_20, 2.0, 'foreign_ratio_chg_20'); // (10 + 24×0.1) − (10 + 4×0.1)
  near(f.ret_20, 124 / 104 - 1, 'ret_20'); // close(t)=124、close(t−20)=104
  near(f.range_20, (125 - 104) / 124, 'range_20'); // D20 = i 5..24:max high 125、min low 104
  near(f.avg_value_20, 1000 * (105 + 124) / 2, 'avg_value_20');
  near(f.margin_chg_20, 1760 / 1960 - 1, 'margin_chg_20'); // margin(t)=2000−240、margin(t−20)=2000−40
  // 不足 60 天:MA60 與 60 日均量算不出來,必須是 null 而不是用 25 天湊
  assert.equal(f.dist_ma60, null);
  assert.equal(f.vol_ratio, null);
});

test('65 天:MA60 乖離與量比(20 日均量 ÷ 60 日均量)', () => {
  // 最後 20 天量 3000,之前 1000 → 20 日均 3000、60 日均 (40×1000 + 20×3000)/60
  const s = series(65, { volOf: (i) => (i >= 45 ? 3000 : 1000) });
  const f = computeFeatures(s);
  near(f.vol_ratio, 3000 / (100000 / 60), 'vol_ratio');
  near(f.dist_ma60, 164 / ((105 + 164) / 2) - 1, 'dist_ma60'); // D60 = i 5..64
});

test('窗口有效值 80% 為界:20 天缺 4 天仍可算、缺 5 天為 null(停牌不可當 0)', () => {
  const s4 = series(25);
  for (const d of ['d10', 'd11', 'd12', 'd13']) { s4.price.delete(d); s4.inst.delete(d); }
  const f4 = computeFeatures(s4);
  assert.equal(f4.inst_buy_days_20, 16);
  assert.notEqual(f4.range_20, null);

  const s5 = series(25);
  for (const d of ['d10', 'd11', 'd12', 'd13', 'd14']) { s5.price.delete(d); s5.inst.delete(d); }
  const f5 = computeFeatures(s5);
  for (const k of ['inst_net_20', 'inst_net_20_pct', 'inst_buy_days_20', 'range_20', 'avg_value_20']) assert.equal(f5[k], null, k);
});

test('有收盤行情但沒有法人列 = 當天沒有法人交易,算 0 不算缺值(endpoints.md 覆蓋率結論)', () => {
  const s = series(25);
  for (const d of mkDays(25).slice(5, 15)) s.inst.delete(d); // 10 天沒有法人列,但價格都在
  const f = computeFeatures(s);
  assert.equal(f.inst_net_20, 10 * 400);
  assert.equal(f.inst_buy_days_20, 10);
});

test('t−20 缺值或分母為 0 時,變化率為 null(不可算成 −100% 或無限大)', () => {
  const s = series(25);
  s.margin.set('d05', { margin_balance: 0 });
  s.price.set('d05', { ...s.price.get('d05'), close: null });
  s.qfii.delete('d05');
  const f = computeFeatures(s);
  assert.equal(f.margin_chg_20, null);
  assert.equal(f.ret_20, null);
  assert.equal(f.foreign_ratio_chg_20, null);
});

test('沒有融資列(不可融資的股票)時融資特徵為 null,不可當成融資 0', () => {
  const s = series(25);
  s.margin = new Map();
  assert.equal(computeFeatures(s).margin_chg_20, null);
});

test('掃描日還沒有外資持股(晚於收盤公布)時,用窗口內最近一筆發行股數', () => {
  const s = series(25);
  s.qfii.delete('d25');
  near(computeFeatures(s).inst_net_20_pct, 0.8, 'inst_net_20_pct');
});

test('集保:連續週增週數、4 週變化;週數不足時為 null', () => {
  const w = (big400, holders, retail = 30) => ({ big400, big1000: big400 - 5, retail, holders });
  // 6 週:big400 50, 49, 50, 51, 52, 53 → 從最新往回連增 4 週
  const f = tdccFeatures([w(50, 1000), w(49, 1000, 31), w(50, 990), w(51, 980), w(52, 970), w(53, 950, 28)]);
  assert.equal(f.big400_up_weeks, 4);
  near(f.big400_chg_4w, 53 - 49, 'big400_chg_4w'); // 4 週前 = 往前第 4 筆
  near(f.holders_chg_4w_pct, 950 / 1000 - 1, 'holders_chg_4w_pct');
  near(f.retail_chg_4w, 28 - 31, 'retail_chg_4w');
  assert.equal(f.big400_pct, 53);
  assert.equal(f.tdcc_weeks, 6);

  const one = tdccFeatures([w(50, 1000)]);
  assert.equal(one.big400_up_weeks, null);
  assert.equal(one.big400_chg_4w, null);
  assert.equal(one.holders_chg_4w_pct, null);
  assert.equal(one.big400_pct, 50);

  assert.equal(tdccFeatures([w(50, 1000), w(50, 990)]).big400_up_weeks, 0); // 持平不算增加
  assert.equal(tdccFeatures([]).tdcc_weeks, 0);
});

test('價位與均線:MA、5 日均量、區間高低點由程式算好,下游報告不必讓模型心算', async () => {
  const { priceLevels } = await import('../lib/features.mjs');
  const s = series(65, { volOf: (i) => 1000 + i });
  const L = priceLevels(s);
  assert.equal(L.close, 164);
  assert.equal(L.prev_close, 163);
  near(L.ma5, (160 + 164) / 2, 'ma5');
  near(L.ma10, (155 + 164) / 2, 'ma10');
  near(L.ma20, (145 + 164) / 2, 'ma20');
  near(L.ma60, (105 + 164) / 2, 'ma60');
  assert.equal(L.volume, 1064);
  near(L.vol_ma5, (1060 + 1064) / 2, 'vol_ma5');
  assert.equal(L.high_20, 165); // close + 1
  assert.equal(L.low_20, 144); // D20 第一天 close 145 − 1
  assert.equal(L.high_60, 165);
  assert.equal(L.low_60, 104);
  // 四維燈號用的「不含當天」窗口:當天的量與最高價不能拿來跟自己比
  near(L.vol_ma5_prev, (1059 + 1063) / 2, 'vol_ma5_prev'); // i 59..63
  assert.equal(L.high_19_prev, 164); // H19:i 45..63,最高 close 163 + 1
  assert.equal(L.high_59_prev, 164); // i 5..63

  // 只有 25 天:60 日類為 null,不可用 25 天湊
  const short = priceLevels(series(25));
  assert.equal(short.ma60, null);
  assert.equal(short.high_60, null);
  assert.equal(short.high_59_prev, null);
  assert.notEqual(short.high_19_prev, null);
  assert.notEqual(short.ma20, null);
});

test('融資基數太小(t−20 < 100 張)時融資變化為 null,避免 3 張變 9 張被當成 +200%', () => {
  const s = series(25);
  s.margin.set('d05', { margin_balance: 99 });
  s.margin.set('d25', { margin_balance: 297 });
  assert.equal(computeFeatures(s).margin_chg_20, null);

  s.margin.set('d05', { margin_balance: 100 }); // 剛好達門檻就照算
  near(computeFeatures(s).margin_chg_20, 297 / 100 - 1, 'margin_chg_20');
});

test('近 5 日法人(外資+投信)合計:四維籌碼燈第 3 條', () => {
  const s = series(25);
  assert.equal(computeFeatures(s).inst_net_5, 5 * 400);
  s.inst.set('d25', { foreign_net: -5000, trust_net: 0, dealer_net: 0 });
  assert.equal(computeFeatures(s).inst_net_5, 4 * 400 - 5000);
});

// ---- 出貨規格 §6 新增特徵 ----

test('inst_sell_days_20:D20 中外資+投信 < 0 的天數,0 不算賣(和 inst_buy_days_20 對稱)', () => {
  const s = series(25);
  mkDays(25).slice(5).forEach((d, i) => s.inst.set(d, { foreign_net: i % 4 === 0 ? 0 : i % 2 ? -300 : 300, trust_net: 0, dealer_net: 0 }));
  // i = 0..19:i%4==0 → 0(5 天)、奇數 → 賣(10 天)、其餘 → 買(5 天)
  const f = computeFeatures(s);
  assert.equal(f.inst_sell_days_20, 10);
  assert.equal(f.inst_buy_days_20, 5);
});

test('inst_sell_days_20:窗口有效值不足 80% 時為 null(停牌不可當成沒賣)', () => {
  const s = series(25);
  for (const d of ['d10', 'd11', 'd12', 'd13', 'd14']) { s.price.delete(d); s.inst.delete(d); }
  assert.equal(computeFeatures(s).inst_sell_days_20, null);
});

test('big400_down_weeks:從最新一週往回連續週減的週數,持平就中斷', () => {
  const w = (big400) => ({ big400, big1000: 0, retail: 0, holders: 1 });
  assert.equal(tdccFeatures([w(54), w(53), w(52), w(51)]).big400_down_weeks, 3);
  assert.equal(tdccFeatures([w(50), w(53), w(52), w(51)]).big400_down_weeks, 2, "53 之前是 50,連減在那裡中斷");
  assert.equal(tdccFeatures([w(53), w(52), w(52), w(51)]).big400_down_weeks, 1, '持平不算減少');
  assert.equal(tdccFeatures([w(50), w(51)]).big400_down_weeks, 0);
  assert.equal(tdccFeatures([w(50)]).big400_down_weeks, null, '只有一週無法判斷');
});

test('drawdown_60:close(t) ÷ D60 最高價 − 1;在高點為 0 附近、不足 60 天為 null', () => {
  near(computeFeatures(series(65)).drawdown_60, 164 / 165 - 1, 'drawdown_60'); // 上漲序列:高點是 close(t)+1
  // 前段漲到 200,之後跌回 150:回落 = 150 / 201 − 1
  const s = series(65, { closeOf: (i) => (i === 30 ? 200 : 150) });
  near(computeFeatures(s).drawdown_60, 150 / 201 - 1, 'drawdown_60');
  assert.equal(computeFeatures(series(59)).drawdown_60, null);
});

test('below_ma20:收盤低於 MA20 為 true;等於不算;MA20 或當日收盤缺值時為 null', () => {
  assert.equal(computeFeatures(series(25)).below_ma20, false); // 上漲序列 close(t) > MA20
  assert.equal(computeFeatures(series(25, { closeOf: (i) => 200 - i })).below_ma20, true);
  assert.equal(computeFeatures(series(25, { closeOf: () => 100 })).below_ma20, false, '等於 MA20 不算跌破');
  assert.equal(computeFeatures(series(19)).below_ma20, null);
  const s = series(25);
  s.price.set('d25', { ...s.price.get('d25'), close: null });
  assert.equal(computeFeatures(s).below_ma20, null, '當日無收盤不可當成跌破');
});

// 帶量長黑測試用序列:平盤量 1000、收盤 100;在 at 那天放一根 K 棒
function dumpSeries(n, at, bar) {
  const s = series(n, { closeOf: () => 100 });
  for (const d of s.days) s.price.set(d, { open: 100, high: 101, low: 99, close: 100, volume: 1000, value: 100000 });
  if (at) s.price.set(at, { high: 101, low: 90, value: 0, ...bar });
  return s;
}

test('dump_days_20:量 = 前 5 日均量 × 1.5、收黑、跌 4% → 算一天', () => {
  assert.equal(computeFeatures(dumpSeries(25, 'd20', { open: 100, close: 96, volume: 1500 })).dump_days_20, 1);
});

test('dump_days_20:「前 5 日」不含當天(含當天的話基準被自己的大量墊高,1500 < 1100 × 1.5 會漏算)', () => {
  // 前 5 日均量 1000 → 門檻 1500;若錯把當天算進去:(4×1000 + 1500)/5 = 1100 → 門檻 1650,這根就不會算
  assert.equal(computeFeatures(dumpSeries(25, 'd20', { open: 100, close: 96, volume: 1500 })).dump_days_20, 1);
  assert.equal(computeFeatures(dumpSeries(25, 'd20', { open: 100, close: 96, volume: 1499 })).dump_days_20, 0);
});

test('dump_days_20:收平或收紅不算;跌幅不到 3% 不算', () => {
  assert.equal(computeFeatures(dumpSeries(25, 'd20', { open: 96, close: 96, volume: 3000 })).dump_days_20, 0, '收平(close = open)');
  assert.equal(computeFeatures(dumpSeries(25, 'd20', { open: 90, close: 96, volume: 3000 })).dump_days_20, 0, '跳空低開收紅');
  assert.equal(computeFeatures(dumpSeries(25, 'd20', { open: 100, close: 98, volume: 3000 })).dump_days_20, 0, '只跌 2%');
});

test('dump_days_20:只看 D20,更早的長黑不算', () => {
  assert.equal(computeFeatures(dumpSeries(25, 'd05', { open: 100, close: 90, volume: 5000 })).dump_days_20, 0);
});

test('dump_days_20:可判斷的天數不足 80% 時為 null(每天要有前 5 日均量,20 天資料只有 15 天可判斷)', () => {
  assert.equal(computeFeatures(dumpSeries(21)).dump_days_20, 0); // D20 = i 1..20,i ≥ 5 才有前 5 日 → 16 天 = 80%
  assert.equal(computeFeatures(dumpSeries(20)).dump_days_20, null); // 15 天 < 80%
  const s = dumpSeries(25);
  for (const d of ['d10', 'd11', 'd12', 'd13', 'd14']) s.price.delete(d); // 停牌 5 天
  assert.equal(computeFeatures(s).dump_days_20, null);
});
