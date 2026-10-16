// ===========================================================================
// calibrate-dist.mjs — 出貨評分校準報告(一次性分析,不進正式 workflow)。規格 §11 P3。
//
// 執行:  TZ=Asia/Taipei node scripts/calibrate-dist.mjs [--out specs/distribution-calibration.md]
// 唯讀:只讀 history.sqlite,不寫任何資料表。
//
// 逐日重算(每個前面滿 60 個交易日的 t):特徵 → 吸籌與出貨評分 → 5/20 日前瞻報酬(lib/forward.mjs)。
// 兩層報告:
//   長期歷史:集保只有近幾週,較早日期「籌碼分散」整組為 null(coverage ≤ 0.75,階段幾乎都是 PROVISIONAL)。
//            所以用不含籌碼分散的子分數(滿分 75)驗證其餘四組:(1) 子分數五分位 (2) 門檻依比例換算的代理名單
//   完整模型:集保 ≥ 5 週的日期,看實際階段分布、逐一移除特徵、和吸籌重疊
// 回測的 point-in-time:
//   集保只用 data_date < t 的週(回補資料的 fetched_at 是回補當下,不能拿來篩;規格 §6 同樣理由)
//   股票池與 market(t) 依 §7.6(pointInTimeUniverse);前瞻報酬從 t+1 開盤起算
// 大盤:DB 沒有加權指數,以當天可評分個股 ret_20 的中位數代替
// ===========================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { computeFeatures } from '../lib/features.mjs';
import { scoreStock } from '../lib/score.mjs';
import { scoreDistribution, pointInTimeUniverse, CONFIG as D, WEIGHTS } from '../lib/distribution.mjs';
import { forwardReturn, REASONS } from '../lib/forward.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH ?? join(ROOT, 'data', 'history.sqlite');
const { values: args } = parseArgs({ options: { out: { type: 'string', default: join(ROOT, 'specs', 'distribution-calibration.md') } } });

const WINDOW = 61;
const HORIZONS = [5, 20];
const FULL_TDCC_WEEKS = 5; // big400_chg_4w 需要 5 週
const DISPERSION = ['big400_down_weeks', 'holders_chg_4w_pct', 'big400_chg_4w'];
const SCORING = Object.keys(WEIGHTS);
const SUB_MAX = 100 - DISPERSION.reduce((a, k) => a + WEIGHTS[k], 0); // 75
const SUB_SCALE = SUB_MAX / 100;
const MIN_OOS_DAYS = 15;
const MISSING_GAP_PP = 5;

// ---------- 小工具 ----------
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function pearson(a, b) {
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}
// 兩兩都有值的樣本才計入
function spearman(pairs) {
  if (pairs.length < 10) return null;
  return pearson(ranks(pairs.map((p) => p[0])), ranks(pairs.map((p) => p[1])));
}
const pct = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
const num = (v, d = 2) => (v == null ? '—' : v.toFixed(d));
const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');

