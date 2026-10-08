// ===========================================================================
// score.mjs — 由 history.sqlite 計算特徵與吸籌分數
//
// 執行:  TZ=Asia/Taipei node scripts/score.mjs [--date YYYY-MM-DD]
//   --date  掃描日,預設為最新一個兩市場都完整的交易日
// 輸出:  docs/scan.json(ACCUMULATION / WATCH / OVERHEATED)
//        data/features/<10..99>.json(全部個股,依代號前兩碼分片,供 /api/stock/:code)
//        scan_daily 表(全部個股,供日後回測)
// ===========================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { nowTaipei } from '../lib/dates.mjs';
import { openDb, tx, upsertStmt } from '../lib/db.mjs';
import { computeFeatures, priceLevels } from '../lib/features.mjs';
import { scoreStock, CONFIG } from '../lib/score.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH ?? join(ROOT, 'data', 'history.sqlite');
const SCAN_PATH = join(ROOT, 'docs', 'scan.json');
const FEATURES_DIR = join(ROOT, 'data', 'features');
const WINDOW = 61; // D60 加上 t−20 需要的天數上限
const SERIES_DAYS = 20;
const PUBLISHED = ['ACCUMULATION', 'WATCH', 'OVERHEATED'];

const { values: args } = parseArgs({ options: { date: { type: 'string' } } });

// 把多列資料依 code → Map<date, row>
function byCode(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.code)) out.set(r.code, new Map());
    out.get(r.code).set(r.date, r);
  }
  return out;
}

// 輸出用:非整數四捨五入到 4 位小數
const round = (v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v);
const roundAll = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, round(v)]));

