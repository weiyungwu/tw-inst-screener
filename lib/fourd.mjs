// 四維燈號(純函式)。規則見 specs/stock-4d-3d-trade-report_v4.md §5,
// 但「V5」與「60 日最高」改用不含當天的窗口(vol_ma5_prev、high_59_prev),避免當天數值跟自己比。
// 每顆燈 'red'(偏多)、'green'(不成立)、null(資料不足,不可當成綠燈)。
//
// 輸入:features(computeFeatures)、levels(priceLevels)
// 回傳:{ chip, volume, ma, pattern, red(紅燈數), valid(有效燈數,扣除 null) }

export const FOUR_D = {
  chip: { netPct: 0.2, buyDays: 10 }, // inst_net_20_pct ≥ 0.2%、inst_buy_days_20 ≥ 10、inst_net_5 > 0
  volume: { surge: 1.5, healthy: [1.0, 1.8], blackBar: { vol: 2, drop: -0.03 } },
};

const has = (...xs) => xs.every((x) => x != null);
const light = (ok) => (ok == null ? null : ok ? 'red' : 'green');

export function fourD({ features: f, levels: L }, C = FOUR_D) {
  const { close: c, prev_close: p, volume: v, vol_ma5_prev: v5 } = L;

  const chip = has(f.inst_net_20_pct, f.inst_buy_days_20, f.inst_net_5)
    ? f.inst_net_20_pct >= C.chip.netPct && f.inst_buy_days_20 >= C.chip.buyDays && f.inst_net_5 > 0
    : null;

  let volume = null;
  if (has(c, p, v, v5, f.vol_ratio)) {
    const surge = v >= C.volume.surge * v5 && c > p; // 帶量上攻
    const blackBar = v >= C.volume.blackBar.vol * v5 && c / p - 1 <= C.volume.blackBar.drop; // 爆量長黑
    const healthy = f.vol_ratio >= C.volume.healthy[0] && f.vol_ratio <= C.volume.healthy[1] && !blackBar;
    volume = surge || healthy;
  }

  const ma = has(c, L.ma5, L.ma10, L.ma20, L.ma60) ? c > L.ma5 && c > L.ma10 && c > L.ma20 && c > L.ma60 : null;

  const pattern = has(c, L.high_19_prev, L.high_59_prev) ? c > L.high_19_prev || c >= L.high_59_prev : null;

  const lights = { chip: light(chip), volume: light(volume), ma: light(ma), pattern: light(pattern) };
  const vals = Object.values(lights);
  return { ...lights, red: vals.filter((x) => x === 'red').length, valid: vals.filter((x) => x != null).length };
}

// 四維偏空燈號(純函式,出貨頁用;只顯示、不計入出貨分數)。和偏多燈號左右對稱,
// 均線、型態沿用 stock-dist-risk-report v1.1 §5 結構檢查的定義(「趨勢偏空」與「疑似假突破」)。
// 每顆燈 true(偏空成立)、false(未轉弱)、null(資料不足,不可當成 false)。
//
// 輸入:features、levels(同 fourD)、series(近 20 日,由舊到新)
// 回傳:{ chip, volume, ma, pattern, bear(偏空燈數), valid(有效燈數) }

export const FOUR_D_BEAR = {
  chip: { netPct: -0.2, sellDays: 10 }, // inst_net_20_pct ≤ −0.2%、inst_sell_days_20 ≥ 10、inst_net_5 < 0
  volume: { surge: 1.5 }, // 當天量 ≥ 前 5 日均量 × 1.5 且收黑;或 20 日內帶量長黑 ≥ 1 天
  fakeBreakDays: 20, // 疑似假突破:前 10 日最高 R,近 10 日曾收盤 > R,最新收盤 < R
};

// 任一成立 → true;全部能判斷且都不成立 → false;其餘(有缺資料又沒有成立的)→ null
const anyOf = (...xs) => (xs.includes(true) ? true : xs.every((x) => x === false) ? false : null);

function fakeBreakout(series, n) {
  if (!series || series.length < n) return null;
  const k = series.slice(-n);
  if (k.some((d) => d.high == null || d.close == null)) return null;
  const half = n / 2;
  const R = Math.max(...k.slice(0, half).map((d) => d.high));
  return k.slice(half).some((d) => d.close > R) && k[n - 1].close < R;
}

export function fourDBear({ features: f, levels: L, series }, C = FOUR_D_BEAR) {
  const { close: c, prev_close: p, volume: v, vol_ma5_prev: v5 } = L;

  const chip = has(f.inst_net_20_pct, f.inst_sell_days_20, f.inst_net_5)
    ? f.inst_net_20_pct <= C.chip.netPct && f.inst_sell_days_20 >= C.chip.sellDays && f.inst_net_5 < 0
    : null;

  const surgeDown = has(c, p, v, v5) ? v >= C.volume.surge * v5 && c < p : null; // 帶量下跌
  const dumped = f.dump_days_20 == null ? null : f.dump_days_20 >= 1;
  const volume = anyOf(surgeDown, dumped);

  const ma = has(c, L.ma5, L.ma20) ? c < L.ma20 && L.ma5 < L.ma20 : null;

  const breakdown = has(c, L.low_19_prev) ? c < L.low_19_prev : null; // 跌破前 19 日低點
  const pattern = anyOf(breakdown, fakeBreakout(series, C.fakeBreakDays));

  const lights = { chip, volume, ma, pattern };
  const vals = Object.values(lights);
  return { ...lights, bear: vals.filter((x) => x === true).length, valid: vals.filter((x) => x != null).length };
}
