import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardReturn } from '../lib/forward.mjs';

const days = Array.from({ length: 10 }, (_, i) => `d${String(i + 1).padStart(2, '0')}`); // d01..d10
const near = (a, b, msg) => assert.ok(a != null && Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);

// 每天 open = 100 + i、high = open + 5、close = open + 1
function px(from = 0, to = 9) {
  const m = new Map();
  for (let i = from; i <= to; i++) m.set(days[i], { open: 100 + i, high: 105 + i, close: 101 + i });
  return m;
}
const fr = (o) => forwardReturn({ days, t: 'd02', n: 3, price: px(), ...o });

test('從 t+1 開盤進場(t 收盤時還不知道出貨分數):ret = close(t+N) ÷ open(t+1) − 1', () => {
  const r = fr({});
  // t = d02(i=1) → t+1 = d03 開 102;t+3 = d05 收 105;期間最高 d05 high 109
  assert.equal(r.status, 'valid');
  near(r.ret, 105 / 102 - 1, 'ret');
  near(r.mae, 109 / 102 - 1, 'mae');
  assert.equal(r.market_changed, false);
});

test('not_matured:t+N 晚於 DB 最新交易日(期間還沒走完,不是個股的問題)', () => {
  assert.equal(fr({ t: 'd08' }).status, 'not_matured'); // d08 + 3 = d11 不存在
  assert.equal(fr({ t: 'd07' }).status, 'valid'); // 剛好走到 d10
});

test('delisted:t+N 前中斷且之後沒再出現 → 缺值,不可算成 0 報酬或用最後收盤價補', () => {
  const r = fr({ price: px(0, 3) }); // 最後一筆 d04 < t+3 = d05
  assert.deepEqual(r, { status: 'delisted' });
  assert.equal(r.ret, undefined);
});

test('no_entry:t+1 沒有開盤價(停牌或無成交)', () => {
  const p = px();
  p.set('d03', { open: null, high: null, close: null });
  assert.equal(fr({ price: p }).status, 'no_entry');
});

test('suspended:期間內某天有資料列但沒有收盤價,之後恢復交易', () => {
  const p = px();
  p.set('d04', { open: null, high: null, close: null });
  assert.equal(fr({ price: p }).status, 'suspended');
  const q = px();
  q.set('d05', { open: 104, high: null, close: 105 });
  assert.equal(fr({ price: q }).status, 'suspended', '最大不利變動也要有每天的最高價');
});

test('other_missing:期間內某天沒有資料列但之後又出現(停牌股仍有資料列,沒有列代表漏抓)', () => {
  const p = px();
  p.delete('d04');
  assert.equal(fr({ price: p }).status, 'other_missing');
});

test('market_changed:期間內換市場但價格連續 → 照常計算報酬,另外標示', () => {
  const r = fr({ marketT: 'TPEX', markets: new Map([['d02', 'TPEX'], ['d04', 'TWSE']]) });
  assert.equal(r.status, 'valid');
  assert.equal(r.market_changed, true);
  near(r.ret, 105 / 102 - 1, 'ret');
});

test('market_changed 且價格中斷 → other_missing(轉市場當天的行情漏抓),不歸為停牌', () => {
  const p = px();
  p.set('d04', { open: null, high: null, close: null });
  const r = fr({ price: p, marketT: 'TPEX', markets: new Map([['d04', 'TWSE']]) });
  assert.deepEqual(r, { status: 'other_missing', market_changed: true });
});

test('t 之前的市場資料不算換市場', () => {
  assert.equal(fr({ marketT: 'TWSE', markets: new Map([['d01', 'TPEX'], ['d03', 'TWSE']]) }).market_changed, false);
});
