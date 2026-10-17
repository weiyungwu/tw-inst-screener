import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// docs/dist.js 是瀏覽器腳本,只匯出提示判斷給測試用
const { warnings } = createRequire(import.meta.url)('../docs/dist.js');

const NOW = Date.parse('2026-10-17T09:00:00+08:00');
const dist = (o = {}) => ({ scan_date: '2026-10-16', run_id: 'A', updated_at: '2026-10-16T22:50:00+08:00', sbl_status: { TWSE: 'ok', TPEX: 'ok' }, quality: null, ...o });
const scan = (o = {}) => ({ scan_date: '2026-10-16', run_id: 'A', ...o });

test('完全一致時不顯示任何提示(提示太多會讓使用者忽略真正的問題)', () => {
  assert.deepEqual(warnings(dist(), scan(), NOW), []);
});

test('出貨結果落後:dist.json 的 scan_date 早於 scan.json(出貨評分或上傳失敗,§5.2)', () => {
  assert.deepEqual(warnings(dist({ scan_date: '2026-10-15' }), scan(), NOW), ['出貨結果停在 2026-10-15,尚未更新到最新交易日。']);
});

test('版本不一致:scan_date 相同但 run_id 不同(R2 更新到一半)', () => {
  assert.deepEqual(warnings(dist(), scan({ run_id: 'B' }), NOW), ['吸籌與出貨結果來自不同次更新,可能有一項更新失敗。']);
});

test('借券延遲依市場分開提示,只缺上櫃就只寫上櫃', () => {
  assert.deepEqual(warnings(dist({ sbl_status: { TWSE: 'ok', TPEX: 'pending' } }), scan(), NOW), ['今日上櫃借券資料約 22:45 更新,信用與借券分數未計入。']);
  assert.deepEqual(warnings(dist({ sbl_status: { TWSE: 'pending', TPEX: 'pending' } }), scan(), NOW), ['今日上市、上櫃借券資料約 22:45 更新,信用與借券分數未計入。']);
});

test('資料過舊以 4 天為界(三天連假不誤報)', () => {
  assert.deepEqual(warnings(dist({ updated_at: '2026-10-13T09:00:01+08:00' }), scan(), NOW), []);
  assert.deepEqual(warnings(dist({ updated_at: '2026-10-13T08:59:59+08:00' }), scan(), NOW), ['資料超過 4 天未更新,排程可能已停止。']);
});

test('多種狀況同時成立時全部顯示', () => {
  assert.equal(warnings(dist({ scan_date: '2026-10-15', sbl_status: { TWSE: 'pending', TPEX: 'ok' }, updated_at: '2026-10-01T00:00:00+08:00' }), scan(), NOW).length, 3);
});
