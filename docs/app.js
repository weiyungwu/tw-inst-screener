'use strict';

const state = {
  data: null,
  sumDays: 10,
  streakDays: 5,
  markets: { TWSE: true, TPEX: true },
  insts: { foreign: true, trust: false, dealer: true }, // 勾選的法人須「各自」符合條件
  sortKey: 'foreignSum',
  sortDir: -1, // -1 由大到小
};

const COLS = [
  { key: 'code', label: '代號', num: false },
  { key: 'name', label: '名稱', num: false },
  { key: 'market', label: '市場', num: false },
  { key: 'foreignSum', label: '外資累計', num: true },
  { key: 'trustSum', label: '投信累計', num: true },
  { key: 'dealerSum', label: '自營累計', num: true },
  { key: 'foreignStreak', label: '外資連買', num: true },
  { key: 'trustStreak', label: '投信連買', num: true },
  { key: 'dealerStreak', label: '自營連買', num: true },
  { key: 'daily', label: '每日(外資/投信/自營)', num: false, cls: 'daily' },
];

const sum = (a) => a.reduce((p, c) => p + c, 0);
const fmt = (n) => (n > 0 ? '+' : '') + n.toLocaleString('en-US');
const sign = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
const INSTS = ['foreign', 'trust', 'dealer'];
function tailStreak(arr) { // 從最後一天往前數連續 > 0 的天數
  let c = 0;
  for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] > 0) c++; else break; }
  return c;
}

async function load() {
  try {
    const r = await fetch('data.json?_=' + Date.now());
    state.data = await r.json();
  } catch (e) {
    document.getElementById('meta').textContent = '無法載入資料(data.json)。' + e;
    return;
  }
  setupControls();
  render();
}

function setupControls() {
  const d = state.data;
  const total = d.trading_days.length;
  // 預設天數不可超過實際資料天數,否則選單顯示與實際篩選不一致
  state.sumDays = Math.min(state.sumDays, total);
  state.streakDays = Math.min(state.streakDays, total);
  const meta = document.getElementById('meta');
  meta.innerHTML =
    `<span>更新時間 <strong>${d.updated_at}</strong></span><span class="days">交易日 ${d.trading_days.join('、')}</span>`;

  const sumSel = document.getElementById('sumDays');
  const stSel = document.getElementById('streakDays');
  for (let i = 1; i <= total; i++) {
    sumSel.add(new Option(i + ' 日', i, false, i === state.sumDays));
    stSel.add(new Option(i + ' 日', i, false, i === state.streakDays));
  }
  sumSel.onchange = () => { state.sumDays = +sumSel.value; render(); };
  stSel.onchange = () => { state.streakDays = +stSel.value; render(); };
  document.getElementById('mTWSE').onchange = (e) => { state.markets.TWSE = e.target.checked; render(); };
  document.getElementById('mTPEX').onchange = (e) => { state.markets.TPEX = e.target.checked; render(); };
  for (const k of INSTS) {
    const el = document.getElementById('i_' + k);
    el.checked = state.insts[k];
    el.onchange = () => { state.insts[k] = el.checked; render(); };
  }
}

function compute() {
  const total = state.data.trading_days.length;
  const sw = Math.min(state.sumDays, total);
  const kw = Math.min(state.streakDays, total);
  const picked = INSTS.filter((k) => state.insts[k]);
  const rows = [];
  if (picked.length === 0) return rows; // 沒勾任何法人 → 不列出
  for (const s of state.data.stocks) {
    if (!state.markets[s.market]) continue;
    const r = { code: s.code, name: s.name, market: s.market };
    for (const k of INSTS) {
      const daily = s[k + '_daily'] || new Array(total).fill(0); // 舊版 data.json 無 trust_daily
      r[k + '_daily'] = daily;
      r[k + 'Sum'] = sum(daily.slice(total - sw));
      r[k + 'Streak'] = tailStreak(daily);
    }
    // 勾選的法人都要:累計 > 0 且連買達門檻
    if (picked.every((k) => r[k + 'Sum'] > 0 && r[k + 'Streak'] >= kw)) rows.push(r);
  }
  return rows;
}

function render() {
  const rows = compute();
  const { sortKey, sortDir } = state;
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
    return (av - bv) * sortDir;
  });

  // 表頭
  const head = document.getElementById('headRow');
  head.innerHTML = COLS.map((c) => {
    const arrow = c.key === sortKey ? `<span class="arrow">${sortDir < 0 ? '▼' : '▲'}</span>` : '';
    return `<th data-key="${c.key}" class="${c.cls || ''}">${c.label} ${arrow}</th>`;
  }).join('');
  head.querySelectorAll('th').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.key;
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = COLS.find((c) => c.key === k).num ? -1 : 1; }
      render();
    };
  });

  // 內容
  const body = document.getElementById('body');
  body.innerHTML = rows.map((r) => {
    const daily = r.foreign_daily.map((f, i) =>
      `${f}/${r.trust_daily[i]}/${r.dealer_daily[i]}`).join(' ');
    return `<tr data-code="${r.code}">
      <td class="code">${r.code}</td>
      <td>${r.name}</td>
      <td><span class="tag">${r.market === 'TWSE' ? '上市' : '上櫃'}</span></td>
      <td class="${sign(r.foreignSum)}">${fmt(r.foreignSum)}</td>
      <td class="${sign(r.trustSum)}">${fmt(r.trustSum)}</td>
      <td class="${sign(r.dealerSum)}">${fmt(r.dealerSum)}</td>
      <td>${r.foreignStreak}</td>
      <td>${r.trustStreak}</td>
      <td>${r.dealerStreak}</td>
      <td class="daily">${daily}</td>
    </tr>`;
  }).join('');
  body.querySelectorAll('tr').forEach((tr) => {
    tr.onclick = () => window.open(`https://tw.stock.yahoo.com/quote/${tr.dataset.code}`, '_blank');
  });

  document.getElementById('count').textContent = `符合 ${rows.length} 檔`;
  document.getElementById('empty').hidden = rows.length > 0;
}

load();
