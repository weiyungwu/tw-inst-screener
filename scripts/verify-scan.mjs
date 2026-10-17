// ===========================================================================
// verify-scan.mjs — 自我檢查用
//
// 執行:  node scripts/verify-scan.mjs              最新掃描日的階段統計與 ACCUMULATION 前 20 檔(含 breakdown)
//        node scripts/verify-scan.mjs --stats      各表的日期數、筆數、日期範圍,以及近期 ingest 錯誤
// ===========================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../lib/db.mjs';
import { scoreStock } from '../lib/score.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'history.sqlite');

const { values: args } = parseArgs({ options: { stats: { type: 'boolean', default: false } } });

function printStats(db) {
  const tables = [
    ['trading_days', 'date'], ['inst_daily', 'date'], ['price_daily', 'date'],
    ['margin_daily', 'date'], ['qfii_daily', 'date'], ['sbl_daily', 'date'], ['tdcc_weekly', 'data_date'], ['scan_daily', 'date'],
  ];
  console.log('表              日期數    筆數  範圍');
  for (const [t, col] of tables) {
    const r = db.prepare(`SELECT COUNT(DISTINCT ${col}) AS days, COUNT(*) AS n, MIN(${col}) AS lo, MAX(${col}) AS hi FROM ${t}`).get();
    console.log(`${t.padEnd(14)} ${String(r.days).padStart(6)} ${String(r.n).padStart(7)}  ${r.lo ?? '-'} ~ ${r.hi ?? '-'}`);
  }

  // 交易日中,哪些來源/市場缺資料
  const gaps = db.prepare(`
    SELECT d.date, s.market, src.t AS tbl
    FROM trading_days d
    CROSS JOIN (SELECT 'TWSE' AS market UNION ALL SELECT 'TPEX') s
    CROSS JOIN (SELECT 'price_daily' AS t UNION ALL SELECT 'margin_daily' UNION ALL SELECT 'qfii_daily') src
    WHERE d.twse_ok = 1 AND d.tpex_ok = 1
      AND NOT EXISTS (
        SELECT 1 FROM price_daily p JOIN stocks k ON k.code = p.code WHERE src.t = 'price_daily' AND p.date = d.date AND k.market = s.market
        UNION ALL SELECT 1 FROM margin_daily m JOIN stocks k ON k.code = m.code WHERE src.t = 'margin_daily' AND m.date = d.date AND k.market = s.market
        UNION ALL SELECT 1 FROM qfii_daily q JOIN stocks k ON k.code = q.code WHERE src.t = 'qfii_daily' AND q.date = d.date AND k.market = s.market)
    ORDER BY d.date`).all();
  console.log(`\n交易日缺漏(來源/市場): ${gaps.length ? '' : '無'}`);
  for (const g of gaps) console.log(`  ${g.date} ${g.tbl} ${g.market}`);

  // 借券:只看第一筆借券資料之後的交易日(更早的日期沒有回補,不算缺漏);市場用 sbl_daily.market
  const sblGaps = db.prepare(`
    SELECT d.date, s.market FROM trading_days d
    CROSS JOIN (SELECT 'TWSE' AS market UNION ALL SELECT 'TPEX') s
    WHERE d.twse_ok = 1 AND d.tpex_ok = 1 AND d.date >= (SELECT MIN(date) FROM sbl_daily)
      AND NOT EXISTS (SELECT 1 FROM sbl_daily b WHERE b.date = d.date AND b.market = s.market)
    ORDER BY d.date, s.market`).all();
  const sblDays = db.prepare('SELECT market, COUNT(DISTINCT date) AS days, MIN(date) AS lo, MAX(date) AS hi FROM sbl_daily GROUP BY market').all();
  console.log(`\n借券 sbl_daily: ${sblDays.map((r) => `${r.market} ${r.days} 日(${r.lo} ~ ${r.hi})`).join(' / ') || '無資料'}`);
  console.log(`借券缺漏(交易日/市場): ${sblGaps.length ? '' : '無'}`);
  for (const g of sblGaps) console.log(`  ${g.date} ${g.market}`);

  const errors = db.prepare(`SELECT run_at, source, date, message FROM ingest_log WHERE status = 'error' ORDER BY id DESC LIMIT 10`).all();
  console.log(`\n最近 ingest 錯誤: ${errors.length ? '' : '無'}`);
  for (const e of errors) console.log(`  ${e.run_at} ${e.source} ${e.date ?? ''} ${e.message ?? ''}`);
}

const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const num = (v, d = 2) => (v == null ? '—' : v.toFixed(d));

