'use strict';

const TABS = [
  { stage: 'ACCUMULATION', label: '吸籌' },
  { stage: 'WATCH', label: '觀察' },
  { stage: 'OVERHEATED', label: '過熱' },
];

const state = {
  data: null,
  stage: 'ACCUMULATION',
  markets: { TWSE: true, TPEX: true },
  minScore: 0,
  sortKey: 'score',
  sortDir: -1,
  open: new Set(), // 展開 breakdown 的代號
};

const pct = (v, d = 1) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(d)}%`); // 變化率,帶正負號
const share = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`); // 比例,不帶正負號
const num = (v, d = 2) => (v == null ? '—' : v.toFixed(d));
const cls = (v) => (v == null ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// 欄位:get 取排序用的值,html 產生儲存格
const COLS = [
  { key: 'code', label: '代號', get: (s) => s.code, html: (s) => `<td class="code"><a class="code" href="https://tw.stock.yahoo.com/quote/${s.code}" target="_blank" rel="noopener">${s.code}</a></td>` },
  { key: 'name', label: '名稱', get: (s) => s.name, html: (s) => `<td>${esc(s.name)}</td>` },
  { key: 'market', label: '市場', get: (s) => s.market, html: (s) => `<td><span class="tag">${s.market === 'TWSE' ? '上市' : '上櫃'}</span></td>` },
  { key: 'score', label: '分數', num: true, get: (s) => s.score, html: (s) => `<td class="score"><span class="lvl${s.score >= 70 ? ' hi' : s.score >= 55 ? ' mid' : ''}">${s.score}</span></td>` },
  { key: 'inst_net_20_pct', label: '法人20日%股本', num: true, html: (s, f) => `<td class="${cls(f.inst_net_20_pct)}">${f.inst_net_20_pct == null ? '—' : `${f.inst_net_20_pct > 0 ? '+' : ''}${num(f.inst_net_20_pct)}%`}</td>` },
  { key: 'inst_buy_days_20', label: '法人買超天', num: true, html: (s, f) => `<td>${f.inst_buy_days_20 ?? '—'}</td>` },
  { key: 'big400_pct', label: '大戶400張%(連增週)', num: true, html: (s, f) => `<td>${num(f.big400_pct)}${f.big400_up_weeks ? ` <span class="pos">(+${f.big400_up_weeks})</span>` : ''}</td>` },
  { key: 'holders_chg_4w_pct', label: '股東數4週', num: true, html: (s, f) => `<td class="${cls(-f.holders_chg_4w_pct)}">${pct(f.holders_chg_4w_pct)}</td>` },
  { key: 'ret_20', label: '20日漲幅', num: true, html: (s, f) => `<td class="${cls(f.ret_20)}">${pct(f.ret_20)}</td>` },
  { key: 'vol_ratio', label: '量比', num: true, html: (s, f) => `<td>${num(f.vol_ratio)}</td>` },
  { key: 'margin_chg_20', label: '融資20日', num: true, html: (s, f) => `<td class="${cls(f.margin_chg_20)}">${pct(f.margin_chg_20)}</td>` },
  { key: 'lights', label: '四維', num: true, get: (s) => s.lights?.red, html: (s) => `<td class="lights">${lightDots(s.lights)}</td>` },
  { key: 'signals', label: '訊號', html: (s) => `<td class="sigs">${signalTags(s.signals)}</td>` },
];

const SIGNALS = {
  inst_steady_buy: '法人緩買', trust_buying: '投信買超', big_holder_rising: '大戶連增', holders_declining: '股東減少',
  price_quiet: '價格未動', box_compression: '箱型收斂', volume_mild: '量能溫和', margin_exit: '融資退場', overheated: '過熱',
};
const FEATURE_NAMES = {
  inst_net_20_pct: '法人20日%股本', inst_buy_days_20: '法人買超天數', big400_up_weeks: '大戶連增週數',
  holders_chg_4w_pct: '股東數4週變化', big400_chg_4w: '大戶4週變化', ret_20: '20日漲幅', dist_ma60: '季線乖離',
  range_20: '20日振幅', vol_ratio: '量比', margin_chg_20: '融資20日變化',
};

// 四維燈號:紅 = 偏多、綠 = 不成立、灰 = 資料不足(台股紅漲綠跌慣例)
const LIGHTS = [['chip', '籌碼'], ['volume', '量能'], ['ma', '均線'], ['pattern', '型態']];
const LIGHT_TEXT = { red: '偏多', green: '不成立' };
function lightDots(l) {
  if (!l) return '—';
  return LIGHTS.map(([k, name]) => `<i class="dot ${l[k] ?? 'na'}" title="${name}:${LIGHT_TEXT[l[k]] ?? '資料不足'}"></i>`).join('') + `<span class="red-n">${l.red}</span>`;
}

// 全域品質旗標(tdcc_warming_up)與缺值標籤不在列上重複顯示,缺值放在展開明細
function signalTags(signals) {
  return signals.filter((s) => SIGNALS[s]).map((s) => `<span class="sig${s === 'overheated' ? ' hot' : ''}">${SIGNALS[s]}</span>`).join('');
}

const sortValue = (s, key) => {
  const col = COLS.find((c) => c.key === key);
  return col.get ? col.get(s) : s.features[key];
};

async function load() {
  try {
    const r = await fetch('scan.json?_=' + Date.now());
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.data = await r.json();
  } catch (e) {
    document.getElementById('meta').textContent = '無法載入資料(scan.json)。' + e;
    return;
  }
  setupControls();
  render();
}

function setupControls() {
  const d = state.data;
  document.getElementById('meta').innerHTML =
    `<span>掃描日 <strong>${d.scan_date}</strong></span><span>更新時間 ${esc(d.updated_at)}</span><span>集保最新 ${d.tdcc_latest ?? '—'}(累積 ${d.tdcc_weeks} 週)</span>`;
  document.getElementById('warn').hidden = d.quality !== 'tdcc_warming_up';

  const sel = document.getElementById('minScore');
  for (const v of [0, 40, 45, 50, 55, 60, 70, 80]) sel.add(new Option(v === 0 ? '不限' : `${v} 分`, v));
  sel.onchange = () => { state.minScore = +sel.value; render(); };
  document.getElementById('mTWSE').onchange = (e) => { state.markets.TWSE = e.target.checked; render(); };
  document.getElementById('mTPEX').onchange = (e) => { state.markets.TPEX = e.target.checked; render(); };
}

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = TABS.map((t) =>
    `<button data-stage="${t.stage}" class="${t.stage === state.stage ? 'on' : ''}">${t.label}<span class="n">${state.data.counts[t.stage] ?? 0}</span></button>`).join('');
  tabs.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { state.stage = b.dataset.stage; state.open.clear(); render(); };
  });
}

