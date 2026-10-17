// ===========================================================================
// backfill.mjs — 在本機回補歷史資料(手動執行一次;請求間隔 ≥ 3 秒,約 25~30 分鐘)
//
// 執行:  TZ=Asia/Taipei node scripts/backfill.mjs [--days 60] [--sources inst,price,margin,qfii,sbl]
//                                                  [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--sbl]
//   --days    由 --to(預設今天)往回回補的交易日數,預設 60;有 --from 時改以 --from 為下限
//   --sources 只處理指定的來源群組;非 inst 來源只會補「法人已完整」的日期
//   --sbl     只回補借券賣出(等同 --sources sbl;60 個交易日 × 2 市場 × 3 秒,約 6 分鐘)
//
//        TZ=Asia/Taipei node scripts/backfill.mjs --tdcc-weeks 2
//   --tdcc-weeks  只回補集保:從集保官網查詢頁回補「最新一週之前」的 N 週(最新一週由 ingest-weekly 抓 CSV)。
//                 一次請求只能查一檔一週,只查 stocks 表內的上市櫃普通股(約 2,000 檔 × N 次請求)。
// 已存在的日期與來源直接跳過,可以中斷後續跑。
// ===========================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { iso, todayTaipei, isWeekend, nowTaipei } from '../lib/dates.mjs';
import { openDb, writeTdcc, tdccCodes, logIngest } from '../lib/db.mjs';
import { ingestDate, GROUPS } from '../lib/ingest.mjs';
import { openTdccSession } from '../lib/sources/tdcc.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'history.sqlite');

const { values: args } = parseArgs({
  options: {
    days: { type: 'string', default: '60' },
    sources: { type: 'string', default: GROUPS.join(',') },
    from: { type: 'string' },
    to: { type: 'string' },
    'tdcc-weeks': { type: 'string' },
    sbl: { type: 'boolean', default: false },
  },
});

const parseDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`日期格式錯誤: ${s}(應為 YYYY-MM-DD)`);
  return new Date(`${s}T00:00:00`);
};

// 集保歷史:逐檔逐週查詢,每檔查完立即寫入,中斷後重跑會從缺的地方繼續
async function backfillTdcc(db, weeksBack) {
  const session = await openTdccSession();
  const weeks = session.weeks().slice(1, 1 + weeksBack);
  const codes = db.prepare('SELECT code FROM stocks ORDER BY code').all().map((r) => r.code);
  process.stderr.write(`集保回補週別: ${weeks.join(', ')};每週 ${codes.length} 檔\n`);

  for (const week of weeks) {
    const dataDate = `${week.slice(0, 4)}-${week.slice(4, 6)}-${week.slice(6, 8)}`;
    const done = tdccCodes(db, dataDate);
    const todo = codes.filter((c) => !done.has(c));
    let ok = 0, empty = 0, emptyStreak = 0;
    const errors = [];
    for (const [i, code] of todo.entries()) {
      try {
        const r = await session.query(code, week);
        if (r) { writeTdcc(db, dataDate, new Map([[code, r.levels]]), nowTaipei()); ok++; emptyStreak = 0; } else { empty++; emptyStreak++; }
      } catch (e) {
        errors.push(`${code}: ${e.message}`);
        // 結構性問題(網站改版等)會讓每一檔都失敗,不要白跑幾個小時
        if (errors.length >= 50 && errors.length > ok) throw new Error(`集保回補失敗過多(✓ ${ok} ✗ ${errors.length}),停止。例: ${errors.slice(0, 3).join('; ')}`);
      }
      // 正常每週只有少數幾檔查無;連續大量查無代表網站或 session 出問題,停下來而不是當成「查無」帶過
      if (emptyStreak >= 50) throw new Error(`集保連續 ${emptyStreak} 檔查無資料(停在 ${code}),網站可能異常,停止。重跑會從缺的地方繼續。`);
      if ((i + 1) % 100 === 0) process.stderr.write(`  ${dataDate} ${i + 1}/${todo.length}(✓ ${ok} 查無 ${empty} ✗ ${errors.length})\n`);
    }
    const message = `已有 ${done.size}、新寫入 ${ok}、查無 ${empty}、失敗 ${errors.length}${errors.length ? `: ${errors.slice(0, 5).join('; ')}` : ''}`;
    logIngest(db, { source: 'tdcc-history', date: dataDate, status: errors.length ? 'error' : 'ok', rows: ok, message });
    process.stderr.write(`集保 ${dataDate} ${message}\n`);
  }
}

async function main() {
  if (args['tdcc-weeks'] != null) {
    const n = Number(args['tdcc-weeks']);
    if (!(Number.isInteger(n) && n > 0)) throw new Error(`--tdcc-weeks 必須是正整數: ${args['tdcc-weeks']}`);
    const db = openDb(DB_PATH);
    await backfillTdcc(db, n);
    db.close();
    return;
  }

  const groups = args.sbl ? ['sbl'] : args.sources.split(',').map((s) => s.trim());
  const bad = groups.filter((g) => !GROUPS.includes(g));
  if (bad.length) throw new Error(`未知的來源: ${bad.join(', ')}(可用: ${GROUPS.join(', ')})`);
  const days = Number(args.days);
  if (!args.from && !(days > 0)) throw new Error(`--days 必須是正整數: ${args.days}`);

  const to = args.to ? parseDate(args.to) : todayTaipei();
  const from = args.from ? parseDate(args.from) : null;
  // 沒有 --from 時,往回最多走 days×2+30 個日曆天(足以涵蓋連假),避免無限往回
  const floor = from ?? new Date(to.getFullYear(), to.getMonth(), to.getDate() - (days * 2 + 30));

  const db = openDb(DB_PATH);
  process.stderr.write(`回補 ${from ? `${iso(from)} ~ ${iso(to)}` : `${iso(to)} 往回 ${days} 個交易日`},來源 ${groups.join(',')}\n`);

  let tradingDays = 0;
  for (const d = new Date(to); d >= floor; d.setDate(d.getDate() - 1)) {
    if (!from && tradingDays >= days) break;
    if (isWeekend(d)) continue;
    const { trading, lines } = await ingestDate(db, d, groups);
    if (trading !== false) tradingDays++;
    process.stderr.write(`${iso(d)} ${lines.join(' ') || '已完整,跳過'}\n`);
  }

  db.close();
  process.stderr.write(`\n完成:處理 ${tradingDays} 個交易日。查看統計:node scripts/verify-scan.mjs --stats\n`);
  process.stderr.write('上傳到 R2:\n  npx wrangler r2 object put tw-stocks-data/db/history.sqlite --file data/history.sqlite --remote\n');
}

main().catch((e) => {
  console.error('執行失敗:', e);
  process.exit(1);
});
