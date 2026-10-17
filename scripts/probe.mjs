// ===========================================================================
// probe.mjs — P0 端點探測:對每個來源的候選端點依序發請求,第一個有資料的即採用。
//             印出 HTTP 狀態、欄位/表頭、前 3 筆;完整回應存 data/probe/,
//             裁剪版(保留結構 + 代表性代號)存 test/fixtures/ 供解析器測試。
//
// 執行:  TZ=Asia/Taipei node scripts/probe.mjs [YYYY-MM-DD] [source ...]
//        日期省略時以 TPEX 法人資料往回找最近一個交易日
// ===========================================================================
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchText } from '../lib/http.mjs';
import { ymd, slash, roc, iso, todayTaipei, isWeekend } from '../lib/dates.mjs';
import { fetchTpexInst } from '../lib/sources/tpex-inst.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = join(ROOT, 'data', 'probe');
const FIXTURE_DIR = join(ROOT, 'test', 'fixtures');

// 裁剪 fixture 時保留的代號:上市普通股、上櫃普通股、ETF、債券 ETF
const KEEP_CODES = new Set(['2330', '2317', '1101', '0050', '00878', '5347', '6488', '8299', '006201', '00679B']);
const KEEP_FIRST = 5;

const SOURCES = {
  'twse-inst': (d) => [`https://www.twse.com.tw/fund/T86?response=json&date=${ymd(d)}&selectType=ALL`],
  'tpex-inst': (d) => [`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${slash(d)}&response=json`],
  'twse-price': (d) => [
    `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${ymd(d)}&type=ALLBUT0999`,
    `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&date=${ymd(d)}&type=ALLBUT0999`,
  ],
  'tpex-price': (d) => [
    `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${slash(d)}&type=EW&response=json`,
    `https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&o=json&d=${roc(d)}&se=EW`,
  ],
  'twse-margin': (d) => [
    `https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date=${ymd(d)}&selectType=ALL`,
    `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&date=${ymd(d)}&selectType=ALL`,
  ],
  'tpex-margin': (d) => [
    `https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${slash(d)}&response=json`,
    `https://www.tpex.org.tw/web/stock/margin_trading/margin_balance/margin_bal_result.php?l=zh-tw&o=json&d=${roc(d)}`,
  ],
  'twse-qfii': (d) => [
    `https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?response=json&date=${ymd(d)}&selectType=ALLBUT0999`,
    `https://www.twse.com.tw/fund/MI_QFIIS?response=json&date=${ymd(d)}&selectType=ALLBUT0999`,
  ],
  'tpex-qfii': (d) => [
    `https://www.tpex.org.tw/www/zh-tw/insti/qfii?date=${slash(d)}&response=json`,
    `https://www.tpex.org.tw/web/stock/3insti/qfii/qfii_result.php?l=zh-tw&o=json&d=${roc(d)}`,
    `https://www.tpex.org.tw/web/stock/3insti/qfii/qfii_result.php?l=zh-tw&o=data&d=${roc(d)}`,
  ],
  'twse-sbl': (d) => [`https://www.twse.com.tw/exchangeReport/TWT93U?response=json&date=${ymd(d)}`],
  'tpex-sbl': (d) => [`https://www.tpex.org.tw/www/zh-tw/margin/sbl?date=${slash(d)}&response=json`],
  tdcc: () => ['https://opendata.tdcc.com.tw/getOD.ashx?id=1-5'],
};

// 把各種回應形狀統一成 [{ title, fields, rows }]
function tablesOf(body) {
  let j;
  try { j = JSON.parse(body); } catch {
    const lines = body.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    return { kind: 'csv', tables: [{ title: 'csv', fields: lines[0]?.split(','), rows: lines.slice(1).map((l) => l.split(',')) }] };
  }
  if (Array.isArray(j)) return { kind: 'json', j, tables: [{ title: 'array', fields: Object.keys(j[0] ?? {}), rows: j.map(Object.values) }] };
  const tables = [];
  if (Array.isArray(j.data)) tables.push({ title: j.title, fields: j.fields, rows: j.data });
  if (Array.isArray(j.aaData)) tables.push({ title: j.reportTitle ?? 'aaData', fields: j.fields, rows: j.aaData });
  for (const t of j.tables ?? []) tables.push({ title: t.title, fields: t.fields, rows: t.data ?? [] });
  return { kind: 'json', j, tables };
}

const keepRow = (row, i) => i < KEEP_FIRST || row.some((c) => KEEP_CODES.has(String(c).trim()));

function trimmed(body, kind, j) {
  if (kind === 'csv') {
    const lines = body.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    return [lines[0], ...lines.slice(1).filter((l, i) => keepRow(l.split(','), i))].join('\n') + '\n';
  }
  const trim = (rows) => rows.filter((r, i) => keepRow(Array.isArray(r) ? r : Object.values(r), i));
  const out = Array.isArray(j) ? trim(j) : structuredClone(j);
  if (!Array.isArray(j)) {
    if (Array.isArray(out.data)) out.data = trim(out.data);
    if (Array.isArray(out.aaData)) out.aaData = trim(out.aaData);
    for (const t of out.tables ?? []) if (Array.isArray(t.data)) t.data = trim(t.data);
  }
  return JSON.stringify(out, null, 1);
}

async function latestTradingDay() {
  const d = todayTaipei();
  for (let back = 0; back < 15; back++, d.setDate(d.getDate() - 1)) {
    if (isWeekend(d)) continue;
    if (await fetchTpexInst(d)) return d;
  }
  throw new Error('15 天內找不到交易日');
}

async function probe(name, date) {
  for (const url of SOURCES[name](date)) {
    console.log(`\n=== ${name}\n${url}`);
    let body;
    try { body = await fetchText(url); } catch (e) { console.log(`  ✗ ${e.message}`); continue; }
    const { kind, j, tables } = tablesOf(body);
    if (j && !Array.isArray(j)) console.log(`  keys: ${Object.keys(j).join(', ')}  stat: ${j.stat ?? j.reportDate ?? '-'}`);
    const withData = tables.filter((t) => t.rows.length > 0);
    for (const t of tables) console.log(`  [${t.title}] ${t.rows.length} 列`);
    if (withData.length === 0) { console.log('  ✗ 無資料'); continue; }

    // 個股表通常是列數最多的那張
    const main = withData.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
    console.log(`  主表「${main.title}」欄位:`);
    (main.fields ?? []).forEach((f, i) => console.log(`    ${i}: ${f}`));
    for (const r of main.rows.slice(0, 3)) console.log(`  → ${JSON.stringify(r)}`);

    const ext = kind === 'csv' ? 'csv' : 'json';
    await writeFile(join(RAW_DIR, `${name}.${ext}`), body);
    await writeFile(join(FIXTURE_DIR, `${name}.${ext}`), trimmed(body, kind, j));
    return { name, url, ok: true, rows: main.rows.length };
  }
  return { name, ok: false };
}

async function main() {
  const [dateArg, ...only] = process.argv.slice(2);
  const date = dateArg ? new Date(`${dateArg}T00:00:00`) : await latestTradingDay();
  console.log(`探測日期: ${iso(date)}`);
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(FIXTURE_DIR, { recursive: true });

  const results = [];
  for (const name of only.length ? only : Object.keys(SOURCES)) results.push(await probe(name, date));

  console.log('\n=== 摘要');
  for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? ` ${r.rows} 列  ${r.url}` : ' 所有候選端點皆無資料'}`);
}

main().catch((e) => {
  console.error('執行失敗:', e);
  process.exit(1);
});