function detailRow(s) {
  const b = s.breakdown;
  const groups = [['法人緩買', b.inst, 30], ['籌碼集中', b.concentration, 30], ['價格未動', b.price, 20], ['量能溫和', b.volume, 10], ['融資退場', b.margin, 10]];
  const bars = groups.map(([name, v, max]) =>
    `<span>${name}</span><span class="bar"><i style="width:${(v / max) * 100}%"></i></span><span>${v} / ${max}</span>`).join('');
  const missing = s.signals.filter((x) => x.startsWith('missing:')).map((x) => FEATURE_NAMES[x.slice(8)] ?? x.slice(8));
  const f = s.features;
  const extra = `收盤 ${s.close ?? '—'}　季線乖離 ${pct(f.dist_ma60)}　20日振幅 ${share(f.range_20)}　外資持股20日 ${f.foreign_ratio_chg_20 == null ? '—' : `${num(f.foreign_ratio_chg_20)} 個百分點`}　投信20日%股本 ${num(f.trust_net_20_pct)}%　千張大戶 ${num(f.big1000_pct)}%　股東 ${f.holders?.toLocaleString('en-US') ?? '—'} 人`;
  return `<tr class="detail"><td colspan="${COLS.length}">
    <div class="bars">${bars}</div>
    <div class="muted">${extra}</div>
    ${missing.length ? `<div class="muted">資料不足、該項 0 分:${missing.join('、')}</div>` : ''}
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
      if (av == null) return 1; // 缺值一律排最後
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
      if (e.target.closest('a')) return; // 點代號開 Yahoo,不展開
      const code = tr.dataset.code;
      if (state.open.has(code)) state.open.delete(code); else state.open.add(code);
      render();
    };
  });

  document.getElementById('count').textContent = `${rows.length} 檔`;
  document.getElementById('empty').hidden = rows.length > 0;
}

load();
