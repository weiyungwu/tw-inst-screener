PRAGMA journal_mode = WAL;

-- 交易日曆（由 calendar.mjs 判定；兩市場都拿到才算完整）
CREATE TABLE IF NOT EXISTS trading_days (
  date        TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
  twse_ok     INTEGER NOT NULL DEFAULT 0,
  tpex_ok     INTEGER NOT NULL DEFAULT 0,
  twse_fp     INTEGER,                   -- T86 指紋（外資淨買超總和）
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stocks (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  market      TEXT NOT NULL CHECK (market IN ('TWSE','TPEX')),
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inst_daily (
  date         TEXT NOT NULL,
  code         TEXT NOT NULL,
  foreign_net  INTEGER NOT NULL,          -- 外資含陸資＋外資自營商（股）
  trust_net    INTEGER NOT NULL,          -- 投信（股）
  dealer_net   INTEGER NOT NULL,          -- 自營商合計（股）
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS price_daily (
  date     TEXT NOT NULL,
  code     TEXT NOT NULL,
  open     REAL, high REAL, low REAL, close REAL,  -- 無成交時為 NULL，不填 0
  volume   INTEGER,                                -- 成交股數
  value    INTEGER,                                -- 成交金額（元）
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS margin_daily (
  date            TEXT NOT NULL,
  code            TEXT NOT NULL,
  margin_balance  INTEGER,               -- 融資餘額（張，官方單位）
  short_balance   INTEGER,               -- 融券餘額（張）
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS qfii_daily (
  date            TEXT NOT NULL,
  code            TEXT NOT NULL,
  issued_shares   INTEGER,               -- 發行股數（股）
  foreign_shares  INTEGER,
  foreign_ratio   REAL,                  -- %
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS tdcc_weekly (
  data_date  TEXT NOT NULL,              -- 集保資料日期 'YYYY-MM-DD'
  code       TEXT NOT NULL,
  level      INTEGER NOT NULL,           -- 1..17
  people     INTEGER NOT NULL,
  shares     INTEGER NOT NULL,
  pct        REAL NOT NULL,
  fetched_at TEXT NOT NULL,              -- 實際抓到的時間（回測時用來對齊公布時點）
  PRIMARY KEY (data_date, code, level)
);

-- 每日掃描結果（保存全部個股的特徵，供日後回測與調權重）
CREATE TABLE IF NOT EXISTS scan_daily (
  date       TEXT NOT NULL,
  code       TEXT NOT NULL,
  score      INTEGER NOT NULL,
  stage      TEXT NOT NULL,
  features   TEXT NOT NULL,              -- JSON
  signals    TEXT NOT NULL,              -- JSON array
  PRIMARY KEY (date, code)
);

-- 借券賣出（出貨掃描器）；fetched_at 只在第一次寫入或數值被官方修正時更新
CREATE TABLE IF NOT EXISTS sbl_daily (
  date         TEXT NOT NULL,
  code         TEXT NOT NULL,
  market       TEXT NOT NULL CHECK (market IN ('TWSE','TPEX')),  -- 當日資料來自哪個市場
  sbl_balance  INTEGER,                -- 借券賣出當日餘額（股）
  sbl_sell     INTEGER,                -- 當日借券賣出（股）
  sbl_return   INTEGER,                -- 當日還券（股）
  fetched_at   TEXT NOT NULL,          -- 實際抓到的時間（台北），回測時用來對齊可取得時點
  PRIMARY KEY (date, code)
);

-- 出貨掃描結果（股票池 universe(t) 內全部個股，供回測；特徵已存在 scan_daily.features，不重複存）
CREATE TABLE IF NOT EXISTS dist_daily (
  date           TEXT NOT NULL,
  code           TEXT NOT NULL,
  score          INTEGER NOT NULL,       -- 原始分數，不依覆蓋率放大
  coverage       REAL NOT NULL,          -- 可計算的配分 ÷ 100
  stage          TEXT NOT NULL,
  breakdown      TEXT NOT NULL,          -- JSON
  signals        TEXT NOT NULL,          -- JSON array
  config_version TEXT NOT NULL,
  run_id         TEXT,                   -- GitHub Actions 的 GITHUB_RUN_ID；本機執行為 'local'
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS ingest_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at    TEXT NOT NULL DEFAULT (datetime('now')),
  source    TEXT NOT NULL,
  date      TEXT,
  status    TEXT NOT NULL CHECK (status IN ('ok','empty','error','skipped')),
  rows      INTEGER,
  message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_inst_code   ON inst_daily(code, date);
CREATE INDEX IF NOT EXISTS idx_price_code  ON price_daily(code, date);
CREATE INDEX IF NOT EXISTS idx_margin_code ON margin_daily(code, date);
CREATE INDEX IF NOT EXISTS idx_qfii_code   ON qfii_daily(code, date);
CREATE INDEX IF NOT EXISTS idx_tdcc_code   ON tdcc_weekly(code, data_date);
CREATE INDEX IF NOT EXISTS idx_sbl_code    ON sbl_daily(code, date);
