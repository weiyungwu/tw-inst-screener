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
// 數值不同 → 更新數值與 fetched_at,並記一筆 'sbl revised'(rows = 被修正的檔數),才看得出官方事後修正
export function writeSblDay(db, date, market, map, fetchedAt) {
  const KEYS = ['market', 'sbl_balance', 'sbl_sell', 'sbl_return'];
  const old = new Map(db.prepare('SELECT code, market, sbl_balance, sbl_sell, sbl_return FROM sbl_daily WHERE date = ?').all(date).map((r) => [r.code, r]));
  const stmt = upsertStmt(db, 'sbl_daily', ['date', 'code', ...KEYS, 'fetched_at'], ['date', 'code']);
  return tx(db, () => {
    let written = 0;
    let revised = 0;
    for (const [code, v] of map) {
      const row = { market, ...v };
      const prev = old.get(code);
      if (prev && KEYS.every((k) => prev[k] === row[k])) continue;
      stmt.run({ date, code, ...row, fetched_at: fetchedAt });
      written++;
      if (prev) revised++;
    }
    if (revised > 0) logIngest(db, { source: `${market.toLowerCase()}-sbl`, date, status: 'ok', rows: revised, message: 'sbl revised' });
    return { written, revised };
  });
}