function printScan(db) {
  const t = db.prepare('SELECT MAX(date) AS d FROM scan_daily').get().d;
  if (!t) return console.log('scan_daily 沒有資料,先執行 node scripts/score.mjs');
  const rows = db.prepare('SELECT s.code, k.name, k.market, s.score, s.stage, s.features, s.signals FROM scan_daily s JOIN stocks k USING (code) WHERE s.date = ? ORDER BY s.score DESC, s.code')
    .all(t).map((r) => ({ ...r, features: JSON.parse(r.features), signals: JSON.parse(r.signals) }));

  const counts = {};
  for (const r of rows) counts[r.stage] = (counts[r.stage] ?? 0) + 1;
  const scorable = rows.length - (counts.EXCLUDED ?? 0);
  console.log(`掃描日 ${t}:共 ${rows.length} 檔,可評分(非 EXCLUDED)${scorable} 檔`);
  for (const k of ['ACCUMULATION', 'WATCH', 'OVERHEATED', 'NEUTRAL', 'EXCLUDED']) {
    const n = counts[k] ?? 0;
    console.log(`  ${k.padEnd(13)} ${String(n).padStart(5)}${k === 'EXCLUDED' ? '' : `  (${pct(n / scorable)} of 可評分)`}`);
  }
  const accRatio = (counts.ACCUMULATION ?? 0) / scorable;
  if (accRatio > 0.05) console.log(`  ⚠ ACCUMULATION 占可評分 ${pct(accRatio)},超過 5%,建議提高門檻`);

  // 分數分布
  const hist = {};
  for (const r of rows) if (r.stage !== 'EXCLUDED') hist[Math.floor(r.score / 10) * 10] = (hist[Math.floor(r.score / 10) * 10] ?? 0) + 1;
  console.log(`  分數分布(可評分): ${Object.entries(hist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}~${+k + 9}: ${v}`).join(' / ')}`);

  // missing 特徵統計(可評分個股)
  const miss = {};
  for (const r of rows) if (r.stage !== 'EXCLUDED') for (const s of r.signals) if (s.startsWith('missing:')) miss[s.slice(8)] = (miss[s.slice(8)] ?? 0) + 1;
  console.log(`  缺值特徵(可評分個股): ${Object.entries(miss).map(([k, v]) => `${k} ${v}`).join(' / ') || '無'}`);

  // 出貨規格新增特徵:非 null 檔數(可評分個股),以及借券 20 日增加最多的 10 檔
  const DIST = ['inst_sell_days_20', 'big400_down_weeks', 'drawdown_60', 'below_ma20', 'dump_days_20', 'sbl_chg_20_pct', 'sbl_ratio', 'short_margin_ratio'];
  const scored = rows.filter((r) => r.stage !== 'EXCLUDED');
  console.log(`  出貨特徵有值(可評分 ${scored.length} 檔): ${DIST.map((k) => `${k} ${scored.filter((r) => r.features[k] != null).length}`).join(' / ')}`);
  const sblTop = scored.filter((r) => r.features.sbl_chg_20_pct != null).sort((a, b) => b.features.sbl_chg_20_pct - a.features.sbl_chg_20_pct).slice(0, 10);
  console.log(`  借券 20 日增加(%股本)前 ${sblTop.length}: ${sblTop.map((r) => `${r.code}${r.name} ${num(r.features.sbl_chg_20_pct)}(餘額 ${num(r.features.sbl_ratio)}%、券資比 ${num(r.features.short_margin_ratio, 1)})`).join(' / ') || '無'}`);

  const top = rows.filter((r) => r.stage === 'ACCUMULATION').slice(0, 20);
  console.log(`\nACCUMULATION 前 ${top.length} 檔(法人/集中/價格/量能/融資):`);
  console.log('代號  名稱        市場  分數  法 集 價 量 融  法人%股本 買超天 20日漲 量比  融資20日 大戶400%');
  for (const r of top) {
    const f = r.features;
    const b = scoreBreakdown(r);
    console.log(`${r.code}  ${r.name.padEnd(10, '　').slice(0, 5)}  ${r.market}  ${String(r.score).padStart(3)}  ${b}  ${num(f.inst_net_20_pct).padStart(8)} ${String(f.inst_buy_days_20 ?? '—').padStart(5)} ${pct(f.ret_20).padStart(6)} ${num(f.vol_ratio).padStart(5)} ${pct(f.margin_chg_20).padStart(8)} ${num(f.big400_pct).padStart(7)}`);
  }
}

// scan_daily 沒存 breakdown,由特徵重算(與 score.mjs 相同的純函式)
function scoreBreakdown(r) {
  const b = scoreStock(r.features).breakdown;
  return [b.inst, b.concentration, b.price, b.volume, b.margin].map((v) => String(v).padStart(2)).join(' ');
}

const db = openDb(DB_PATH);
if (args.stats) printStats(db);
else printScan(db);
db.close();