// ---------- 載入 ----------
function load() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const days = db.prepare('SELECT date FROM trading_days WHERE twse_ok = 1 AND tpex_ok = 1 ORDER BY date').all().map((r) => r.date);
  const byCode = (sql) => {
    const out = new Map();
    for (const r of db.prepare(sql).iterate()) {
      if (!out.has(r.code)) out.set(r.code, new Map());
      out.get(r.code).set(r.date, r);
    }
    return out;
  };
  const price = byCode('SELECT date, code, open, high, low, close, volume, value FROM price_daily');
  const inst = byCode('SELECT date, code, foreign_net, trust_net, dealer_net FROM inst_daily');
  const margin = byCode('SELECT date, code, margin_balance, short_balance FROM margin_daily');
  const qfii = byCode('SELECT date, code, issued_shares, foreign_ratio FROM qfii_daily');
  const sblRows = db.prepare('SELECT date, code, market, sbl_balance FROM sbl_daily').all();
  const sbl = new Map();
  for (const r of sblRows) {
    if (!sbl.has(r.code)) sbl.set(r.code, new Map());
    sbl.get(r.code).set(r.date, r);
  }
  const tdcc = new Map();
  for (const r of db.prepare(`
    SELECT code, data_date,
      100.0 * SUM(CASE WHEN level BETWEEN 12 AND 15 THEN shares ELSE 0 END) / MAX(CASE WHEN level = 17 THEN shares END) AS big400,
      100.0 * SUM(CASE WHEN level = 15 THEN shares ELSE 0 END) / MAX(CASE WHEN level = 17 THEN shares END) AS big1000,
      100.0 * SUM(CASE WHEN level BETWEEN 1 AND 8 THEN shares ELSE 0 END) / MAX(CASE WHEN level = 17 THEN shares END) AS retail,
      MAX(CASE WHEN level = 17 THEN people END) AS holders
    FROM tdcc_weekly GROUP BY code, data_date HAVING MAX(CASE WHEN level = 17 THEN shares END) > 0
    ORDER BY code, data_date`).iterate()) {
    if (!tdcc.has(r.code)) tdcc.set(r.code, []);
    tdcc.get(r.code).push(r);
  }
  const tdccDates = db.prepare('SELECT DISTINCT data_date AS d FROM tdcc_weekly ORDER BY d').all().map((r) => r.d);
  const stocks = new Map(db.prepare('SELECT code, market FROM stocks').all().map((r) => [r.code, r.market]));
  const codesByDate = new Map();
  for (const [code, m] of price) for (const d of m.keys()) {
    if (!codesByDate.has(d)) codesByDate.set(d, []);
    codesByDate.get(d).push(code);
  }
  db.close();
  return { days, price, inst, margin, qfii, sbl, sblRows, tdcc, tdccDates, stocks, codesByDate };
}

// 不含籌碼分散的代理階段:門檻依 75/100 比例換算;EXCLUDED/COLLAPSED 沿用實際判斷
function proxyStage(r, f) {
  if (r.stage === 'EXCLUDED' || r.stage === 'COLLAPSED') return r.stage;
  const sub = r.score - r.breakdown.dispersion;
  const covered = SCORING.filter((k) => !DISPERSION.includes(k) && f[k] != null).reduce((a, k) => a + WEIGHTS[k], 0);
  if (covered < D.minCoveragePoints * SUB_SCALE) return sub >= D.stages.caution * SUB_SCALE ? 'PROVISIONAL' : 'NEUTRAL';
  if (sub >= D.stages.distribution * SUB_SCALE) return 'DISTRIBUTION';
  if (sub >= D.stages.caution * SUB_SCALE) return 'CAUTION';
  return 'NEUTRAL';
}

// ---------- 逐日評分 ----------
function replay(L) {
  const empty = new Map();
  const marketsOf = new Map([...L.sbl].map(([code, m]) => [code, new Map([...m].map(([d, r]) => [d, r.market]))]));
  const sblDates = [...new Set(L.sblRows.map((r) => r.date))].sort();
  const out = []; // 每天 { t, tdccWeeks, universe, marketAssumed, rows: [...] }
  const skipped = []; // 借券資料不完整的日期(例如當天還沒公布):不納入回測,報告列出
  for (let i = WINDOW - 2; i < L.days.length; i++) {
    const t = L.days[i];
    const days = L.days.slice(Math.max(0, i - WINDOW + 1), i + 1);
    if (days.length < 60) continue;
    const sblMarkets = new Set(L.sblRows.filter((r) => r.date === t).map((r) => r.market));
    if (sblMarkets.size < 2) { skipped.push(t); continue; }
    const universe = pointInTimeUniverse({
      t, priceRows: (L.codesByDate.get(t) ?? []).map((code) => ({ date: t, code })), sblRows: L.sblRows, stocks: L.stocks,
    });
    const sblToday = sblMarkets;
    const sblWarmingUp = sblDates.filter((d) => d <= t).length < 21;
    const tdccWeeks = L.tdccDates.filter((d) => d < t).length;
    const rows = [];
    for (const [code, u] of universe) {
      const f = computeFeatures({
        days, price: L.price.get(code) ?? empty, inst: L.inst.get(code) ?? empty, margin: L.margin.get(code) ?? empty,
        qfii: L.qfii.get(code) ?? empty, tdcc: (L.tdcc.get(code) ?? []).filter((w) => w.data_date < t), sbl: L.sbl.get(code) ?? empty,
      });
      const acc = scoreStock(f);
      const dist = scoreDistribution(f, { sblPending: !sblToday.has(u.market), sblWarmingUp, marketAssumed: u.market_assumed });
      const fwd = Object.fromEntries(HORIZONS.map((n) => [n, forwardReturn({ days: L.days, t, n, price: L.price.get(code) ?? empty, marketT: u.market, markets: marketsOf.get(code) ?? empty })]));
      rows.push({ code, market: u.market, f, acc: acc.stage, dist, proxy: proxyStage(dist, f), sub: dist.score - dist.breakdown.dispersion, fwd });
    }
    out.push({ t, tdccWeeks, universe: universe.size, marketAssumed: [...universe.values()].filter((u) => u.market_assumed).length, rows });
    process.stderr.write(`\r逐日評分 ${t}(${out.length})`);
  }
  process.stderr.write('\n');
  return { R: out, skipped };
}

