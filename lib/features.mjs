// 特徵計算(純函式)。規格 §6。
// 以交易日序列為軸(兩市場都完整的日期),不用日曆天。缺值不補 0;窗口內有效值少於 80% 時特徵為 null。
//
// 輸入(單一個股):
//   days     交易日 'YYYY-MM-DD' 由舊到新,最後一天是掃描日 t
//   inst     Map<date, {foreign_net, trust_net, dealer_net}>
//   price    Map<date, {open, high, low, close, volume, value}>
//   margin   Map<date, {margin_balance}>
//   qfii     Map<date, {issued_shares, foreign_ratio}>
//   tdcc     [{data_date, big400, big1000, retail, holders}] 由舊到新,呼叫端已依 point-in-time 過濾
//
// 法人缺列的語意(specs/endpoints.md「覆蓋率與缺值語意」):當天兩市場法人資料完整、
// 該股有收盤行情列卻沒有法人列,代表當天沒有法人交易 → 視為 0;連收盤行情都沒有(停牌等)才是缺值。

export const MIN_VALID_RATIO = 0.8;

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const avg = (xs) => sum(xs) / xs.length;

// 取窗口內的值;有效值少於 80% 回傳 null
function windowValues(days, n, get) {
  if (days.length < n) return null;
  const vals = days.slice(-n).map(get).filter((v) => v != null);
  return vals.length >= n * MIN_VALID_RATIO ? vals : null;
}

// t 往前第 n 個交易日(n=20 即 t−20)
const ago = (days, n) => (days.length > n ? days[days.length - 1 - n] : null);

const ratio = (a, b) => (a == null || b == null || b === 0 ? null : a / b);
const chg = (a, b) => { const r = ratio(a, b); return r == null ? null : r - 1; }; // a 相對 b 的變化率

export function computeFeatures({ days, inst, price, margin, qfii, tdcc }) {
  const t = days[days.length - 1];
  const t20 = ago(days, 20);
  const close = (d) => (d ? price.get(d)?.close ?? null : null);

  const instOf = (d) => inst.get(d) ?? (price.has(d) ? { foreign_net: 0, trust_net: 0, dealer_net: 0 } : null);
  const instNet = (d) => { const r = instOf(d); return r ? r.foreign_net + r.trust_net : null; };
  const trustNet = (d) => instOf(d)?.trust_net ?? null;
  const dealerNet = (d) => instOf(d)?.dealer_net ?? null;

  // 發行股數:取 t 或窗口內最近一筆(外資持股常晚於收盤行情公布,t 當天可能還沒有)
  const issued = days.slice(-20).reverse().map((d) => qfii.get(d)?.issued_shares).find((v) => v != null) ?? null;

  const net20 = windowValues(days, 20, instNet);
  const trust20 = windowValues(days, 20, trustNet);
  const dealer20 = windowValues(days, 20, dealerNet);
  const inst_net_20 = net20 && sum(net20);
  const pctOfIssued = (v) => (v == null || !issued ? null : (v / issued) * 100);

  const closes60 = windowValues(days, 60, close);
  const highs20 = windowValues(days, 20, (d) => price.get(d)?.high ?? null);
  const lows20 = windowValues(days, 20, (d) => price.get(d)?.low ?? null);
  const vol20 = windowValues(days, 20, (d) => price.get(d)?.volume ?? null);
  const vol60 = windowValues(days, 60, (d) => price.get(d)?.volume ?? null);
  const value20 = windowValues(days, 20, (d) => price.get(d)?.value ?? null);
  const closeT = close(t);

  const ratioAt = (d) => (d ? qfii.get(d)?.foreign_ratio ?? null : null);
  const marginAt = (d) => (d ? margin.get(d)?.margin_balance ?? null : null);
  const fr = ratioAt(t), fr20 = ratioAt(t20);
  const mT = marginAt(t), m20 = marginAt(t20);

  return {
    inst_net_20,
    inst_net_20_pct: pctOfIssued(inst_net_20),
    trust_net_20_pct: pctOfIssued(trust20 && sum(trust20)),
    inst_buy_days_20: net20 && net20.filter((v) => v > 0).length,
    foreign_ratio_chg_20: fr == null || fr20 == null ? null : fr - fr20,
    dealer_net_20_pct: pctOfIssued(dealer20 && sum(dealer20)),
    ret_20: chg(closeT, close(t20)),
    dist_ma60: closeT == null || !closes60 ? null : closeT / avg(closes60) - 1,
    range_20: closeT == null || !highs20 || !lows20 ? null : (Math.max(...highs20) - Math.min(...lows20)) / closeT,
    vol_ratio: vol20 && vol60 ? ratio(avg(vol20), avg(vol60)) : null,
    avg_value_20: value20 && avg(value20),
    margin_chg_20: chg(mT, m20),
    ...tdccFeatures(tdcc),
  };
}

// 集保特徵。tdcc 由舊到新;「4 週前」指往前數第 4 筆週資料
export function tdccFeatures(tdcc) {
  const n = tdcc.length;
  const last = tdcc[n - 1];
  const w4 = n > 4 ? tdcc[n - 5] : null;
  let upWeeks = null;
  if (n >= 2) {
    upWeeks = 0;
    for (let i = n - 1; i > 0 && tdcc[i].big400 > tdcc[i - 1].big400; i--) upWeeks++;
  }
  return {
    big400_pct: last?.big400 ?? null,
    big1000_pct: last?.big1000 ?? null,
    retail_pct: last?.retail ?? null,
    holders: last?.holders ?? null,
    big400_up_weeks: upWeeks,
    big400_chg_4w: last && w4 ? last.big400 - w4.big400 : null,
    holders_chg_4w_pct: last && w4 ? chg(last.holders, w4.holders) : null,
    retail_chg_4w: last && w4 ? last.retail - w4.retail : null,
    tdcc_weeks: n,
  };
}

// 價位與均線(給下游分析報告用,不參與評分)。同樣以交易日為軸、窗口有效值 < 80% 為 null。
// 回傳:close、prev_close(前一個交易日收盤)、ma5/ma10/ma20/ma60、volume(t 當日成交股數)、
//      vol_ma5/vol_ma20(股)、high_20/low_20、high_60/low_60(區間最高/最低價)
export function priceLevels({ days, price }) {
  const t = days[days.length - 1];
  const field = (key) => (d) => price.get(d)?.[key] ?? null;
  const mean = (n, key) => { const v = windowValues(days, n, field(key)); return v && avg(v); };
  const extreme = (n, key, fn) => { const v = windowValues(days, n, field(key)); return v && fn(...v); };
  return {
    close: price.get(t)?.close ?? null,
    prev_close: days.length > 1 ? price.get(days[days.length - 2])?.close ?? null : null,
    ma5: mean(5, 'close'),
    ma10: mean(10, 'close'),
    ma20: mean(20, 'close'),
    ma60: mean(60, 'close'),
    volume: price.get(t)?.volume ?? null,
    vol_ma5: mean(5, 'volume'),
    vol_ma20: mean(20, 'volume'),
    high_20: extreme(20, 'high', Math.max),
    low_20: extreme(20, 'low', Math.min),
    high_60: extreme(60, 'high', Math.max),
    low_60: extreme(60, 'low', Math.min),
  };
}
