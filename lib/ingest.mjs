// 單一日期的 ingest:先確認交易日(inst),再補 price/margin/qfii/sbl 各來源缺漏的部分。
// ingest-daily.mjs 與 backfill.mjs 共用。
import { iso, nowTaipei } from './dates.mjs';
import { fetchInstDay } from './calendar.mjs';
import { completeDates, hasTwseFp, writeInstDay, writeDailyRows, hasMarketRows, logIngest, writeSblDay, sblFinal, sblMinRows, sblOverIssued } from './db.mjs';
import { fetchTwsePrice } from './sources/twse-price.mjs';
import { fetchTpexPrice } from './sources/tpex-price.mjs';
import { fetchTwseMargin } from './sources/twse-margin.mjs';
import { fetchTpexMargin } from './sources/tpex-margin.mjs';
import { fetchTwseQfii } from './sources/twse-qfii.mjs';
import { fetchTpexQfii } from './sources/tpex-qfii.mjs';
import { fetchTwseSbl } from './sources/twse-sbl.mjs';
import { fetchTpexSbl } from './sources/tpex-sbl.mjs';

export const GROUPS = ['inst', 'price', 'margin', 'qfii', 'sbl'];

const PRICE = ['open', 'high', 'low', 'close', 'volume', 'value'];
const MARGIN = ['margin_balance', 'short_balance'];
const QFII = ['issued_shares', 'foreign_shares', 'foreign_ratio'];

const SOURCES = [
  { name: 'twse-price', group: 'price', market: 'TWSE', table: 'price_daily', cols: PRICE, fetch: fetchTwsePrice },
  { name: 'tpex-price', group: 'price', market: 'TPEX', table: 'price_daily', cols: PRICE, fetch: fetchTpexPrice },
  { name: 'twse-margin', group: 'margin', market: 'TWSE', table: 'margin_daily', cols: MARGIN, fetch: fetchTwseMargin },
  { name: 'tpex-margin', group: 'margin', market: 'TPEX', table: 'margin_daily', cols: MARGIN, fetch: fetchTpexMargin },
  { name: 'twse-qfii', group: 'qfii', market: 'TWSE', table: 'qfii_daily', cols: QFII, fetch: fetchTwseQfii },
  { name: 'tpex-qfii', group: 'qfii', market: 'TPEX', table: 'qfii_daily', cols: QFII, fetch: fetchTpexQfii },
];

// 借券的市場記在 sbl_daily.market(當日資料來自哪個市場),寫入規則見 writeSblDay
const SBL_SOURCES = [
  { name: 'twse-sbl', market: 'TWSE', fetch: fetchTwseSbl },
  { name: 'tpex-sbl', market: 'TPEX', fetch: fetchTpexSbl },
];

// 借券:未到最終版就抓;逐列驗證失敗 → 整個市場不寫入、記 error;超過發行股數只記在 message
async function ingestSbl(db, d, s) {
  const date = iso(d);
  const minRows = sblMinRows(db, date, s.market);
  if (minRows == null) throw new Error(`${s.market} 沒有行情資料,無法計算借券列數下限`);
  const map = await s.fetch(d, minRows);
  if (!map) {
    logIngest(db, { source: s.name, date, status: 'empty' });
    return `· ${s.name} 尚無資料`;
  }
  const { written, revised, crossMarket } = writeSblDay(db, date, s.market, map, nowTaipei());
  const over = sblOverIssued(db, date, map);
  const notes = [];
  const reset = [...map].filter(([, v]) => v.reset_by_halt).map(([code]) => code);
  if (reset.length) notes.push(`停止買賣餘額歸零(勾稽例外): ${reset.join(', ')}`);
  if (crossMarket) notes.push(`兩市場重複 ${crossMarket} 檔,以上櫃為準`);
  if (over.length) notes.push(`借券餘額超過發行股數(只警告): ${over.join(', ')}`);
  const message = notes.join(';') || null;
  logIngest(db, { source: s.name, date, status: 'ok', rows: map.size, message });
  return `✓ ${s.name} ${map.size}${revised ? `(修正 ${revised})` : written ? '' : '(未變動)'}${crossMarket ? `(兩市場重複 ${crossMarket})` : ''}${over.length ? ` ⚠ 超過發行股數 ${over.length}` : ''}`;
}