// ---------- 報告各段 ----------
const scorable = (r) => r.dist.stage !== 'EXCLUDED';
const STAGES = ['DISTRIBUTION', 'CAUTION', 'PROVISIONAL', 'COLLAPSED', 'NEUTRAL'];

function sectionUniverse(R) {
  const first = R[0], last = R.at(-1);
  const assumed = R.reduce((a, d) => a + d.marketAssumed, 0);
  const lines = [`- 逐日評分 ${R.length} 天(${first.t} ~ ${last.t});股票池每天 ${Math.min(...R.map((d) => d.universe))} ~ ${Math.max(...R.map((d) => d.universe))} 檔。`,
    `- \`market_assumed\` 合計 ${assumed} 檔日(每天 ${Math.min(...R.map((d) => d.marketAssumed))} ~ ${Math.max(...R.map((d) => d.marketAssumed))} 檔)。`];
  const rows = R.map((d) => [d.t, d.universe, d.marketAssumed, d.rows.filter(scorable).length, d.tdccWeeks]);
  return `${lines.join('\n')}\n\n<details><summary>每日股票池檔數</summary>\n\n${table(['日期', '股票池', 'market_assumed', '可評分', '集保週數'], rows)}\n\n</details>`;
}

function stageShare(days, key) {
  const share = Object.fromEntries(STAGES.map((s) => [s, []]));
  for (const d of days) {
    const sc = d.rows.filter(scorable);
    for (const s of STAGES) share[s].push(sc.filter((r) => key(r) === s).length / (sc.length || 1));
  }
  return share;
}

function sectionDistribution(R, full) {
  const out = [];
  const fullShare = stageShare(full, (r) => r.dist.stage);
  out.push(`**完整模型(集保 ≥ ${FULL_TDCC_WEEKS} 週,${full.length} 天)**:各階段占可評分的每日平均比例`);
  out.push(table(STAGES, [STAGES.map((s) => pct(mean(fullShare[s])))]));
  const dShare = mean(fullShare.DISTRIBUTION);
  out.push(dShare == null ? '' : dShare > 0.05 ? `\n⚠ DISTRIBUTION 平均 ${pct(dShare)},超過 5% 目標。` : `\nDISTRIBUTION 平均 ${pct(dShare)},在 5% 目標內。`);
  const proxyShare = stageShare(R, (r) => r.proxy);
  out.push(`\n**代理名單(不含籌碼分散、門檻 × ${SUB_SCALE},${R.length} 天)**:各階段占可評分的每日平均比例`);
  out.push(table(STAGES, [STAGES.map((s) => pct(mean(proxyShare[s])))]));

  // 每個計分項的得分率:有值的可評分個股中,這一項拿到分數的比例(接近 100% 代表幾乎人人得分、沒有分辨力)
  const ITEM = {
    inst_net_20_pct: (f) => f.inst_net_20_pct <= D.inst.netPct.at(-1)[0],
    inst_sell_days_20: (f) => f.inst_sell_days_20 >= D.inst.sellDays.at(-1)[0],
    big400_down_weeks: (f) => f.big400_down_weeks >= D.dispersion.downWeeks.at(-1)[0],
    holders_chg_4w_pct: (f) => f.holders_chg_4w_pct > D.dispersion.holdersRise[0],
    big400_chg_4w: (f) => f.big400_chg_4w <= D.dispersion.big400Chg[0],
    drawdown_60: (f) => f.drawdown_60 >= D.price.drawdown[0] && f.drawdown_60 <= D.price.drawdown[1],
    dist_ma60: (f) => f.dist_ma60 >= D.price.distMa60[0],
    below_ma20: (f) => f.below_ma20 === true,
    dump_days_20: (f) => f.dump_days_20 >= D.dump.at(-1)[0],
    sbl_chg_20_pct: (f) => f.sbl_chg_20_pct >= D.credit.sblChg.at(-1)[0],
    margin_chg_20: (f) => f.margin_chg_20 > D.credit.marginRise[0],
  };
  const rows = SCORING.map((k) => {
    const src = DISPERSION.includes(k) ? full : R;
    const vals = src.flatMap((d) => d.rows.filter(scorable)).filter((r) => r.f[k] != null);
    const hit = vals.filter((r) => ITEM[k](r.f)).length / (vals.length || 1);
    return [k, WEIGHTS[k], DISPERSION.includes(k) ? `完整 ${full.length} 天` : `全部 ${R.length} 天`, vals.length, pct(hit), hit > 0.5 ? '⚠ 過半得分' : ''];
  });
  out.push(`\n**各計分項得分率**(有值的可評分個股中拿到分數的比例)`);
  out.push(table(['特徵', '配分', '資料期間', '樣本', '得分率', ''], rows));
  return out.join('\n');
}

