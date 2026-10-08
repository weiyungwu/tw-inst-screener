// 法人同步買超篩選(純函式),供 Worker /api/cobuy 使用。
// 規則必須與網頁 docs/app.js 的 compute() 完全相同(test/cobuy.test.mjs 逐一比對):
//   勾選的每個法人「各自」都要:最近 days 日加總 > 0,且從最後一天往前連續買超(> 0)天數 ≥ streak。
//   連買天數以整段資料計算(不受 days 限制);days、streak 超過資料天數時以資料天數為準。

export const INSTS = ['foreign', 'trust', 'dealer'];

const sum = (a) => a.reduce((p, c) => p + c, 0);
function tailStreak(arr) {
  let c = 0;
  for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] > 0) c++; else break; }
  return c;
}

// data:data.json;opts:{ days, streak, insts: ['foreign', ...], markets: ['TWSE','TPEX'] }
// 回傳符合的個股(未排序),欄位:code、name、market、<inst>_sum、<inst>_streak、<inst>_daily
export function cobuy(data, { days = 10, streak = 5, insts = ['foreign', 'dealer'], markets = ['TWSE', 'TPEX'] } = {}) {
  const total = data.trading_days.length;
  const sw = Math.min(days, total);
  const kw = Math.min(streak, total);
  if (insts.length === 0) return [];
  const rows = [];
  for (const s of data.stocks) {
    if (!markets.includes(s.market)) continue;
    const r = { code: s.code, name: s.name, market: s.market };
    for (const k of INSTS) {
      const daily = s[`${k}_daily`] || new Array(total).fill(0);
      r[`${k}_sum`] = sum(daily.slice(total - sw));
      r[`${k}_streak`] = tailStreak(daily);
      r[`${k}_daily`] = daily;
    }
    if (insts.every((k) => r[`${k}_sum`] > 0 && r[`${k}_streak`] >= kw)) rows.push(r);
  }
  return rows;
}
