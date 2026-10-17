// ===========================================================================
// score.mjs — 由 history.sqlite 計算特徵與吸籌分數
//
// 執行:  TZ=Asia/Taipei node scripts/score.mjs [--date YYYY-MM-DD]
//   --date  掃描日,預設為最新一個兩市場都完整的交易日
// 輸出:  docs/scan.json(ACCUMULATION / WATCH / OVERHEATED)
//        docs/dist.json(出貨:DISTRIBUTION / CAUTION / PROVISIONAL / COLLAPSED)
//        data/features/<10..99>.json(全部個股,依代號前兩碼分片,供 /api/stock/:code;每檔帶 distribution)
//        scan_daily 表(全部個股)、dist_daily 表(股票池 universe(t) 內全部個股),供日後回測
// 出貨評分失敗不影響吸籌(規格 §5.2):吸籌照常寫出,dist.json 與 dist_daily 不更新,分片的 distribution 為 null
// ===========================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { nowTaipei } from '../lib/dates.mjs';
import { openDb, tx, upsertStmt, logIngest } from '../lib/db.mjs';
import { computeFeatures, priceLevels } from '../lib/features.mjs';
import { scoreStock, CONFIG } from '../lib/score.mjs';
import { fourD } from '../lib/fourd.mjs';
import { scoreDistribution, pointInTimeUniverse, CONFIG as DIST_CONFIG } from '../lib/distribution.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH ?? join(ROOT, 'data', 'history.sqlite');
const SCAN_PATH = join(ROOT, 'docs', 'scan.json');
const DIST_PATH = join(ROOT, 'docs', 'dist.json');
const FEATURES_DIR = join(ROOT, 'data', 'features');
const WINDOW = 61; // D60 加上 t−20 需要的天數上限
const SERIES_DAYS = 20;
const PUBLISHED = ['ACCUMULATION', 'WATCH', 'OVERHEATED'];
const DIST_PUBLISHED = ['DISTRIBUTION', 'CAUTION', 'PROVISIONAL', 'COLLAPSED'];
const DIST_STAGES = [...DIST_PUBLISHED, 'NEUTRAL', 'EXCLUDED'];
const SBL_WARMUP_DAYS = 21;
const RUN_ID = process.env.GITHUB_RUN_ID ?? 'local';

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
  const margin = range('margin_daily', 'margin_balance, short_balance');
  const qfii = range('qfii_daily', 'issued_shares, foreign_ratio');
  const sbl = range('sbl_daily', 'sbl_balance');

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
  const featuresOf = (code) => computeFeatures({
    days, inst: inst.get(code) ?? empty, price: price.get(code) ?? empty, margin: margin.get(code) ?? empty,
    qfii: qfii.get(code) ?? empty, tdcc: tdcc.get(code) ?? [], sbl: sbl.get(code) ?? empty,
  });

  // 出貨:股票池與市場別用 point-in-time(§7.6);借券狀態依市場分開判斷(§7.5)。任何一步失敗只停掉出貨
  let dist = null;
  try {
    const stocksMarket = new Map(db.prepare('SELECT code, market FROM stocks').all().map((r) => [r.code, r.market]));
    const universe = pointInTimeUniverse({
      t,
      priceRows: db.prepare('SELECT date, code FROM price_daily WHERE date = ?').all(t),
      sblRows: db.prepare('SELECT code, MAX(date) AS date, market FROM sbl_daily WHERE date <= ? GROUP BY code').all(t),
      stocks: stocksMarket,
    });
    const sblDays = db.prepare('SELECT COUNT(DISTINCT date) AS n, MAX(date) AS latest FROM sbl_daily WHERE date <= ?').get(t);
    const sblToday = new Set(db.prepare('SELECT DISTINCT market FROM sbl_daily WHERE date = ?').all(t).map((r) => r.market));
    const sblStatus = { TWSE: sblToday.has('TWSE') ? 'ok' : 'pending', TPEX: sblToday.has('TPEX') ? 'ok' : 'pending' };
    const sblWarmingUp = sblDays.n < SBL_WARMUP_DAYS;
    const prevStages = new Map(db.prepare('SELECT code, stage FROM dist_daily WHERE date = ?').all(t).map((r) => [r.code, r.stage]));
    const score = (code, features) => {
      const u = universe.get(code);
      const r = scoreDistribution(features, { sblPending: sblStatus[u.market] === 'pending', sblWarmingUp, marketAssumed: u.market_assumed });
      return { scan_date: t, run_id: RUN_ID, config_version: DIST_CONFIG.version, market: u.market, ...r };
    };
    dist = { universe, sblDays, sblStatus, sblWarmingUp, prevStages, score, byCode: new Map() };
  } catch (e) {
    process.stderr.write(`⚠ 出貨評分準備失敗,只輸出吸籌: ${e.message}\n`);
    logIngest(db, { source: 'dist', date: t, status: 'error', message: e.message });
  }
  const scoreDist = (code, features) => {
    if (!dist || !dist.universe.has(code)) return null;
    try {
      const r = dist.score(code, features);
      dist.byCode.set(code, r);
      return r;
    } catch (e) {
      process.stderr.write(`⚠ 出貨評分失敗(${code}),只輸出吸籌: ${e.message}\n`);
      logIngest(db, { source: 'dist', date: t, status: 'error', message: `${code}: ${e.message}` });
      dist = null;
      return null;
    }
  };

  const results = [];
  for (const s of db.prepare('SELECT code, name, market FROM stocks ORDER BY code').all()) {
    const p = price.get(s.code) ?? empty;
    const i = inst.get(s.code) ?? empty;
    const features = featuresOf(s.code);
    const scored = scoreStock(features);
    const distribution = scoreDist(s.code, features); // 用未四捨五入的特徵
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
    const levels = priceLevels({ days, price: p });
    const lights = fourD({ features, levels }); // 用未四捨五入的值判斷,避免進位改變燈號
    results.push({ ...s, ...scored, features: roundAll(features), close: p.get(t)?.close ?? null, levels: roundAll(levels), lights, series, distribution });
  }
  // 股票池內但不在 stocks 的代號(從沒有法人交易紀錄、成交極少的個股):只寫 dist_daily,不進分片與 dist.json
  const extra = dist ? [...dist.universe.keys()].filter((code) => !dist.byCode.has(code)) : [];
  for (const code of extra) scoreDist(code, featuresOf(code));
  // 出貨評分中途失敗時,已算出的部分一律丟棄,不可只寫一半
  if (!dist) for (const r of results) r.distribution = null;

  // scan_daily:全部個股
  const stmt = upsertStmt(db, 'scan_daily', ['date', 'code', 'score', 'stage', 'features', 'signals'], ['date', 'code']);
  tx(db, () => {
    for (const r of results) {
      stmt.run({ date: t, code: r.code, score: r.score, stage: r.stage, features: JSON.stringify(r.features), signals: JSON.stringify(r.signals) });
    }
  });
  // dist_daily:股票池內全部個股;重算後階段有變動的檔數記在 ingest_log(同一天結果改變時可追蹤)。
  // 寫入失敗(整批 rollback)也只停掉出貨:不寫 dist.json、分片 distribution 為 null,吸籌照常輸出
  if (dist) {
    try {
      const dstmt = upsertStmt(db, 'dist_daily', ['date', 'code', 'score', 'coverage', 'stage', 'breakdown', 'signals', 'config_version', 'run_id'], ['date', 'code']);
      let changed = 0;
      tx(db, () => {
        for (const [code, d] of dist.byCode) {
          if (dist.prevStages.has(code) && dist.prevStages.get(code) !== d.stage) changed++;
          dstmt.run({ date: t, code, score: d.score, coverage: d.coverage, stage: d.stage, breakdown: JSON.stringify(d.breakdown), signals: JSON.stringify(d.signals), config_version: d.config_version, run_id: RUN_ID });
        }
      });
      if (dist.prevStages.size) logIngest(db, { source: 'dist', date: t, status: 'ok', rows: changed, message: `重算:階段變動 ${changed} 檔` });
    } catch (e) {
      process.stderr.write(`⚠ dist_daily 寫入失敗,只輸出吸籌: ${e.message}\n`);
      logIngest(db, { source: 'dist', date: t, status: 'error', message: `dist_daily: ${e.message}` });
      dist = null;
      for (const r of results) r.distribution = null;
    }
  }
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
    run_id: RUN_ID,
  };

  const published = results
    .filter((r) => PUBLISHED.includes(r.stage))
    .sort((a, b) => PUBLISHED.indexOf(a.stage) - PUBLISHED.indexOf(b.stage) || b.score - a.score || a.code.localeCompare(b.code))
    .map(({ series, levels, distribution, ...r }) => r); // scan.json 只放清單需要的欄位;明細(含出貨評分)在 features 分片
  mkdirSync(dirname(SCAN_PATH), { recursive: true });
  writeFileSync(SCAN_PATH, JSON.stringify({ ...meta, counts, stocks: published, note: '僅供研究參考，非投資建議。' }));

  // dist.json:只收錄 DIST_PUBLISHED;market 用 market(t)。出貨評分失敗時不寫,保留上一版(scan_date 會落後 scan.json)
  let distCounts = null;
  if (dist) {
    distCounts = Object.fromEntries(DIST_STAGES.map((k) => [k, 0]));
    for (const d of dist.byCode.values()) distCounts[d.stage]++;
    const pending = Object.values(dist.sblStatus).includes('pending');
    const distStocks = results
      .filter((r) => r.distribution && DIST_PUBLISHED.includes(r.distribution.stage))
      .map((r) => ({ code: r.code, name: r.name, market: r.distribution.market, score: r.distribution.score, coverage: r.distribution.coverage, stage: r.distribution.stage, breakdown: r.distribution.breakdown, signals: r.distribution.signals, features: r.features, close: r.close }))
      .sort((a, b) => DIST_PUBLISHED.indexOf(a.stage) - DIST_PUBLISHED.indexOf(b.stage) || b.score - a.score || a.code.localeCompare(b.code));
    writeFileSync(DIST_PATH, JSON.stringify({
      updated_at: updatedAt,
      scan_date: t,
      run_id: RUN_ID,
      sbl_latest: dist.sblDays.latest,
      sbl_status: dist.sblStatus,
      config_version: DIST_CONFIG.version,
      experimental: DIST_CONFIG.experimental,
      quality: pending ? 'sbl_pending' : dist.sblWarmingUp ? 'sbl_warming_up' : meta.quality,
      counts: Object.fromEntries(DIST_PUBLISHED.map((k) => [k, distCounts[k]])),
      stocks: distStocks,
      note: '疑似出貨風險訊號，僅供研究參考，非投資建議，亦非放空建議。',
    }));
  }

  // features 分片:依代號前兩碼 10~99(每片約 10~20 KB,Worker 免費方案 CPU 10ms 內可解析),以代號為 key
  // 先清空目錄,避免殘留舊分片被上傳;沒有個股的前兩碼也寫空分片,讓 /api/stock 一律回 404 而不是讀到舊檔
  rmSync(FEATURES_DIR, { recursive: true, force: true });
  mkdirSync(FEATURES_DIR, { recursive: true });
  const shards = new Map();
  for (let p = 10; p <= 99; p++) shards.set(String(p), {});
  for (const r of results) shards.get(r.code.slice(0, 2))[r.code] = r;
  for (const [prefix, stocks] of shards) writeFileSync(join(FEATURES_DIR, `${prefix}.json`), JSON.stringify({ ...meta, stocks }));

  process.stderr.write(`掃描日 ${t}(${days.length} 個交易日,集保 ${tdccWeeks} 週)共 ${results.length} 檔: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' / ')}\n`);
  if (distCounts) process.stderr.write(`出貨(股票池 ${dist.byCode.size} 檔,借券 ${JSON.stringify(dist.sblStatus)}): ${Object.entries(distCounts).map(([k, v]) => `${k} ${v}`).join(' / ')}\n`);
  else process.stderr.write('⚠ 出貨評分失敗,dist.json 未更新\n');
  process.stderr.write(`輸出 ${SCAN_PATH}${distCounts ? `、${DIST_PATH}` : ''}、${FEATURES_DIR}/10..99.json\n`);
}

try {
  main();
} catch (e) {
  console.error('執行失敗:', e.message);
  process.exit(1);
}