function sectionIncrement(R, full) {
  const out = [];
  const pool = R.flatMap((d) => d.rows.filter(scorable));
  const fullPool = full.flatMap((d) => d.rows.filter(scorable));
  const val = (r, k) => (r.f[k] == null ? null : typeof r.f[k] === 'boolean' ? +r.f[k] : r.f[k]);
  const head = ['', ...SCORING];
  const rows = SCORING.map((a) => [a, ...SCORING.map((b) => {
    if (a === b) return '1';
    const src = DISPERSION.includes(a) || DISPERSION.includes(b) ? fullPool : pool;
    const pairs = src.map((r) => [val(r, a), val(r, b)]).filter(([x, y]) => x != null && y != null);
    const s = spearman(pairs);
    return s == null ? '—' : Math.abs(s) >= 0.6 ? `**${num(s)}**` : num(s);
  })]);
  out.push('**Spearman 相關係數**(可評分個股日;含籌碼分散特徵的配對只用完整模型期間;|ρ| ≥ 0.6 加粗)');
  out.push(table(head, rows));

  // 逐一移除:該特徵改為不給分(coverage 不變),重新分類,統計 DISTRIBUTION 名單的變動(出 + 入)
  const drop = (src, key, list) => SCORING.map((k) => {
    let changed = 0, base = 0;
    for (const d of src) for (const r of d.rows.filter(scorable)) {
      const before = key(r.dist, r.f) === list;
      const f2 = { ...r.f, [k]: k === 'below_ma20' ? false : r.f[k] == null ? null : NEUTRAL_VALUE[k] };
      const after = key(scoreDistribution(f2, {}), f2) === list; // 改成不給分的值(仍有值),coverage 不變
      if (before) base++;
      if (before !== after) changed++;
    }
    return [k, base, changed, base ? pct(changed / base) : '—'];
  });
  out.push(`\n**逐一移除特徵(完整模型 ${full.length} 天):DISTRIBUTION 名單變動**`);
  out.push(table(['移除的特徵', '原名單檔日', '變動檔日', '變動比例'], drop(full, (r) => r.stage, 'DISTRIBUTION')));
  out.push(`\n**逐一移除特徵(代理名單 ${R.length} 天):代理 DISTRIBUTION 名單變動**(籌碼分散特徵在代理名單本來就不計)`);
  out.push(table(['移除的特徵', '原名單檔日', '變動檔日', '變動比例'], drop(R, (r, f) => proxyStage(r, f), 'DISTRIBUTION').filter(([k]) => !DISPERSION.includes(k))));
  return out.join('\n');
}
// 讓該項一定 0 分的特徵值(保留有值,所以 coverage 不變)
const NEUTRAL_VALUE = {
  inst_net_20_pct: 0, inst_sell_days_20: 0, big400_down_weeks: 0, holders_chg_4w_pct: 0, big400_chg_4w: 0,
  drawdown_60: 0, dist_ma60: 0, below_ma20: false, dump_days_20: 0, sbl_chg_20_pct: 0, margin_chg_20: 0,
};

