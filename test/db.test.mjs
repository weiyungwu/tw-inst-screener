import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, writeInstDay, hasTwseFp, completeDates, writeSblDay, sblFinal, sblMinRows, sblOverIssued, writeDailyRows } from '../lib/db.mjs';

const day = (twse, tpex, fp = 1) => ({ twse: new Map(Object.entries(twse)), tpex: new Map(Object.entries(tpex)), fp });
const v = (name, foreign, trust = 0, dealer = 0) => ({ name, foreign, trust, dealer });
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

test('同一天重跑不重複寫入,數值以最新抓到的為準(18:00 與 20:00 兩次排程都可能寫同一天)', () => {
  const db = openDb();
  writeInstDay(db, '2026-10-06', day({ 2330: v('台積電', -100) }, { 5347: v('世界', 200) }));
  writeInstDay(db, '2026-10-06', day({ 2330: v('台積電', -100) }, { 5347: v('世界', 200) }));
  assert.equal(count(db, 'inst_daily'), 2);
  assert.equal(count(db, 'stocks'), 2);
  assert.equal(count(db, 'trading_days'), 1);

  writeInstDay(db, '2026-10-06', day({ 2330: v('台積電', -999) }, { 5347: v('世界', 200) }));
  assert.equal(db.prepare("SELECT foreign_net FROM inst_daily WHERE code = '2330'").get().foreign_net, -999);
  assert.deepEqual([...completeDates(db)], ['2026-10-06']);
});

test('backfill 舊日期不可蓋掉較新的股票名稱(公司改名後應顯示新名)', () => {
  const db = openDb();
  writeInstDay(db, '2026-10-06', day({ 1234: v('新名', 1) }, {}));
  writeInstDay(db, '2026-09-01', day({ 1234: v('舊名', 1) }, {}, 2));
  assert.equal(db.prepare("SELECT name FROM stocks WHERE code = '1234'").get().name, '新名');
  writeInstDay(db, '2026-10-07', day({ 1234: v('更新名', 1) }, {}, 3));
  assert.equal(db.prepare("SELECT name FROM stocks WHERE code = '1234'").get().name, '更新名');
});

test('TWSE 指紋只跟「其他日期」比對:別天相同代表重複資料,同一天重跑不算', () => {
  const db = openDb();
  writeInstDay(db, '2026-10-05', day({ 2330: v('台積電', 1) }, {}, 777));
  assert.equal(hasTwseFp(db, 777, '2026-10-06'), true);
  assert.equal(hasTwseFp(db, 777, '2026-10-05'), false);
  assert.equal(hasTwseFp(db, 778, '2026-10-06'), false);
});

test('寫入中途失敗整批 rollback,該日不可被標成完整(否則之後永遠不會補抓)', () => {
  const db = openDb();
  const bad = day({ 2330: v('台積電', 1), 9999: v(null, 1) }, {}); // name NOT NULL → 第二筆失敗(整數 key 依數值排序)
  assert.throws(() => writeInstDay(db, '2026-10-06', bad));
  assert.equal(count(db, 'inst_daily'), 0);
  assert.equal(completeDates(db).size, 0);
});

test('price/margin/qfii 寫入冪等,且依市場判斷是否已有資料(上市失敗、上櫃成功時只補上市)', async () => {
  const { writeDailyRows, hasMarketRows } = await import('../lib/db.mjs');
  const db = openDb();
  writeInstDay(db, '2026-10-06', day({ 2330: v('台積電', 1) }, { 5347: v('世界', 1) }));
  const cols = ['open', 'high', 'low', 'close', 'volume', 'value'];
  const tpex = new Map([['5347', { open: 184.5, high: 195, low: 184.5, close: 191, volume: 33208000, value: 6341293500 }]]);
  writeDailyRows(db, 'price_daily', cols, '2026-10-06', tpex);
  writeDailyRows(db, 'price_daily', cols, '2026-10-06', tpex);
  assert.equal(count(db, 'price_daily'), 1);
  assert.equal(hasMarketRows(db, 'price_daily', '2026-10-06', 'TPEX'), true);
  assert.equal(hasMarketRows(db, 'price_daily', '2026-10-06', 'TWSE'), false);

  const halt = new Map([['2330', { open: null, high: null, low: null, close: null, volume: 0, value: 0 }]]);
  writeDailyRows(db, 'price_daily', cols, '2026-10-06', halt);
  assert.equal(db.prepare("SELECT close FROM price_daily WHERE code = '2330'").get().close, null);
});