// 兩市場法人資料都到齊才算交易日完整。回傳 { trading: bool | null, line }
//   trading=false 代表非交易日;null 代表是交易日但這次沒拿到完整法人資料
async function ingestInst(db, d) {
  const date = iso(d);
  const r = await fetchInstDay(d, { isDupFp: (fp) => hasTwseFp(db, fp, date) });

  if (r.status === 'holiday') {
    logIngest(db, { source: 'tpex-inst', date, status: r.error ? 'error' : 'empty', message: r.error?.message });
    return { trading: false, line: '非交易日或上櫃無資料' };
  }
  if (r.status === 'twse_missing' || r.status === 'twse_dup') {
    const message = r.status === 'twse_dup' ? `指紋 ${r.fp} 與其他日重複` : r.error?.message ?? '取不到資料';
    logIngest(db, { source: 'twse-inst', date, status: r.status === 'twse_dup' ? 'skipped' : 'error', message });
    return { trading: null, line: `⚠ 上市法人 ${message},整日跳過` };
  }
  try {
    const n = writeInstDay(db, date, r);
    logIngest(db, { source: 'twse-inst', date, status: 'ok', rows: n.twse });
    logIngest(db, { source: 'tpex-inst', date, status: 'ok', rows: n.tpex });
    return { trading: true, line: `✓ 法人 上市 ${n.twse} / 上櫃 ${n.tpex}` };
  } catch (e) {
    logIngest(db, { source: 'inst', date, status: 'error', message: e.message });
    return { trading: null, line: `✗ 法人寫入失敗: ${e.message}` };
  }
}

// 處理一個日期。groups:要處理的來源群組(GROUPS 的子集)。
// 回傳 { trading: true | false | null, lines: string[] };只有已有完整法人資料的日期才會抓其他來源。
// 各來源各自獨立:任一失敗只記 log,不影響其他來源。
export async function ingestDate(db, d, groups = GROUPS) {
  const date = iso(d);
  const lines = [];
  if (!completeDates(db).has(date)) {
    if (!groups.includes('inst')) return { trading: null, lines: ['法人資料未完整且未指定 inst,無法確認交易日,跳過'] };
    const r = await ingestInst(db, d);
    lines.push(r.line);
    if (!r.trading) return { trading: r.trading, lines };
  }

  for (const s of SOURCES) {
    if (!groups.includes(s.group) || hasMarketRows(db, s.table, date, s.market)) continue;
    try {
      const map = await s.fetch(d);
      if (!map || map.size === 0) {
        logIngest(db, { source: s.name, date, status: 'empty' });
        lines.push(`· ${s.name} 尚無資料`);
        continue;
      }
      const n = writeDailyRows(db, s.table, s.cols, date, map);
      logIngest(db, { source: s.name, date, status: 'ok', rows: n });
      lines.push(`✓ ${s.name} ${n}`);
    } catch (e) {
      logIngest(db, { source: s.name, date, status: 'error', message: e.message });
      lines.push(`✗ ${s.name}: ${e.message}`);
    }
  }
  for (const s of SBL_SOURCES) {
    if (!groups.includes('sbl') || sblFinal(db, date, s.market)) continue;
    try {
      lines.push(await ingestSbl(db, d, s));
    } catch (e) {
      logIngest(db, { source: s.name, date, status: 'error', message: e.message });
      lines.push(`✗ ${s.name}: ${e.message}`);
    }
  }
  return { trading: true, lines };
}
