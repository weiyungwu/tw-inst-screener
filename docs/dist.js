'use strict';

// 正式階段在前;暫定、已大幅下跌分開(規格 §8.3),和正式階段之間有分隔
const TABS = [
  { stage: 'DISTRIBUTION', label: '疑似出貨' },
  { stage: 'CAUTION', label: '注意' },
  { stage: 'PROVISIONAL', label: '暫定', aside: true },
  { stage: 'COLLAPSED', label: '已大幅下跌', aside: true },
];
const STAGE_NOTE = {
  DISTRIBUTION: '分數 ≥ 70、資料覆蓋率 ≥ 85%。',
  CAUTION: '分數 55~69、資料覆蓋率 ≥ 85%。',
  PROVISIONAL: '資料不足,暫定,不可以當成正式結果:分數 ≥ 55,但資料覆蓋率不到 85%(常見原因是當晚借券資料還沒公布)。',
  COLLAPSED: '已大幅下跌,不適用高檔派發判斷。這是價格狀態,不代表下跌風險已經解除。',
};
const STALE_MS = 4 * 24 * 3600 * 1000; // 規格 §8.3:前端沒有交易日曆,4 天可涵蓋三天連假
const MARKET = { TWSE: '上市', TPEX: '上櫃' };

const state = {
  data: null,
  scan: null, // 版本比對用;載入失敗不影響清單
  stage: 'DISTRIBUTION',
  markets: { TWSE: true, TPEX: true },
  minScore: 0,
  sortKey: 'score',
  sortDir: -1,
  open: new Set(),
  versions: new Map(), // code → 'ok' | 'mismatch' | 'unknown'(/api/stock 的 distribution.run_id 比對結果)
};