// 前瞻:名單 vs 比較組。名單 key(r) 回傳階段;每天各自取中位數,再看每日超額(名單 − 比較組)
function forwardBlock(days, key, lists, label) {
  const out = [];
  for (const n of HORIZONS) {
    const matured = days.filter((d) => d.rows.some((r) => r.fwd[n].status !== 'not_matured'));
    out.push(`\n**${label}:${n} 日**(已走完 ${matured.length} 天)`);
    if (!matured.length) { out.push('樣本不足,無法判斷(沒有走完的期間)。'); continue; }
    const rows = [];
    const missRows = [];
    const missRate = (rs) => {
      const m = rs.filter((r) => r.fwd[n].status !== 'not_matured');
      return m.length ? m.filter((r) => r.fwd[n].status !== 'valid').length / m.length : null;
    };
    for (const list of [...lists, 'NEUTRAL']) {
      const ex = { all: [], liq: [], neutral: [] }, rets = [], maes = [];
      let validN = 0;
      const reasons = Object.fromEntries(REASONS.map((x) => [x, 0]));
      let mkt = 0;
      const allRows = [];
      for (const d of matured) {
        const sc = d.rows.filter(scorable);
        const inList = sc.filter((r) => key(r) === list);
        allRows.push(...inList);
        for (const r of inList) {
          const s = r.fwd[n].status;
          if (s === 'valid') validN++; else reasons[s]++;
          if (r.fwd[n].market_changed) mkt++;
        }
        const v = (rs) => rs.filter((r) => r.fwd[n].status === 'valid');
        const L = v(inList);
        if (!L.length) continue;
        const med = median(L.map((r) => r.fwd[n].ret));
        rets.push(med);
        maes.push(median(L.map((r) => r.fwd[n].mae)));
        const allMed = median(v(sc).map((r) => r.fwd[n].ret));
        const neuMed = median(v(sc.filter((r) => key(r) === 'NEUTRAL')).map((r) => r.fwd[n].ret));
        // 流動性三等分:依當天可評分個股的 avg_value_20 排序
        const sorted = [...sc].sort((a, b) => a.f.avg_value_20 - b.f.avg_value_20);
        const tier = new Map(sorted.map((r, i) => [r.code, Math.min(2, Math.floor((3 * i) / sorted.length))]));
        const liqEx = L.map((r) => r.fwd[n].ret - median(v(sc.filter((x) => tier.get(x.code) === tier.get(r.code))).map((x) => x.fwd[n].ret)));
        ex.all.push(med - allMed);
        if (neuMed != null) ex.neutral.push(med - neuMed);
        ex.liq.push(median(liqEx));
      }
      const neg = (xs) => (xs.length ? pct(xs.filter((x) => x < 0).length / xs.length, 0) : '—');
      rows.push([list, rets.length, validN, pct(mean(rets)), pct(mean(maes)), `${pct(mean(ex.all))}(${neg(ex.all)})`, `${pct(mean(ex.liq))}(${neg(ex.liq)})`, list === 'NEUTRAL' ? '—' : `${pct(mean(ex.neutral))}(${neg(ex.neutral)})`]);
      missRows.push([list, validN, ...REASONS.map((x) => reasons[x]), mkt, pct(missRate(allRows))]);
    }
    out.push(table(['名單', '有樣本天數', '有效檔日', '每日中位數報酬(平均)', '每日中位數最大不利(平均)', '超額 vs 全部(負的天數比)', '超額 vs 同流動性', '超額 vs NEUTRAL'], rows));
    const base = missRows.find((r) => r[0] === 'NEUTRAL');
    const parse = (s) => (s === '—' ? null : parseFloat(s) / 100);
    for (const r of missRows) {
      const gap = parse(r.at(-1)) != null && parse(base.at(-1)) != null ? Math.abs(parse(r.at(-1)) - parse(base.at(-1))) : null;
      r.push(r[0] !== 'NEUTRAL' && gap != null && gap > MISSING_GAP_PP / 100 ? `⚠ 差 ${(gap * 100).toFixed(1)} 個百分點` : '');
    }
    out.push(`\n缺值(§7.7;缺值率不含 not_matured;和 NEUTRAL 差距 > ${MISSING_GAP_PP} 個百分點標 ⚠)`);
    out.push(table(['名單', '有效', ...REASONS, 'market_changed', '缺值率', ''], missRows));
  }
  return out.join('\n');
}