function main() {
  const db = openDb(DB_PATH);
  const t = args.date ?? db.prepare('SELECT MAX(date) AS d FROM trading_days WHERE twse_ok = 1 AND tpex_ok = 1').get().d;
  if (!t) throw new Error('trading_days 沒有完整的交易日,先執行 ingest-daily 或 backfill');

  const days = db.prepare('SELECT date FROM trading_days WHERE twse_ok = 1 AND tpex_ok = 1 AND date <= ? ORDER BY date DESC LIMIT ?')
    .all(t, WINDOW).map((r) => r.date).reverse();
  if (days[days.length - 1] !== t) throw new Error(`${t} 不是完整的交易日`);
  const from = days[0];
  const range = (table, cols) => byCode(db.prepare(`SELECT date, code, ${cols} FROM ${table} WHERE date BETWEEN ? AND ?`).all(from, t));
  const inst = range('inst_daily', 'foreign_net, trust_net, dealer_net');
  const price = range('price_daily', 'open, high, low, close, volume, value');
  const margin = range('margin_daily', 'margin_balance');
  const qfii = range('qfii_daily', 'issued_shares, foreign_ratio');

  // 集保:point-in-time,只用 data_date ≤ t 且 fetched_at ≤ t 當日 23:59:59 的週。
  // 比例由股數計算(Σ股數 ÷ 合計股數),比把各級四捨五入後的 pct 相加精確,週增減判斷才不會被進位誤差干擾。
  const tdccRows = db.prepare(`
    SELECT code, data_date,
      100.0 * SUM(CASE WHEN level BETWEEN 12 AND 15 THEN shares ELSE 0 END) / MAX(CASE WHEN level = 17 THEN shares END) AS big400,
      100.0 * SUM(CASE WHEN level = 15 THEN shares ELSE 0 END) / MAX(CASE WHEN level = 17 THEN shares END) AS big1000,
      100.0 * SUM(CASE WHEN level BETWEEN 1 AND 8 THEN shares ELSE 0 END) / MAX(CASE WHEN level = 17 THEN shares END) AS retail,
      MAX(CASE WHEN level = 17 THEN people END) AS holders
    FROM tdcc_weekly
    WHERE data_date <= ? AND fetched_at <= ?
    GROUP BY code, data_date
    HAVING MAX(CASE WHEN level = 17 THEN shares END) > 0
    ORDER BY code, data_date`).all(t, `${t} 23:59:59`);
  const tdcc = new Map();
  for (const r of tdccRows) {
    if (!tdcc.has(r.code)) tdcc.set(r.code, []);
    tdcc.get(r.code).push(r);
  }
  const tdccDates = [...new Set(tdccRows.map((r) => r.data_date))].sort();

  const empty = new Map();
  const results = [];
  for (const s of db.prepare('SELECT code, name, market FROM stocks ORDER BY code').all()) {
    const p = price.get(s.code) ?? empty;
    const i = inst.get(s.code) ?? empty;
    const features = computeFeatures({
      days, inst: i, price: p, margin: margin.get(s.code) ?? empty, qfii: qfii.get(s.code) ?? empty, tdcc: tdcc.get(s.code) ?? [],
    });
    const scored = scoreStock(features);
    const m = margin.get(s.code) ?? empty;
    // 近 20 日序列:法人單位為股、融資餘額單位為張(官方單位);沒有法人列但有行情 = 當日法人 0(同 features)
    const series = days.slice(-SERIES_DAYS).map((d) => {
      const r = i.get(d) ?? (p.has(d) ? { foreign_net: 0, trust_net: 0, dealer_net: 0 } : null);
      const px = p.get(d);
      return {
        date: d,
        inst_net: r ? r.foreign_net + r.trust_net : null,
        foreign_net: r?.foreign_net ?? null, trust_net: r?.trust_net ?? null, dealer_net: r?.dealer_net ?? null,
        open: px?.open ?? null, high: px?.high ?? null, low: px?.low ?? null, close: px?.close ?? null, volume: px?.volume ?? null,
        margin_balance: m.get(d)?.margin_balance ?? null,
      };
    });
    const levels = roundAll(priceLevels({ days, price: p }));
    results.push({ ...s, ...scored, features: roundAll(features), close: p.get(t)?.close ?? null, levels, series });
  }

  // scan_daily:全部個股
  const stmt = upsertStmt(db, 'scan_daily', ['date', 'code', 'score', 'stage', 'features', 'signals'], ['date', 'code']);
  tx(db, () => {
    for (const r of results) {
      stmt.run({ date: t, code: r.code, score: r.score, stage: r.stage, features: JSON.stringify(r.features), signals: JSON.stringify(r.signals) });
    }
  });
  db.close();

  const counts = Object.fromEntries(['ACCUMULATION', 'WATCH', 'OVERHEATED', 'NEUTRAL', 'EXCLUDED'].map((k) => [k, 0]));
  for (const r of results) counts[r.stage]++;
  const tdccWeeks = tdccDates.length;
  const updatedAt = `${nowTaipei().replace(' ', 'T')}+08:00`;
  const meta = {
    updated_at: updatedAt,
    scan_date: t,
    trading_days_available: days.length,
    tdcc_latest: tdccDates[tdccDates.length - 1] ?? null,
    tdcc_weeks: tdccWeeks,
    quality: tdccWeeks < CONFIG.tdccWarmupWeeks ? 'tdcc_warming_up' : null,
    config_version: CONFIG.version,
  };

  const published = results
    .filter((r) => PUBLISHED.includes(r.stage))
    .sort((a, b) => PUBLISHED.indexOf(a.stage) - PUBLISHED.indexOf(b.stage) || b.score - a.score || a.code.localeCompare(b.code))
    .map(({ series, levels, ...r }) => r); // scan.json 只放清單需要的欄位;明細在 features 分片
  mkdirSync(dirname(SCAN_PATH), { recursive: true });
  writeFileSync(SCAN_PATH, JSON.stringify({ ...meta, counts, stocks: published, note: '僅供研究參考，非投資建議。' }));

  // features 分片:依代號前兩碼 10~99(每片約 10~20 KB,Worker 免費方案 CPU 10ms 內可解析),以代號為 key
  // 先清空目錄,避免殘留舊分片被上傳;沒有個股的前兩碼也寫空分片,讓 /api/stock 一律回 404 而不是讀到舊檔
  rmSync(FEATURES_DIR, { recursive: true, force: true });
  mkdirSync(FEATURES_DIR, { recursive: true });
  const shards = new Map();
  for (let p = 10; p <= 99; p++) shards.set(String(p), {});
  for (const r of results) shards.get(r.code.slice(0, 2))[r.code] = r;
  for (const [prefix, stocks] of shards) writeFileSync(join(FEATURES_DIR, `${prefix}.json`), JSON.stringify({ ...meta, stocks }));

  process.stderr.write(`掃描日 ${t}(${days.length} 個交易日,集保 ${tdccWeeks} 週)共 ${results.length} 檔: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' / ')}\n`);
  process.stderr.write(`輸出 ${SCAN_PATH}、${FEATURES_DIR}/10..99.json\n`);
}

try {
  main();
} catch (e) {
  console.error('執行失敗:', e.message);
  process.exit(1);
}
