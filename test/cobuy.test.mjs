import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cobuy } from '../lib/cobuy.mjs';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/data-json.json', import.meta.url), 'utf8'));

// 載入網頁 docs/app.js 的 compute()(不執行 load()),作為「正確答案」
function pageCompute(data, { days, streak, insts, markets }) {
  const src = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8').replace(/\nload\(\);\s*$/, '\n');
  return new Function('data', 'opts', `${src}
    state.data = data;
    state.sumDays = opts.days; state.streakDays = opts.streak;
    state.markets = { TWSE: opts.markets.includes('TWSE'), TPEX: opts.markets.includes('TPEX') };
    state.insts = { foreign: opts.insts.includes('foreign'), trust: opts.insts.includes('trust'), dealer: opts.insts.includes('dealer') };
    return compute();`)(data, { days, streak, insts, markets });
}

const summary = (rows) => rows.map((r) => [r.code, r.foreignSum ?? r.foreign_sum, r.trustSum ?? r.trust_sum, r.dealerSum ?? r.dealer_sum,
  r.foreignStreak ?? r.foreign_streak, r.trustStreak ?? r.trust_streak, r.dealerStreak ?? r.dealer_streak].join(',')).sort();

test('API 篩選結果與網頁 compute() 完全相同(Hermes 拿到的清單必須等於使用者在網頁上看到的)', () => {
  const data = fixture();
  const instSets = [['foreign'], ['trust'], ['dealer'], ['foreign', 'dealer'], ['foreign', 'trust'], ['foreign', 'trust', 'dealer'], []];
  const marketSets = [['TWSE', 'TPEX'], ['TWSE'], ['TPEX']];
  let compared = 0, nonEmpty = 0;
  for (const insts of instSets) for (const markets of marketSets) for (const [days, streak] of [[10, 5], [5, 3], [10, 1], [3, 3], [1, 1], [99, 99]]) {
    const opts = { days, streak, insts, markets };
    const expected = summary(pageCompute(data, opts));
    assert.deepEqual(summary(cobuy(data, opts)), expected, JSON.stringify(opts));
    compared++; if (expected.length) nonEmpty++;
  }
  assert.ok(nonEmpty > compared / 3, `大多數組合應有符合個股,比對才有意義 (${nonEmpty}/${compared})`);
});

test('舊版 data.json 沒有 trust_daily 時視為 0(與網頁相同),勾投信就不會符合', () => {
  const data = fixture();
  for (const s of data.stocks) delete s.trust_daily;
  const opts = { days: 10, streak: 1, insts: ['foreign', 'trust'], markets: ['TWSE', 'TPEX'] };
  assert.deepEqual(cobuy(data, opts), []);
  assert.deepEqual(summary(cobuy(data, opts)), summary(pageCompute(data, opts)));
});