const sbl = (entries) => new Map(Object.entries(entries).map(([code, [b, s, r]]) => [code, { sbl_balance: b, sbl_sell: s, sbl_return: r }]));
const sblRow = (db, code) => db.prepare('SELECT * FROM sbl_daily WHERE date = ? AND code = ?').get('2026-10-15', code);
const revisedLogs = (db) => db.prepare("SELECT source, rows FROM ingest_log WHERE message = 'sbl revised'").all().map((r) => ({ ...r }));

test('sbl: 相同數值重抓不動 fetched_at(回測要知道資料「最早」何時可取得,22:45 重跑不可把時間往後推)', () => {
  const db = openDb();
  assert.deepEqual(writeSblDay(db, '2026-10-15', 'TWSE', sbl({ 2330: [12797514, 785000, 39000] }), '2026-10-15 20:35:00'), { written: 1, revised: 0, crossMarket: 0 });
  assert.deepEqual(writeSblDay(db, '2026-10-15', 'TWSE', sbl({ 2330: [12797514, 785000, 39000] }), '2026-10-15 22:45:00'), { written: 0, revised: 0, crossMarket: 0 });
  assert.equal(sblRow(db, '2330').fetched_at, '2026-10-15 20:35:00');
  assert.deepEqual(revisedLogs(db), []);
});

test('sbl: 數值被官方修正時更新數值與 fetched_at,並記 sbl revised(否則看不出 20:30 與 22:30 版本不同)', () => {
  const db = openDb();
  writeSblDay(db, '2026-10-15', 'TWSE', sbl({ 2330: [100, 10, 0], 2317: [200, 0, 0] }), '2026-10-15 20:35:00');
  const r = writeSblDay(db, '2026-10-15', 'TWSE', sbl({ 2330: [150, 60, 0], 2317: [200, 0, 0] }), '2026-10-15 22:45:00');
  assert.deepEqual(r, { written: 1, revised: 1, crossMarket: 0 });
  assert.equal(sblRow(db, '2330').sbl_balance, 150);
  assert.equal(sblRow(db, '2330').fetched_at, '2026-10-15 22:45:00');
  assert.equal(sblRow(db, '2317').fetched_at, '2026-10-15 20:35:00');
  assert.deepEqual(revisedLogs(db), [{ source: 'twse-sbl', rows: 1 }]);
});

test('sbl: 新增的代號不算修正(22:30 才納入的轉上市股是第一次寫入,不是官方改數字)', () => {
  const db = openDb();
  writeSblDay(db, '2026-10-15', 'TWSE', sbl({ 2330: [100, 0, 0] }), '2026-10-15 20:35:00');
  assert.deepEqual(writeSblDay(db, '2026-10-15', 'TWSE', sbl({ 2330: [100, 0, 0], 6488: [5, 5, 0] }), '2026-10-15 22:45:00'), { written: 1, revised: 0, crossMarket: 0 });
  assert.equal(sblRow(db, '6488').fetched_at, '2026-10-15 22:45:00');
  assert.deepEqual(revisedLogs(db), []);
});

test('sbl: 同一天兩市場都有同一檔時以上櫃為準(TWSE 22:30 版會先列入次日轉上市的上櫃股,t 日實際在上櫃交易)', () => {
  // 上市先寫入(ingest 的順序):上櫃覆蓋,不算修正
  const db = openDb();
  const r1 = writeSblDay(db, '2026-10-15', 'TWSE', sbl({ 2330: [1, 0, 0], 8908: [427109, 0, 0] }), '2026-10-15 22:45:00');
  const r2 = writeSblDay(db, '2026-10-15', 'TPEX', sbl({ 8908: [427109, 0, 0] }), '2026-10-15 22:45:00');
  assert.deepEqual([r1.crossMarket, r2], [0, { written: 1, revised: 0, crossMarket: 1 }]);
  assert.equal(sblRow(db, '8908').market, 'TPEX');
  // 上櫃已經有(例如之後重抓上市):上市那筆略過
  const r3 = writeSblDay(db, '2026-10-15', 'TWSE', sbl({ 2330: [1, 0, 0], 8908: [427109, 0, 0] }), '2026-10-16 18:00:00');
  assert.deepEqual(r3, { written: 0, revised: 0, crossMarket: 1 });
  assert.equal(sblRow(db, '8908').market, 'TPEX');
  assert.deepEqual(revisedLogs(db), []);
});

