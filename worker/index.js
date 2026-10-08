// 靜態頁面由 assets(docs/)提供;只有 assets 找不到的路徑會進到這裡,從 R2 讀出最新資料。
// scheduled:Cloudflare 排程準時觸發 GitHub Actions 更新資料(GitHub 自身排程常延遲,保留為備援)。
import { cobuy, INSTS } from '../lib/cobuy.mjs';

const WORKFLOW_DISPATCH_URL =
  'https://api.github.com/repos/weiyungwu/tw-inst-screener/actions/workflows/update.yml/dispatches';

const STAGES = ['ACCUMULATION', 'WATCH', 'OVERHEATED'];
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization',
  'access-control-allow-methods': 'GET, OPTIONS',
};

// R2 物件原樣回傳
async function r2Response(env, key) {
  const obj = await env.DATA.get(key);
  if (!obj) return new Response(`${key} not found in R2`, { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'no-cache');
  return new Response(obj.body, { headers });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache', ...CORS } });

async function readJson(env, key) {
  const obj = await env.DATA.get(key);
  return obj ? obj.json() : null;
}

// GET /api/scan?stage=ACCUMULATION,WATCH&min_score=50&market=TPEX&limit=50
async function apiScan(env, params) {
  const scan = await readJson(env, 'scan.json');
  if (!scan) return json({ error: 'scan_not_ready' }, 503);

  const stages = (params.get('stage') ?? 'ACCUMULATION').toUpperCase().split(',').map((s) => s.trim());
  const bad = stages.filter((s) => !STAGES.includes(s));
  if (bad.length) return json({ error: 'invalid_stage', allowed: STAGES }, 400);
  const market = params.get('market')?.toUpperCase();
  if (market && market !== 'TWSE' && market !== 'TPEX') return json({ error: 'invalid_market', allowed: ['TWSE', 'TPEX'] }, 400);
  const minScore = Number(params.get('min_score') ?? 0);
  const limit = Math.min(Math.max(Number(params.get('limit') ?? 50) || 50, 1), 200);

  const stocks = scan.stocks
    .filter((s) => stages.includes(s.stage) && s.score >= minScore && (!market || s.market === market))
    .slice(0, limit);
  return json({ scan_date: scan.scan_date, updated_at: scan.updated_at, quality: scan.quality, tdcc_weeks: scan.tdcc_weeks, count: stocks.length, stocks });
}

// GET /api/cobuy?days=10&streak=5&insts=foreign,trust&market=TPEX&sort=foreign&limit=50
// 法人同步買超:與網頁 index.html 相同的篩選(lib/cobuy.mjs),數值單位為張
async function apiCobuy(env, params) {
  const data = await readJson(env, 'data.json');
  if (!data) return json({ error: 'data_not_ready' }, 503);

  const int = (name, def) => {
    const v = params.get(name);
    if (v == null || v === '') return def;
    return /^[1-9]\d*$/.test(v) ? Number(v) : NaN;
  };
  const days = int('days', 10), streak = int('streak', 5), limit = int('limit', 50);
  if ([days, streak, limit].some(Number.isNaN)) return json({ error: 'invalid_number', hint: 'days、streak、limit 必須是正整數' }, 400);

  const insts = (params.get('insts') ?? 'foreign,dealer').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  if (insts.length === 0 || insts.some((k) => !INSTS.includes(k))) return json({ error: 'invalid_insts', allowed: INSTS }, 400);
  const market = params.get('market')?.toUpperCase();
  if (market && market !== 'TWSE' && market !== 'TPEX') return json({ error: 'invalid_market', allowed: ['TWSE', 'TPEX'] }, 400);
  const sort = (params.get('sort') ?? insts[0]).toLowerCase();
  if (!INSTS.includes(sort)) return json({ error: 'invalid_sort', allowed: INSTS }, 400);

  const total = data.trading_days.length;
  const rows = cobuy(data, { days, streak, insts, markets: market ? [market] : ['TWSE', 'TPEX'] })
    .sort((a, b) => b[`${sort}_sum`] - a[`${sort}_sum`] || a.code.localeCompare(b.code));
  return json({
    updated_at: data.updated_at,
    trading_days: data.trading_days,
    unit: '張',
    // 實際套用的參數(days、streak 超過資料天數時以資料天數為準,與網頁相同)
    params: { days: Math.min(days, total), streak: Math.min(streak, total), insts, market: market ?? 'ALL', sort },
    count: rows.length,
    stocks: rows.slice(0, Math.min(limit, 200)),
  });
}

// GET /api/stock/2330 → features/23.json 中的 2330
async function apiStock(env, code) {
  const shard = await readJson(env, `features/${code.slice(0, 2)}.json`);
  const stock = shard?.stocks?.[code];
  if (!stock) return json({ error: 'not_found' }, 404);
  return json({ scan_date: shard.scan_date, updated_at: shard.updated_at, quality: shard.quality, ...stock });
}

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === '/data.json') return r2Response(env, 'data.json');
    if (pathname === '/scan.json') return r2Response(env, 'scan.json');

    if (pathname.startsWith('/api/')) {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      // 有設定 API_TOKEN secret 才需要驗證;沒設定就公開
      if (env.API_TOKEN && request.headers.get('authorization') !== `Bearer ${env.API_TOKEN}`) return json({ error: 'unauthorized' }, 401);
      if (pathname === '/api/scan') return apiScan(env, searchParams);
      if (pathname === '/api/cobuy') return apiCobuy(env, searchParams);
      const m = pathname.match(/^\/api\/stock\/([1-9]\d{3})$/);
      if (m) return apiStock(env, m[1]);
      return json({ error: 'not_found' }, 404);
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env) {
    const res = await fetch(WORKFLOW_DISPATCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tw-inst-screener-cron',
      },
      body: JSON.stringify({ ref: 'master' }),
    });
    // 失敗就丟錯,讓 Cloudflare 的排程紀錄標示為失敗
    if (!res.ok) throw new Error(`workflow dispatch failed: ${res.status} ${await res.text()}`);
  },
};