const pct = (v, d = 1) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`);
const num = (v, d = 2) => (v == null ? '—' : v.toFixed(d));
const pp = (v, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`); // 已是 % 的值
const cls = (v) => (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const COLS = [
  { key: 'code', label: '代號', get: (s) => s.code, html: (s) => `<td class="code"><a class="code" href="https://tw.stock.yahoo.com/quote/${s.code}" target="_blank" rel="noopener">${s.code}</a></td>` },
  { key: 'name', label: '名稱', get: (s) => s.name, html: (s) => `<td>${esc(s.name)}</td>` },
  { key: 'market', label: '市場', get: (s) => s.market, html: (s) => `<td><span class="tag">${MARKET[s.market] ?? '—'}</span></td>` },
  { key: 'score', label: '分數', num: true, get: (s) => s.score, html: (s) => `<td class="score">${s.score}</td>` },
  { key: 'coverage', label: '覆蓋率', num: true, get: (s) => s.coverage, html: (s) => `<td class="cov${s.coverage < 0.85 ? ' low' : ''}">${Math.round(s.coverage * 100)}%</td>` },
  { key: 'inst_net_20_pct', label: '法人20日%股本', num: true, html: (s, f) => `<td class="${cls(f.inst_net_20_pct)}">${pp(f.inst_net_20_pct)}</td>` },
  { key: 'inst_sell_days_20', label: '法人賣超天', num: true, html: (s, f) => `<td>${f.inst_sell_days_20 ?? '—'}</td>` },
  { key: 'big400_down_weeks', label: '大戶連減週', num: true, html: (s, f) => `<td>${f.big400_down_weeks ?? '—'}</td>` },
  { key: 'drawdown_60', label: '距60日高', num: true, html: (s, f) => `<td class="${cls(f.drawdown_60)}">${pct(f.drawdown_60)}</td>` },
  { key: 'ret_20', label: '20日漲幅', num: true, html: (s, f) => `<td class="${cls(f.ret_20)}">${pct(f.ret_20)}</td>` },
  { key: 'sbl_chg_20_pct', label: '借券20日%股本', num: true, html: (s, f) => `<td>${pp(f.sbl_chg_20_pct)}</td>` },
  { key: 'signals', label: '訊號', html: (s) => `<td class="sigs">${signalTags(s.signals)}</td>` },
];

const SIGNALS = {
  inst_steady_sell: '法人持續賣', trust_selling: '投信賣超', big_holder_falling: '大戶連減', holders_rising: '股東增加',
  off_high: '高點回落', below_ma20: '跌破月線', dump_bar: '帶量長黑', sbl_rising: '借券增加', margin_rising: '融資增加',
  collapsed: '已大幅下跌', sbl_pending: '借券未公布', market_assumed: '市場別推定',
};
const HOT = new Set(['inst_steady_sell', 'dump_bar', 'sbl_rising']);
const FEATURE_NAMES = {
  inst_net_20_pct: '法人20日%股本', inst_sell_days_20: '法人賣超天數', big400_down_weeks: '大戶連減週數',
  holders_chg_4w_pct: '股東數4週變化', big400_chg_4w: '大戶4週變化', drawdown_60: '距60日高點', dist_ma60: '季線乖離',
  below_ma20: '跌破月線', dump_days_20: '帶量長黑天數', sbl_chg_20_pct: '借券20日變化', margin_chg_20: '融資20日變化',
};

function signalTags(signals) {
  return signals.filter((s) => SIGNALS[s]).map((s) => `<span class="sig${HOT.has(s) ? ' hot' : ''}">${SIGNALS[s]}</span>`).join('');
}

const sortValue = (s, key) => {
  const col = COLS.find((c) => c.key === key);
  return col.get ? col.get(s) : s.features[key];
};

// 規格 §8.3 的四種提示,符合的都顯示;另加借券累積不足(§7.5)。now 可注入,方便測試
function warnings(dist, scan, now = Date.now()) {
  const out = [];
  if (scan && dist.scan_date < scan.scan_date) out.push(`出貨結果停在 ${dist.scan_date},尚未更新到最新交易日。`);
  if (scan && dist.scan_date === scan.scan_date && dist.run_id !== scan.run_id) out.push('吸籌與出貨結果來自不同次更新,可能有一項更新失敗。');
  const pending = Object.entries(dist.sbl_status ?? {}).filter(([, v]) => v === 'pending').map(([m]) => MARKET[m] ?? m);
  if (pending.length) out.push(`今日${pending.join('、')}借券資料約 22:45 更新,信用與借券分數未計入。`);
  const updated = Date.parse(dist.updated_at);
  if (Number.isFinite(updated) && now - updated > STALE_MS) out.push('資料超過 4 天未更新,排程可能已停止。');
  if (dist.quality === 'sbl_warming_up') out.push('借券資料累積不足,信用與借券分數僅供參考。');
  return out;
}

async function getJson(url) {
  const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${Date.now()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function load() {
  try {
    state.data = await getJson('dist.json');
  } catch (e) {
    document.getElementById('meta').textContent = '無法載入資料(dist.json)。' + e;
    return;
  }
  try { state.scan = await getJson('scan.json'); } catch { state.scan = null; } // 只影響版本提示
  setupControls();
  render();
}

function setupControls() {
  const d = state.data;
  document.getElementById('meta').innerHTML =
    `資料日期:<strong>${esc(d.scan_date)}</strong>　|　更新時間:${esc(d.updated_at)}　|　借券最新:${esc(d.sbl_latest ?? '—')}　|　評分版本 ${esc(d.config_version)}`;
  document.getElementById('exp').hidden = !d.experimental;
  const warns = warnings(d, state.scan);
  if (!state.scan) warns.push('無法載入吸籌結果(scan.json),無法檢查兩邊的版本是否一致。');
  document.getElementById('warns').innerHTML = warns.map((w) => `<div class="warn">${esc(w)}</div>`).join('');

  const sel = document.getElementById('minScore');
  for (const v of [0, 55, 60, 70, 80]) sel.add(new Option(v === 0 ? '不限' : `${v} 分`, v));
  sel.onchange = () => { state.minScore = +sel.value; render(); };
  document.getElementById('mTWSE').onchange = (e) => { state.markets.TWSE = e.target.checked; render(); };
  document.getElementById('mTPEX').onchange = (e) => { state.markets.TPEX = e.target.checked; render(); };
}

function renderTabs() {
  const tabs = document.getElementById('tabs');
  let html = '';
  TABS.forEach((t, i) => {
    if (t.aside && !TABS[i - 1].aside) html += '<span class="sep"></span>';
    html += `<button data-stage="${t.stage}" class="${t.stage === state.stage ? 'on' : ''}${t.aside ? ' aside' : ''}">${t.label} ${state.data.counts[t.stage] ?? 0}</button>`;
  });
  tabs.innerHTML = html;
  tabs.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { state.stage = b.dataset.stage; state.open.clear(); render(); };
  });
  document.getElementById('stageNote').textContent = STAGE_NOTE[state.stage];
}

// 個股版本比對:/api/stock/:code 的 distribution.run_id 和 dist.json 的 run_id(規格 §8.3)
async function checkVersion(code) {
  if (state.versions.has(code)) return;
  state.versions.set(code, 'loading');
  try {
    const s = await getJson(`/api/stock/${code}`);
    const run = s.distribution?.run_id;
    state.versions.set(code, run == null ? 'unknown' : run === state.data.run_id && s.distribution.scan_date === state.data.scan_date ? 'ok' : 'mismatch');
  } catch {
    state.versions.set(code, 'unknown');
  }
  if (state.open.has(code)) render();
}

const VERSION_TEXT = {
  mismatch: '版本不一致:個股明細和清單來自不同次更新,可能有一項更新失敗。',
  unknown: '無法比對個股明細的版本。',
};

function detailRow(s) {
  const b = s.breakdown;
  const groups = [['法人調節', b.inst, 30], ['籌碼分散', b.dispersion, 25], ['高檔轉弱', b.price, 20], ['量能異常', b.volume, 10], ['信用與借券', b.credit, 15]];
  const bars = groups.map(([name, v, max]) =>
    `<span>${name}</span><span class="bar"><i style="width:${(v / max) * 100}%"></i></span><span>${v} / ${max}</span>`).join('');
  const missing = s.signals.filter((x) => x.startsWith('missing:')).map((x) => FEATURE_NAMES[x.slice(8)] ?? x.slice(8));
  const f = s.features;
  const sbl = `借券餘額占股本 ${f.sbl_ratio == null ? '—' : `${num(f.sbl_ratio)}%`}　借券20日變化 ${pp(f.sbl_chg_20_pct)}(占股本)　券資比 ${f.short_margin_ratio == null ? '—' : `${num(f.short_margin_ratio, 1)}%`}`;
  const extra = `收盤 ${s.close ?? '—'}　距60日高 ${pct(f.drawdown_60)}　季線乖離 ${pct(f.dist_ma60)}　帶量長黑 ${f.dump_days_20 ?? '—'} 天　股東數4週 ${pct(f.holders_chg_4w_pct)}　融資20日 ${pct(f.margin_chg_20)}`;
  const v = state.versions.get(s.code);
  return `<tr class="detail"><td colspan="${COLS.length}">
    <div class="bars">${bars}</div>
    <div class="muted">${sbl}</div>
    <div class="muted">${extra}</div>
    ${missing.length ? `<div class="muted">資料不足、該項 0 分(不代表沒有風險):${missing.join('、')}</div>` : ''}
    ${VERSION_TEXT[v] ? `<div class="muted warn-text">${VERSION_TEXT[v]}</div>` : ''}
  </td></tr>`;
}

function render() {
  renderTabs();
  const { sortKey, sortDir } = state;
  const rows = state.data.stocks
    .filter((s) => s.stage === state.stage && state.markets[s.market] && s.score >= state.minScore)
    .sort((a, b) => {
      const av = sortValue(a, sortKey), bv = sortValue(b, sortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
      return (av - bv) * sortDir;
    });

  const head = document.getElementById('headRow');
  head.innerHTML = COLS.map((c) => {
    const arrow = c.key === sortKey ? `<span class="arrow">${sortDir < 0 ? '▼' : '▲'}</span>` : '';
    return `<th data-key="${c.key}">${c.label} ${arrow}</th>`;
  }).join('');
  head.querySelectorAll('th').forEach((th) => {
    const k = th.dataset.key;
    if (k === 'signals') { th.style.cursor = 'default'; return; }
    th.onclick = () => {
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = COLS.find((c) => c.key === k).num ? -1 : 1; }
      render();
    };
  });

  const body = document.getElementById('body');
  body.innerHTML = rows.map((s) =>
    `<tr data-code="${s.code}">${COLS.map((c) => c.html(s, s.features)).join('')}</tr>${state.open.has(s.code) ? detailRow(s) : ''}`).join('');
  body.querySelectorAll('tr[data-code]').forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest('a')) return;
      const code = tr.dataset.code;
      if (state.open.has(code)) state.open.delete(code);
      else { state.open.add(code); checkVersion(code); }
      render();
    };
  });

  document.getElementById('count').textContent = `${rows.length} 檔`;
  document.getElementById('empty').hidden = rows.length > 0;
}

if (typeof document !== 'undefined') load();
if (typeof module !== 'undefined') module.exports = { warnings };
