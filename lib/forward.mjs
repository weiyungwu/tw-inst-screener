// 前瞻報酬(純函式,回測用)。出貨規格 §6、§7.7、§11 P3。
// 出貨分數在 t 日 22:45 才知道(借券晚公布),所以從 t+1 開盤進場:
//   ret = close(t+N) ÷ open(t+1) − 1
//   mae = max(high, t+1..t+N) ÷ open(t+1) − 1   (最大不利變動:對出貨名單而言,不利是價格往上)
// 結果一定是 valid 或下列缺值原因之一,不可默默剔除;delisted 不可算成 0,也不可用最後收盤價補:
//   not_matured    t+N 晚於 DB 最新交易日
//   delisted       最後一筆行情早於 t+N,之後再也沒出現
//   no_entry       t+1 沒有開盤價
//   other_missing  期間內某天沒有資料列但之後又出現(停牌股仍有資料列,沒有列代表漏抓);
//                  或期間內換市場且價格有中斷(轉市場當天的行情漏抓)
//   suspended      期間內某天有資料列但沒有收盤價或最高價
// market_changed 不是缺值:期間內 market 和 market(t) 不同但價格連續,照常計算,另外標示。
//
// 輸入:days 全部交易日(由舊到新)、t、n、price Map<date, {open, high, close}>(該檔全部日期)、
//      marketT market(t)、markets Map<date, market>(該檔借券資料的市場,可省略)
export const REASONS = ['not_matured', 'delisted', 'no_entry', 'other_missing', 'suspended'];

export function forwardReturn({ days, t, n, price, marketT = null, markets = new Map() }) {
  const i = days.indexOf(t);
  if (i < 0) throw new Error(`${t} 不在交易日序列中`);
  const end = i + n;
  if (end >= days.length) return { status: 'not_matured' };

  const window = days.slice(i + 1, end + 1);
  const lastRow = [...price.keys()].reduce((a, b) => (b > a ? b : a), '');
  if (lastRow < days[end]) return { status: 'delisted' };

  const entry = price.get(window[0])?.open;
  if (entry == null) return { status: 'no_entry' };

  const marketChanged = marketT != null && window.some((d) => markets.has(d) && markets.get(d) !== marketT);
  if (window.some((d) => !price.has(d))) return { status: 'other_missing', market_changed: marketChanged };
  if (window.some((d) => price.get(d).close == null || price.get(d).high == null)) {
    return { status: marketChanged ? 'other_missing' : 'suspended', market_changed: marketChanged };
  }

  const exit = price.get(days[end]).close;
  const high = Math.max(...window.map((d) => price.get(d).high));
  return { status: 'valid', ret: exit / entry - 1, mae: high / entry - 1, market_changed: marketChanged };
}