function sectionQuintiles(days) {
  const out = [];
  for (const n of HORIZONS) {
    const matured = days.filter((d) => d.rows.some((r) => r.fwd[n].status !== 'not_matured'));
    if (!matured.length) { out.push(`\n${n} 日:樣本不足,無法判斷。`); continue; }
    const byQ = [[], [], [], [], []];
    const exByQ = [[], [], [], [], []];
    for (const d of matured) {
      const sc = d.rows.filter((r) => scorable(r) && r.dist.stage !== 'COLLAPSED' && r.fwd[n].status === 'valid');
      if (sc.length < 50) continue;
      const allMed = median(sc.map((r) => r.fwd[n].ret));
      const sorted = [...sc].sort((a, b) => a.sub - b.sub);
      for (let q = 0; q < 5; q++) {
        const part = sorted.slice(Math.floor((q * sorted.length) / 5), Math.floor(((q + 1) * sorted.length) / 5));
        const m = median(part.map((r) => r.fwd[n].ret));
        byQ[q].push(m);
        exByQ[q].push(m - allMed);
      }
    }
    out.push(`\n**子分數五分位 × ${n} 日前瞻報酬**(${byQ[0].length} 天;每天把可評分、非 COLLAPSED、報酬有效的個股依子分數分 5 組;Q5 = 子分數最高)`);
    out.push(table(['組別', '每日中位數報酬(平均)', '超額 vs 當天全部(平均)', '超額為負的天數比'], byQ.map((xs, q) => [`Q${q + 1}`, pct(mean(xs)), pct(mean(exByQ[q])), pct(exByQ[q].filter((x) => x < 0).length / (exByQ[q].length || 1), 0)])));
  }
  return out.join('\n');
}

function sectionMarket(R, full) {
  const out = [];
  const daily = R.map((d) => {
    const sc = d.rows.filter(scorable);
    return { t: d.t, n: sc.filter((r) => r.proxy === 'DISTRIBUTION').length, mkt: median(sc.map((r) => r.f.ret_20).filter((v) => v != null)) };
  });
  const rho = spearman(daily.map((d) => [d.n, d.mkt]));
  out.push(`- 代理 DISTRIBUTION 每日檔數 vs 大盤代理(可評分個股 ret_20 中位數)的 Spearman:**${num(rho)}**(${daily.length} 天)。|ρ| 越接近 1,名單越像是在跟大盤走。`);
  const fullDaily = full.map((d) => {
    const sc = d.rows.filter(scorable);
    const overlap = sc.filter((r) => r.dist.stage === 'DISTRIBUTION' && r.acc === 'ACCUMULATION');
    const prov = sc.filter((r) => r.dist.stage === 'PROVISIONAL');
    const reasons = {};
    for (const r of prov) for (const s of r.dist.signals) if (s.startsWith('missing:') || s === 'sbl_pending') reasons[s] = (reasons[s] ?? 0) + 1;
    return [d.t, sc.filter((r) => r.dist.stage === 'DISTRIBUTION').length, pct(median(sc.map((r) => r.f.ret_20).filter((v) => v != null))), overlap.length, overlap.map((r) => r.code).join(' ') || '—', prov.length, Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join('、') || '—'];
  });
  out.push(`\n**完整模型每日**:DISTRIBUTION 檔數、和 ACCUMULATION 重疊(§7.4,有重疊就列出,不自動處理)、PROVISIONAL 與原因`);
  out.push(table(['日期', 'DISTRIBUTION', '大盤代理 ret_20', '和 ACCUMULATION 重疊', '重疊代號', 'PROVISIONAL', 'PROVISIONAL 的缺值原因'], fullDaily));
  out.push(`\n<details><summary>代理名單每日檔數與大盤代理</summary>\n\n${table(['日期', '代理 DISTRIBUTION', '大盤代理 ret_20'], daily.map((d) => [d.t, d.n, pct(d.mkt)]))}\n\n</details>`);
  return out.join('\n');
}

