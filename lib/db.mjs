// SQLite 存取:開檔、套 schema、upsert helper、交易。使用內建 node:sqlite(Node ≥ 22.13)。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 10000'); // 本機回補與 ingest 同時寫入時等待,不要直接報 database is locked
  db.exec(SCHEMA);
  return db;
}

// fn 內任何例外 → 整批 rollback 並往上拋
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 產生 INSERT ... ON CONFLICT(keys) DO UPDATE 的 statement;run(obj) 以欄位名稱綁定
export function upsertStmt(db, table, cols, keys) {
  const sets = cols.filter((c) => !keys.includes(c)).map((c) => `${c} = excluded.${c}`);
  const stmt = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})
     ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${sets.join(', ')}`,
  );
  return { run: (row) => stmt.run(row) };
}

export function logIngest(db, { source, date = null, status, rows = null, message = null }) {
  db.prepare('INSERT INTO ingest_log (source, date, status, rows, message) VALUES (?, ?, ?, ?, ?)')
    .run(source, date, status, rows, message);
}

// 兩市場都已寫入的日期
export function completeDates(db) {
  return new Set(db.prepare('SELECT date FROM trading_days WHERE twse_ok = 1 AND tpex_ok = 1').all().map((r) => r.date));
}

// 其他日期是否已有相同的 TWSE 指紋(代表 TWSE 把別天的資料重複回傳)
export function hasTwseFp(db, fp, exceptDate) {
  return !!db.prepare('SELECT 1 FROM trading_days WHERE twse_fp = ? AND date <> ?').get(fp, exceptDate);
}

// 寫入一天的法人資料(兩市場已到齊)。同一天重跑結果相同。
// stocks 的名稱/市場只會被「同一天或更新」的資料覆寫,避免 backfill 舊日期蓋掉新名稱。
export function writeInstDay(db, date, { twse, tpex, fp }) {
  const stock = db.prepare(
    `INSERT INTO stocks (code, name, market, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (code) DO UPDATE SET name = excluded.name, market = excluded.market, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= stocks.updated_at`,
  );
  const inst = upsertStmt(db, 'inst_daily', ['date', 'code', 'foreign_net', 'trust_net', 'dealer_net'], ['date', 'code']);
  const day = upsertStmt(db, 'trading_days', ['date', 'twse_ok', 'tpex_ok', 'twse_fp'], ['date']);

  return tx(db, () => {
    for (const [market, map] of [['TWSE', twse], ['TPEX', tpex]]) {
      for (const [code, v] of map) {
        stock.run(code, v.name, market, date);
        inst.run({ date, code, foreign_net: v.foreign, trust_net: v.trust, dealer_net: v.dealer });
      }
    }
    day.run({ date, twse_ok: 1, tpex_ok: 1, twse_fp: fp });
    return { twse: twse.size, tpex: tpex.size };
  });
}

// 寫入一個來源一天的資料(Map<code, row>),整批一個交易;同一天重跑結果相同
export function writeDailyRows(db, table, cols, date, map) {
  const stmt = upsertStmt(db, table, ['date', 'code', ...cols], ['date', 'code']);
  return tx(db, () => {
    for (const [code, row] of map) stmt.run({ date, code, ...Object.fromEntries(cols.map((c) => [c, row[c]])) });
    return map.size;
  });
}

// 該表在這一天是否已有某市場的資料(以 stocks.market 判斷市場;上市與上櫃分開抓,要分開補)
export function hasMarketRows(db, table, date, market) {
  return !!db.prepare(`SELECT 1 FROM ${table} t JOIN stocks s ON s.code = t.code WHERE t.date = ? AND s.market = ? LIMIT 1`).get(date, market);
}

// 寫入一檔或多檔某一週的集保分級(Map<code, levels>),整批一個交易
export function writeTdcc(db, dataDate, stocks, fetchedAt) {
  const stmt = upsertStmt(db, 'tdcc_weekly', ['data_date', 'code', 'level', 'people', 'shares', 'pct', 'fetched_at'], ['data_date', 'code', 'level']);
  return tx(db, () => {
    for (const [code, levels] of stocks) {
      for (const l of levels) stmt.run({ data_date: dataDate, code, level: l.level, people: l.people, shares: l.shares, pct: l.pct, fetched_at: fetchedAt });
    }
    return stocks.size;
  });
}

// 某週已寫入的代號
export function tdccCodes(db, dataDate) {
  return new Set(db.prepare('SELECT DISTINCT code FROM tdcc_weekly WHERE data_date = ?').all(dataDate).map((r) => r.code));
}

// 寫入一個市場一天的借券賣出(Map<code, {sbl_balance, sbl_sell, sbl_return}>),整批一個交易。
// fetched_at 只在第一次寫入時設定;重抓數值相同 → 不動(保留最早可取得的時間);
// 數值不同 → 更新數值與 fetched_at,並記一筆 'sbl revised'(rows = 被修正的檔數),才看得出官方事後修正。
// 同一天兩市場都有同一檔:TWSE 22:30 版會納入「原為上櫃、次日轉上市」的個股(官方 notes;實例 8908 欣雄 2026-10-15),
// 該檔 t 日實際在上櫃交易 → 以 TPEX 為準:TWSE 那筆略過;TPEX 覆蓋先寫入的 TWSE 那筆,不算修正。兩者都計入 crossMarket
export function writeSblDay(db, date, market, map, fetchedAt) {
  const KEYS = ['market', 'sbl_balance', 'sbl_sell', 'sbl_return'];
  const old = new Map(db.prepare('SELECT code, market, sbl_balance, sbl_sell, sbl_return FROM sbl_daily WHERE date = ?').all(date).map((r) => [r.code, r]));
  const stmt = upsertStmt(db, 'sbl_daily', ['date', 'code', ...KEYS, 'fetched_at'], ['date', 'code']);
  return tx(db, () => {
    let written = 0;
    let revised = 0;
    let crossMarket = 0;
    for (const [code, v] of map) {
      const row = { market, sbl_balance: v.sbl_balance, sbl_sell: v.sbl_sell, sbl_return: v.sbl_return };
      const prev = old.get(code);
      if (prev && prev.market !== market) {
        crossMarket++;
        if (market === 'TWSE') continue;
      } else if (prev && KEYS.every((k) => prev[k] === row[k])) {
        continue;
      } else if (prev) {
        revised++;
      }
      stmt.run({ date, code, ...row, fetched_at: fetchedAt });
      written++;
    }
    if (revised > 0) logIngest(db, { source: `${market.toLowerCase()}-sbl`, date, status: 'ok', rows: revised, message: 'sbl revised' });
    return { written, revised, crossMarket };
  });
}

// 借券最終版的時點:TWSE 每天約 20:30、22:30 各更新一次,22:30 那次才納入隔天轉上市的個股
// TODO(T2):TPEX 公布時間實測後確認是否適用同一時點
export const SBL_FINAL_AT = '22:30:00';

// 該日該市場的借券是否已是最終版:有資料,且最晚一筆是在當天 22:30 之後(或之後的日子)抓的。
// 20:30 版本(例如 GitHub 延遲的 20:00 備援排程)不算,下一次執行要重抓,才補得到 22:30 的版本
export function sblFinal(db, date, market) {
  const r = db.prepare('SELECT MAX(fetched_at) AS f FROM sbl_daily WHERE date = ? AND market = ?').get(date, market);
  return r.f != null && r.f >= `${date} ${SBL_FINAL_AT}`;
}

// 借券普通股列數下限 = 該市場「date 當天(沒有就往前最近一天)有行情」的普通股檔數 × ratio。
// 不用 stocks 檔數:stocks 只增不減,下市股會讓分母逐年變大。沒有行情可參考時回傳 null
export function sblMinRows(db, date, market, ratio = 0.8) {
  const r = db.prepare(`
    SELECT COUNT(*) AS n FROM price_daily p JOIN stocks s ON s.code = p.code
    WHERE s.market = :market AND p.date = (
      SELECT MAX(p2.date) FROM price_daily p2 JOIN stocks s2 ON s2.code = p2.code WHERE s2.market = :market AND p2.date <= :date)`)
    .get({ date, market });
  return r.n > 0 ? r.n * ratio : null;
}

// sbl_balance 超過發行股數(qfii_daily 同日)的代號;只用來記警告,不擋寫入(增減資時發行股數可能不同步)
export function sblOverIssued(db, date, map) {
  const issued = new Map(db.prepare('SELECT code, issued_shares FROM qfii_daily WHERE date = ? AND issued_shares IS NOT NULL').all(date).map((r) => [r.code, r.issued_shares]));
  return [...map].filter(([code, v]) => issued.has(code) && v.sbl_balance > issued.get(code)).map(([code]) => code);
}
