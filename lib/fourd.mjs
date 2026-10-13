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
