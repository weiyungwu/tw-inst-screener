// ===========================================================================
// ingest-daily.mjs — 把近 14 個日曆天內缺漏的資料寫進 history.sqlite
//
// 執行:  TZ=Asia/Taipei node scripts/ingest-daily.mjs
// 需求:  Node ≥ 22.13(node:sqlite);DB 路徑可用 DB_PATH 覆寫,預設 data/history.sqlite
// 來源:  法人(上市 T86 + 上櫃 dailyTrade)決定交易日;之後補 price/margin/qfii/sbl 各市場缺漏。
//        借券在當天 22:30 之後抓到的版本才算完整,之前抓到的(20:30 版)下一次會重抓。
//        已完整的日期與來源不再發請求,所以 18:00 失敗的部分 20:00 會補上。
// ===========================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iso, todayTaipei, isWeekend } from '../lib/dates.mjs';
import { openDb } from '../lib/db.mjs';
import { ingestDate } from '../lib/ingest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'history.sqlite');
const LOOKBACK_DAYS = 14;

// 近 LOOKBACK_DAYS 個日曆天內的平日,由舊到新(是否需要抓由 ingestDate 依 DB 判斷)
function recentWeekdays() {
  const today = todayTaipei();
  const out = [];
  for (let back = LOOKBACK_DAYS - 1; back >= 0; back--) {
    const d = new Date(today);
    d.setDate(d.getDate() - back);
    if (!isWeekend(d)) out.push(d);
  }
  return out;
}

async function main() {
  const db = openDb(DB_PATH);
  const summary = [];
  for (const d of recentWeekdays()) {
    const { lines } = await ingestDate(db, d);
    if (lines.length) summary.push(`${iso(d)} ${lines.join(' ')}`);
  }

  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const totals = ['trading_days', 'stocks', 'inst_daily', 'price_daily', 'margin_daily', 'qfii_daily', 'sbl_daily'].map((t) => `${t} ${count(t)}`).join(' / ');
  db.close();
  process.stderr.write(`\n摘要:\n${summary.map((s) => `  ${s}`).join('\n') || '  (沒有需要處理的日期)'}\n`);
  process.stderr.write(`DB ${DB_PATH}: ${totals}\n`);
}

main().catch((e) => {
  console.error('執行失敗:', e);
  process.exit(1);
});
