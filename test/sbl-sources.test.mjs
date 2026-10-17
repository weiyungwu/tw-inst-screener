import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTwseSbl } from '../lib/sources/twse-sbl.mjs';
import { parseTpexSbl } from '../lib/sources/tpex-sbl.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const D = '20261015';
const MIN = 3; // fixture 各有 3 檔普通股

// 兩市場共用的異常情境:rows(j) 取出主表資料列,fields(j) 取出欄名陣列
const MARKETS = [
  { name: 'twse-sbl', parse: parseTwseSbl, file: 'twse-sbl.json', rows: (j) => j.data, table: (j) => j, etf: '0050' },
  { name: 'tpex-sbl', parse: parseTpexSbl, file: 'tpex-sbl.json', rows: (j) => j.tables[0].data, table: (j) => j.tables[0], etf: '006201' },
];
const row = (rows, code) => rows.find((r) => String(r[0]).trim() === code);

// 預期值直接抄自 fixture 原始字串(2026-10-15 實際回應),不從解析器推導

test('twse-sbl: 取借券「當日餘額」(idx 12),不是融券的今日餘額(idx 6),單位為股', () => {
  const m = parseTwseSbl(fixture('twse-sbl.json'), D, MIN);
  assert.deepEqual(m.get('2330'), { sbl_balance: 12797514, sbl_sell: 785000, sbl_return: 39000 });
  assert.equal(m.size, 3);
  for (const code of ['0050', '00878', '00400A']) assert.equal(m.has(code), false, code);
});

test('tpex-sbl: 讀 tables[0],欄名和上市不同但位置相同', () => {
  const m = parseTpexSbl(fixture('tpex-sbl.json'), D, MIN);
  assert.deepEqual(m.get('5347'), { sbl_balance: 31705886, sbl_sell: 1286000, sbl_return: 1939000 });
  assert.equal(m.get('6488').sbl_balance, 17000000);
  for (const code of ['006201', '00679B']) assert.equal(m.has(code), false, code);
});

test('休市或尚未公布(空表)回傳 null,讓 ingest 記 empty 而不是寫入 0 列', () => {
  const twse = fixture('twse-sbl.json');
  twse.data = [];
  assert.equal(parseTwseSbl(twse, D, MIN), null);
  const tpex = fixture('tpex-sbl.json');
  tpex.tables[0].data = []; tpex.tables[0].totalCount = 0;
  assert.equal(parseTpexSbl(tpex, D, MIN), null);
});

for (const mk of MARKETS) {
  const bad = (mutate, minRows = MIN) => {
    const j = fixture(mk.file);
    mutate(j);
    return () => mk.parse(j, D, minRows);
  };

  test(`${mk.name}: 欄名改版時報錯,不可依舊位置默默存錯`, () => {
    assert.throws(bad((j) => { mk.table(j).fields[12] = '次一營業日可限額'; }), /欄位 12/);
  });

  test(`${mk.name}: 主表標題不符時報錯`, () => {
    assert.throws(bad((j) => { mk.table(j).title = '融資融券彙總'; }), /主表標題/);
  });

  test(`${mk.name}: 逐列勾稽,只有一列錯位也要整批報錯(只驗第一列會漏掉截斷或單列位移)`, () => {
    assert.throws(bad((j) => { const r = mk.rows(j).at(-1); [r[8], r[12]] = [r[12], r[8]]; }), /勾稽不符/);
  });

  test(`${mk.name}: ETF 列不存,但一樣要通過勾稽(用來偵測整張表錯位)`, () => {
    assert.throws(bad((j) => { row(mk.rows(j), mk.etf)[12] = '1'; }), /勾稽不符/);
  });

  test(`${mk.name}: 普通股列數不足時報錯(HTTP 200 但只有部分資料)`, () => {
    assert.throws(bad(() => {}, MIN + 1), /回應可能不完整/);
  });

  test(`${mk.name}: 沒有給 minRows 時報錯,不可默默跳過列數檢查`, () => {
    assert.throws(() => mk.parse(fixture(mk.file), D), /缺少 minRows/);
  });

  test(`${mk.name}: 餘額為負時報錯(即使勾稽成立)`, () => {
    assert.throws(bad((j) => { const r = mk.rows(j)[0]; r[8] = '-100'; r[9] = r[10] = r[11] = '0'; r[12] = '-100'; }), /餘額為負/);
  });

  test(`${mk.name}: 同一代號出現兩次時報錯(否則後一列會蓋掉前一列)`, () => {
    assert.throws(bad((j) => { const rows = mk.rows(j); rows.push([...rows.at(-1)]); }), /重複/);
  });

  test(`${mk.name}: 借券欄位是 -- 時報錯,不可當 0 參與勾稽`, () => {
    assert.throws(bad((j) => { mk.rows(j).at(-1)[11] = '--'; }), /不是整數/);
  });

  test(`${mk.name}: 當日調整是加項(負數調整可通過);10/15 實測調整全為 0,正負號靠這個測試固定`, () => {
    const j = fixture(mk.file);
    const r = mk.rows(j).at(-1);
    r[8] = '1,000'; r[9] = '500'; r[10] = '200'; r[11] = '-300'; r[12] = '1,000';
    assert.equal(mk.parse(j, D, MIN).get(String(r[0]).trim()).sbl_balance, 1000);
  });

  test(`${mk.name}: 停止買賣(備註含 !)當天餘額被清空、不記在還券或調整 → 照公布的 0 收下並標記(否則整個市場當天都沒有借券資料)`, () => {
    const j = fixture(mk.file);
    const r = mk.rows(j).at(-1);
    r[8] = '109,000'; r[9] = r[10] = r[11] = r[12] = '0'; r[14] = 'V!';
    assert.deepEqual(mk.parse(j, D, MIN).get(String(r[0]).trim()), { sbl_balance: 0, sbl_sell: 0, sbl_return: 0, reset_by_halt: true });
  });

  test(`${mk.name}: 例外只限「含 ! 且餘額為 0」,其餘不符照樣擋下`, () => {
    assert.throws(bad((j) => { const r = mk.rows(j).at(-1); r[8] = '109,000'; r[9] = r[10] = r[11] = r[12] = '0'; r[14] = 'X'; }), /勾稽不符/, '沒有 !');
    assert.throws(bad((j) => { const r = mk.rows(j).at(-1); r[8] = '109,000'; r[9] = r[10] = r[11] = '0'; r[12] = '5'; r[14] = 'X!'; }), /勾稽不符/, '餘額不是 0');
  });

  test(`${mk.name}: 合計列(代號為空)不檢查勾稽(它的差額來自例外列)`, () => {
    const j = fixture(mk.file);
    mk.rows(j).push(['', '合計', '0', '0', '0', '0', '0', '0', '100', '0', '0', '0', '0', '0', ' ']);
    assert.equal(mk.parse(j, D, MIN).size, 3);
  });

  test(`${mk.name}: 回應日期與要求不同時報錯`, () => {
    assert.throws(() => mk.parse(fixture(mk.file), '20261014', MIN), /不符/);
  });
}