function main() {
  const L = load();
  const { R, skipped } = replay(L);
  if (!R.length) throw new Error('沒有前面滿 60 個交易日的掃描日');
  const full = R.filter((d) => d.tdccWeeks >= FULL_TDCC_WEEKS);
  // 樣本外:以 20 日已走完的日期切前 2/3、後 1/3(門檻沒有用任何一段調整過,兩段都只是報告)
  const m20 = R.filter((d) => d.rows.some((r) => r.fwd[20].status !== 'not_matured'));
  const cut = Math.floor((m20.length * 2) / 3);
  const front = m20.slice(0, cut), back = m20.slice(cut);
  const proxyKey = (r) => r.proxy;
  const LISTS = ['DISTRIBUTION', 'CAUTION'];

  const md = [
    '# 出貨評分校準報告(P3)',
    [
      `> 產生方式:\`TZ=Asia/Taipei node scripts/calibrate-dist.mjs\` · 評分版本 \`${D.version}\` · 產生時間 ${new Date().toISOString()}`,
      `> 資料:交易日 ${L.days[0]} ~ ${L.days.at(-1)}(${L.days.length} 天);集保週 ${L.tdccDates[0] ?? '—'} ~ ${L.tdccDates.at(-1) ?? '—'}(${L.tdccDates.length} 週)`,
      '> 本檔由腳本產生的部分是數據;結論與建議另外寫在「摘要」一節。',
    ].join('\n'),
    '## 方法與限制',
    [
      `- 逐日重算每個前面滿 60 個交易日的 t。股票池與市場別依 §7.6;前瞻報酬從 t+1 開盤起算,缺值依 §7.7 分類。`,
      `- 兩市場借券資料不完整的日期不納入(當天還沒公布等):${skipped.join('、') || '無'}。`,
      `- 集保只用 \`data_date\` < t 的週。較早的日期沒有集保,「籌碼分散」整組(${100 - SUB_MAX} 分)為 null,coverage 最多 ${SUB_SCALE},實際階段幾乎都是 PROVISIONAL。`,
      `- 所以長期歷史用**子分數**(不含籌碼分散,滿分 ${SUB_MAX})驗證,並用門檻 × ${SUB_SCALE} 的**代理名單**(DISTRIBUTION ≥ ${D.stages.distribution * SUB_SCALE}、CAUTION ≥ ${D.stages.caution * SUB_SCALE})比照 §11 P3 的比較組。正式評分**不**依覆蓋率放大(§2.4),代理名單只用於這份分析。`,
      `- 完整模型(含籌碼分散)只在集保 ≥ ${FULL_TDCC_WEEKS} 週的 ${full.length} 天評估:${full.map((d) => d.t).join('、') || '無'}。`,
      '- 大盤:DB 沒有加權指數,以當天可評分個股 `ret_20` 的中位數代替。',
      '- 門檻沒有用任何一段資料調整過。',
    ].join('\n'),
    '',
    '## 股票池(§7.6)',
    sectionUniverse(R),
    '',
    '## 1. 分布',
    sectionDistribution(R, full),
    '',
    '## 2. 特徵增量測試',
    sectionIncrement(R, full),
    '',
    '## 3. 前瞻驗證',
    sectionQuintiles(R),
    forwardBlock(R, proxyKey, LISTS, '代理名單(全部期間)'),
    forwardBlock(full, (r) => r.dist.stage, LISTS, '完整模型'),
    '',
    '## 4. 樣本外',
    `- 以 20 日前瞻已走完的 ${m20.length} 天切分:前段 ${front.length} 天(${front[0]?.t ?? '—'} ~ ${front.at(-1)?.t ?? '—'})、後段 ${back.length} 天(${back[0]?.t ?? '—'} ~ ${back.at(-1)?.t ?? '—'})。`,
    back.length < MIN_OOS_DAYS ? `- **後段只有 ${back.length} 天,少於 ${MIN_OOS_DAYS} 天:樣本不足,無法判斷。**` : '',
    forwardBlock(front, proxyKey, LISTS, '前段(代理名單)'),
    forwardBlock(back, proxyKey, LISTS, '後段(代理名單)'),
    '',
    '## 5. 市場狀態與吸籌重疊',
    sectionMarket(R, full),
    '',
  ];
  writeFileSync(args.out, md.filter((l) => l !== '').join('\n\n').replace(/\n{3,}/g, '\n\n'));
  process.stderr.write(`輸出 ${args.out}\n`);
}

main();