test('sbl: 寫入中途失敗整批 rollback,也不留下 revised 紀錄', () => {
  const db = openDb();
  writeSblDay(db, '2026-10-15', 'TWSE', sbl({ 2330: [100, 0, 0] }), '2026-10-15 20:35:00');
  const bad = sbl({ 2330: [999, 0, 0] });
  bad.set('2317', { sbl_balance: 1, sbl_sell: 0, sbl_return: 0 });
  assert.throws(() => writeSblDay(db, '2026-10-15', 'XXX', bad, '2026-10-15 22:45:00'));
  assert.equal(sblRow(db, '2330').sbl_balance, 100);
  assert.equal(sblRow(db, '2317'), undefined);
  assert.deepEqual(revisedLogs(db), []);
});

test('sbl: 22:30 前抓到的是 20:30 版,不算完整(GitHub 備援排程延遲時,22:45 還要重抓才拿得到轉上市股)', () => {
  const db = openDb();
  assert.equal(sblFinal(db, '2026-10-15', 'TWSE'), false);
  writeSblDay(db, '2026-10-15', 'TWSE', sbl({ 2330: [100, 0, 0] }), '2026-10-15 20:40:00');
  assert.equal(sblFinal(db, '2026-10-15', 'TWSE'), false);
  writeSblDay(db, '2026-10-15', 'TWSE', sbl({ 2330: [100, 0, 0], 6488: [5, 5, 0] }), '2026-10-15 22:45:00');
  assert.equal(sblFinal(db, '2026-10-15', 'TWSE'), true);
  assert.equal(sblFinal(db, '2026-10-15', 'TPEX'), false, '市場分開判斷');
  writeSblDay(db, '2026-10-14', 'TPEX', sbl({ 5347: [1, 1, 0] }), '2026-10-16 17:00:00');
  assert.equal(sblFinal(db, '2026-10-14', 'TPEX'), true, '回補(隔天以後抓)一定是最終版');
});

test('sbl: 列數下限用「有行情」的檔數,不用 stocks(下市股留在 stocks 會讓分母逐年變大)', () => {
  const db = openDb();
  writeInstDay(db, '2026-10-14', day({ 2330: v('台積電', 1), 2317: v('鴻海', 1), 9999: v('已下市', 1) }, { 5347: v('世界', 1) }));
  const px = (codes) => new Map(codes.map((c) => [c, { open: 1, high: 1, low: 1, close: 1, volume: 1, value: 1 }]));
  writeDailyRows(db, 'price_daily', ['open', 'high', 'low', 'close', 'volume', 'value'], '2026-10-14', px(['2330', '2317', '5347']));
  assert.equal(sblMinRows(db, '2026-10-14', 'TWSE'), 2 * 0.8);
  assert.equal(sblMinRows(db, '2026-10-15', 'TWSE'), 2 * 0.8, '當天還沒有行情時用前一天');
  assert.equal(sblMinRows(db, '2026-10-13', 'TWSE'), null, '沒有行情可參考時不可回傳 0(等於不檢查)');
});

test('sbl: 超過發行股數只挑出來警告,沒有發行股數的不算', () => {
  const db = openDb();
  writeDailyRows(db, 'qfii_daily', ['issued_shares', 'foreign_shares', 'foreign_ratio'], '2026-10-15', new Map([
    ['2330', { issued_shares: 1000, foreign_shares: 1, foreign_ratio: 1 }], ['2317', { issued_shares: 1000, foreign_shares: 1, foreign_ratio: 1 }]]));
  assert.deepEqual(sblOverIssued(db, '2026-10-15', sbl({ 2330: [1001, 0, 0], 2317: [1000, 0, 0], 5347: [9e9, 0, 0] })), ['2330']);
});

test('sbl: parser 附帶的標記(reset_by_halt)不寫進 DB,只寫三個數值欄位', () => {
  const db = openDb();
  const m = new Map([['2323', { sbl_balance: 0, sbl_sell: 0, sbl_return: 0, reset_by_halt: true }]]);
  assert.deepEqual(writeSblDay(db, '2026-10-15', 'TWSE', m, '2026-10-16 18:00:00'), { written: 1, revised: 0, crossMarket: 0 });
  assert.equal(sblRow(db, '2323').sbl_balance, 0);
});
