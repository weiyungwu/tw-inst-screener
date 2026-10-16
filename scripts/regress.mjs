// ===========================================================================
// regress.mjs — 吸籌掃描器回歸比對(出貨掃描器規格 §0 第 2 點)
//
// 執行:  TZ=Asia/Taipei node scripts/regress.mjs snapshot [--date YYYY-MM-DD] [--api http://localhost:8787]
//        TZ=Asia/Taipei node scripts/regress.mjs compare [--api http://localhost:8787]
//   snapshot  把 history.sqlite 凍結成 data/regress/history.sqlite,對它跑 score.mjs,存基準快照
//   compare   對同一份凍結 DB、同一個掃描日再跑一次 score.mjs,和基準逐項比對
//   --api     另外比對 /api/scan、/api/stock/2330(Worker 要自己先用 wrangler dev --local 啟動)
// 比對項目:scan_daily(score/stage/signals/features)、docs/scan.json、data/features/*.json
// 忽略:本規格新增的鍵(NEW_KEYS)與 updated_at;其他新增或缺少的鍵都算差異
// 注意:兩個指令都會用凍結 DB 的結果覆寫 docs/scan.json 與 data/features/
// ===========================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_DB = process.env.DB_PATH ?? join(ROOT, 'data', 'history.sqlite');
const DIR = join(ROOT, 'data', 'regress');
const FROZEN_DB = join(DIR, 'history.sqlite');
const BASELINE = join(DIR, 'baseline.json');
const SCAN_PATH = join(ROOT, 'docs', 'scan.json');
const FEATURES_DIR = join(ROOT, 'data', 'features');
const IGNORED = new Set([
  'updated_at', 'run_id', 'distribution',
  'inst_sell_days_20', 'big400_down_weeks', 'drawdown_60', 'below_ma20', 'dump_days_20',
  'sbl_chg_20_pct', 'sbl_ratio', 'short_margin_ratio',
]);
const MAX_SHOWN = 30;

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { date: { type: 'string' }, api: { type: 'string' } },
});

function runScore(date) {
  const a = [join(ROOT, 'scripts', 'score.mjs')];
  if (date) a.push('--date', date);
  execFileSync(process.execPath, a, { env: { ...process.env, TZ: 'Asia/Taipei', DB_PATH: FROZEN_DB }, stdio: ['ignore', 'ignore', 'inherit'] });
}

async function capture(scanDate) {
  const db = new DatabaseSync(FROZEN_DB, { readOnly: true });
  const scanDaily = Object.fromEntries(
    db.prepare('SELECT code, score, stage, signals, features FROM scan_daily WHERE date = ? ORDER BY code').all(scanDate)
      .map((r) => [r.code, { score: r.score, stage: r.stage, signals: JSON.parse(r.signals), features: JSON.parse(r.features) }]),
  );
  db.close();
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  const shards = Object.fromEntries(readdirSync(FEATURES_DIR).filter((f) => f.endsWith('.json')).sort()
    .map((f) => [f, readJson(join(FEATURES_DIR, f))]));
  const out = { scan_daily: scanDaily, scan_json: readJson(SCAN_PATH), shards };
  if (args.api) {
    const get = async (path) => {
      const res = await fetch(new URL(path, args.api));
      if (!res.ok) throw new Error(`${path} 回應 ${res.status}`);
      return res.json();
    };
    out.api = { '/api/scan': await get('/api/scan'), '/api/stock/2330': await get('/api/stock/2330') };
  }
  return out;
}

// 遞迴比對;after 中 IGNORED 的鍵直接略過,base 中的 updated_at 也略過。回傳差異路徑清單
function diff(base, after, path = '$', out = []) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(base) && isObj(after)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(after)]);
    for (const k of keys) {
      if (k === 'updated_at') continue;
      const inB = Object.hasOwn(base, k);
      const inA = Object.hasOwn(after, k);
      if (!inB && IGNORED.has(k)) continue;
      if (!inA) out.push(`${path}.${k}: 改動後缺少`);
      else if (!inB) out.push(`${path}.${k}: 改動後多出 ${JSON.stringify(after[k]).slice(0, 80)}`);
      else diff(base[k], after[k], `${path}.${k}`, out);
    }
  } else if (Array.isArray(base) && Array.isArray(after)) {
    if (base.length !== after.length) out.push(`${path}: 陣列長度 ${base.length} → ${after.length}`);
    for (let i = 0; i < Math.min(base.length, after.length); i++) diff(base[i], after[i], `${path}[${i}]`, out);
  } else if (!isDeepStrictEqual(base, after)) {
    out.push(`${path}: ${JSON.stringify(base)?.slice(0, 80)} → ${JSON.stringify(after)?.slice(0, 80)}`);
  }
  return out;
}

async function snapshot() {
  mkdirSync(DIR, { recursive: true });
  rmSync(FROZEN_DB, { force: true });
  const live = new DatabaseSync(LIVE_DB, { readOnly: true });
  live.exec(`VACUUM INTO '${FROZEN_DB.replaceAll("'", "''")}'`); // 一致的單檔副本(含 WAL 內容)
  live.close();
  runScore(args.date);
  const scanDate = JSON.parse(readFileSync(SCAN_PATH, 'utf8')).scan_date;
  const data = await capture(scanDate);
  writeFileSync(BASELINE, JSON.stringify({ scan_date: scanDate, created_at: new Date().toISOString(), data }));
  console.log(`基準快照:掃描日 ${scanDate}、scan_daily ${Object.keys(data.scan_daily).length} 檔、分片 ${Object.keys(data.shards).length} 個${data.api ? '、API 2 項' : ''}`);
  console.log(`存於 ${BASELINE}`);
}

async function compare() {
  if (!existsSync(BASELINE) || !existsSync(FROZEN_DB)) throw new Error('沒有基準快照,先執行 snapshot');
  const { scan_date: scanDate, data: base } = JSON.parse(readFileSync(BASELINE, 'utf8'));
  runScore(scanDate);
  const after = await capture(scanDate);
  if (base.api && !after.api) throw new Error('基準有 API 快照,compare 也要加 --api');
  if (!base.api) delete after.api;
  const diffs = diff(base, after);
  if (diffs.length === 0) {
    console.log(`完全相同(掃描日 ${scanDate}${base.api ? ',含 API' : ''})`);
    return;
  }
  console.log(`有 ${diffs.length} 處差異(掃描日 ${scanDate}):`);
  for (const d of diffs.slice(0, MAX_SHOWN)) console.log(`  ${d}`);
  if (diffs.length > MAX_SHOWN) console.log(`  …另有 ${diffs.length - MAX_SHOWN} 處`);
  process.exitCode = 1;
}

const cmd = { snapshot, compare }[positionals[0]];
if (!cmd) {
  console.error('用法: node scripts/regress.mjs snapshot|compare [--date YYYY-MM-DD] [--api URL]');
  process.exit(2);
}
try {
  await cmd();
} catch (e) {
  console.error('執行失敗:', e.message);
  process.exit(1);
}
