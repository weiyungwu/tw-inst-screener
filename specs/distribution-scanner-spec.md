# SPEC：主力出貨掃描器（Distribution Scanner）v0 草案

> 專案：`tw-inst-screener`（weiyungwu/tw-inst-screener）
> 版本：v0.2 草案 · 2026-10-16（**尚未實作，門檻待校準**）
> v0.2：借券資料晚公布的處理方式定案，新增台北 22:45 排程（§5.1、§13 第 1 項）。
> 前置文件：[accumulation-scanner-spec.md](accumulation-scanner-spec.md)（吸籌掃描器）、[endpoints.md](endpoints.md)
> 本文件是實作規格。請**依 Phase 順序**實作，每個 Phase 完成後停下來回報，等使用者確認再繼續。

---

## 0. 執行規則

沿用吸籌規格 §0 的所有規則（零 npm 依賴、Node ≥ 22.13、缺值不補 0、Asia/Taipei、請求間隔 ≥ 3 秒、不 commit 資料檔），另外再加上下面幾條：

1. 開新分支 `feat/distribution-scanner`，PR 的 base 是 **`weiyungwu:master`**（本 repo 是 fork，不可以開到上游）。
2. **吸籌掃描器的行為不可以改變**：
   - `lib/score.mjs` 的 `CONFIG` 和 `scoreStock()` 不動。
   - `scan_daily` 的欄位不動，`scan.json` 的格式不動。
   - `features` 只能**新增**欄位，不可以改既有欄位的定義。
   - 驗收方式：同一個 DB 在改動前後跑 `score.mjs`，`scan_daily` 的 `score`、`stage`、`signals` 要完全相同。
3. 出貨評分放在獨立模組 `lib/distribution.mjs`，有自己的 `CONFIG` 和 `config_version`（從 `d-v0.1` 開始），兩邊的門檻不共用。
4. Commit 訊息格式：`feat(dist): P<n> <摘要>`。

---

## 1. 背景與目標

### 1.1 現況
- 現有的三個功能都只找偏多的股票：首頁法人同步買超、吸籌評分（`lib/score.mjs`）、四維燈號（`lib/fourd.mjs`）。
- `margin_daily.short_balance`（融券餘額）每天都有寫入，但沒有任何特徵用到它。
- 台股主要的放空管道是**借券賣出**，外資幾乎都走這條路，量也遠大於融券，但目前完全沒有抓這份資料。

### 1.2 目標
新增一個「**主力高檔出貨**」掃描器，是吸籌掃描器的反面。四類訊號同時成立時才列入：

| 層 | 問題 | 資料 |
|---|---|---|
| L1 法人流量 | 外資和投信是否持續、溫和地淨賣？ | 三大法人買賣超、外資持股 |
| L2 籌碼分散 | 大戶持股比例下降、股東人數增加？ | 集保股權分散表（每週） |
| L3 價量行為 | 價格還在相對高檔，但已經開始轉弱，或量增價滯？ | 每日收盤行情 |
| L4 信用與借券 | 融資增加（散戶接手）、借券賣出餘額增加？ | 融資融券、**借券賣出（新增）** |

### 1.3 非目標（v0 不做）
- 放空建議、停損價、自動下單。
- 區分借券賣出的用途：避險、套利，還是真的看空。官方資料沒有這項拆分，見 §9。
- 個股期貨與選擇權的未平倉量。
- 首頁的「法人同步賣超」切換。這個功能另外開一個小 PR，不在本規格範圍內。

---

## 2. 架構

### 2.1 決策紀錄
| 決策 | 選擇 | 理由 |
|---|---|---|
| 評分模組 | 新增 `lib/distribution.mjs`，不擴充 `score.mjs` | 吸籌已經有 v1.1 的歷史資料，混在一起改會讓回測分不清楚版本 |
| 結果存放 | 新增 `dist_daily` 表 | `scan_daily` 的主鍵是 (date, code)，一檔一天只能有一組分數和階段 |
| 特徵計算 | 擴充 `computeFeatures()` 的輸出 | 兩個掃描器共用同一份特徵，`features/<n>.json` 也只產一份 |
| 放空指標 | 計分用**借券賣出**，融券只用來顯示 | 融券在除權息和股東會前會強制回補，餘額會突然歸零，雜訊太大（§9） |

### 2.2 資料流
```
ingest-daily.mjs ── 新增 twse-sbl / tpex-sbl ──▶ sbl_daily
score.mjs ── computeFeatures()（新增空方特徵）
          ├─▶ scoreStock()      ─▶ scan_daily、scan.json（不變）
          └─▶ scoreDistribution() ─▶ dist_daily、dist.json（新增）
```

---

## 3. 資料來源：借券賣出（已實測）

> 實測日期：2026-10-16，探測交易日 2026-10-15。P0 要把這一節搬到 `endpoints.md`，並存 fixture。

### 3.1 總覽
| 來源 | 端點 | 主表定位 | 列數（含 ETF 等，未過濾普通股） | 單位 |
|---|---|---|---|---|
| twse-sbl | `https://www.twse.com.tw/exchangeReport/TWT93U?response=json&date=YYYYMMDD` | 頂層 `data`（title「信用額度總量管制餘額表」） | 1,304 | **股**（`hints: "單位：股"`） |
| tpex-sbl | `https://www.tpex.org.tw/www/zh-tw/margin/sbl?date=YYYY/MM/DD&response=json` | `tables[0]`（title「信用額度總量管制餘額表」） | 932 | 股（沒有 hints，依勾稽和數量級判斷） |

- 兩個端點只帶 UA 就能存取，和現有端點一樣。`stat` 一樣是 TWSE `"OK"`、TPEX `"ok"`。
- **歷史資料可以查**：2026-07-15 兩邊都有資料，所以可以回補。
- **休市日**（2026-10-11 週日）：TWSE 回傳 `stat: "OK"`、`data: []`；TPEX 回傳 `totalCount: 0`。兩邊回傳的 `date` 都是請求的日期，**不能用 `date` 判斷是否為交易日**，要沿用 `trading_days`。

### 3.2 欄位（兩市場的位置相同，名稱略有不同 → 依位置解析，用名稱驗證）
| idx | TWSE 欄名 | TPEX 欄名 | 用途 |
|---|---|---|---|
| 0 | 代號 | 股票代號 | code |
| 1 | 名稱 | 股票名稱 | |
| 2～7 | 融券 前日餘額/賣出/買進/現券/今日餘額/次一營業日限額 | 前日餘額/賣出/買進/現券/當日餘額/限額 | 不存（MI_MARGN 已經有融券，單位是張） |
| 8 | 前日餘額 | 前日餘額 | 驗證用 |
| 9 | 當日賣出 | 當日賣出 | `sbl_sell` |
| 10 | 當日還券 | 當日還券 | `sbl_return` |
| 11 | 當日調整 | 當日調整數額 | 驗證用 |
| 12 | 當日餘額 | 當日餘額 | **`sbl_balance`** |
| 13 | 次一營業日可限額 | 次一營業日可借券賣出限額 | 不存 |
| 14 | 備註 | 備註 | 不存（X 停券、V 不得借券、Z 達總量控管…） |

- TWSE 另外有 `groups: [股票 2, 融券 6, 借券賣出 6, '' 1]`，可以用來確認欄位分組；TPEX 沒有 `groups`。
- **勾稽公式**（實測成立，用來自我驗證欄位位置）：
  - 借券：前日餘額 + 當日賣出 − 當日還券 + 當日調整 = 當日餘額
    - 2330：12,051,514 + 785,000 − 39,000 + 0 = 12,797,514 ✓
    - 5347：32,358,886 + 1,286,000 − 1,939,000 + 0 = 31,705,886 ✓
  - 融券（股）：前日 + 賣出 − 買進 − 現券 = 今日
    - 2330：23,000 + 2,000 − 17,000 − 0 = 8,000 ✓，等於 MI_MARGN 的 8 張
- 實測值參考（2026-10-15 借券賣出餘額）：2330 1,279.8 萬股、2317 7,845.3 萬股、5347 3,170.6 萬股、6488 1,700 萬股、8299 1,706.7 萬股。

### 3.3 已知坑
- **公布時間比其他資料晚**：TWSE 的 notes 寫明每天大約 **20:30、22:30 各更新一次**，22:30 那次才會納入隔天由上櫃轉上市的個股。現在的排程是 18:00 和 20:00，**當天抓不到**。所以新增一個台北 22:45 的排程，見 §5.1。
- 單位是**股**，`margin_daily` 的單位是張，兩邊不要混用。
- 借券賣出股數**含鉅額交易**，也**含券商避險的借券賣出**（自 103 年起不受每日限額限制）。所以單日的大量賣出不一定是看空。
- 「當日調整」是普通、信用、借券三種部位之間的互調，可能是負數。

---

## 4. 資料庫 Schema（新增）

```sql
CREATE TABLE IF NOT EXISTS sbl_daily (
  date         TEXT NOT NULL,
  code         TEXT NOT NULL,
  sbl_balance  INTEGER,        -- 借券賣出當日餘額（股）
  sbl_sell     INTEGER,        -- 當日借券賣出（股）
  sbl_return   INTEGER,        -- 當日還券（股）
  PRIMARY KEY (date, code)
);
CREATE INDEX IF NOT EXISTS idx_sbl_code ON sbl_daily(code, date);

-- 出貨掃描結果（全部個股，供回測）
CREATE TABLE IF NOT EXISTS dist_daily (
  date       TEXT NOT NULL,
  code       TEXT NOT NULL,
  score      INTEGER NOT NULL,
  stage      TEXT NOT NULL,
  breakdown  TEXT NOT NULL,    -- JSON
  signals    TEXT NOT NULL,    -- JSON array
  config_version TEXT NOT NULL,
  PRIMARY KEY (date, code)
);
```
- 特徵已經存在 `scan_daily.features`（擴充後也會包含空方特徵），`dist_daily` 不重複存。
- 個股範圍沿用 `isCommonStock()`，ETF 等不存。

---

## 5. Ingest

- `ingest-daily.mjs` 新增 `sbl` 來源（twse-sbl、tpex-sbl），一樣會補近 14 天的缺漏，寫入 `ingest_log`。
- 「當天抓到 0 列，但當天是交易日」記為 `empty`，**不寫任何列**；下一次執行時會重試。這樣當天晚上沒抓到的資料，隔天就會自動補上。
- `backfill.mjs` 加上 `--sbl` 選項。60 個交易日 × 2 市場 × 3 秒，大約 6 分鐘。
- `verify-scan.mjs --stats` 要加印 `sbl_daily` 的日期數和缺漏。

### 5.1 排程：新增台北 22:45

| 時間（台北，週一至五） | Cloudflare Cron（UTC） | 當天借券資料 | 用途 |
|---|---|---|---|
| 18:00 | `0 10 * * MON-FRI`（既有） | 還沒公布 | 既有流程 |
| 20:00 | `0 12 * * MON-FRI`（既有） | 還沒公布 | 既有流程的備援 |
| **22:45** | **`45 14 * * MON-FRI`（新增）** | TWSE 22:30 第二次更新後 | 補當天借券資料，重算出貨分數 |

- **只加排程，不加分支邏輯**：22:45 觸發的是同一個 `update.yml`，跑完整個 build job。這樣可行的原因是每一步都是冪等的：
  - `ingest-daily.mjs` 只補缺漏，18:00 已經寫入的法人、行情、融資會跳過，只有 `sbl_daily` 是新寫入。
  - `ingest-weekly.mjs` 遇到已經有的集保週會回傳 `skipped`。
  - `build-data.mjs` 重抓 `data.json`，結果和 20:00 相同。
  - `score.mjs` 重算後覆蓋 `scan.json`、`dist.json`；`scan_daily`、`dist_daily` 用 upsert。吸籌分數不使用借券特徵，所以結果不會改變。
- `worker/index.js` 的 `scheduled()` **不需要修改**：它只會 dispatch workflow，不判斷是哪一個 cron 觸發的。只要改 `wrangler.jsonc` 的 `triggers.crons`。
- GitHub 自身的排程也比照既有做法，加上 `'45 14 * * 1-5'` 作為備援。workflow 已經設了 `concurrency: update-data`，所以兩邊同時觸發時會排隊執行，不會互相覆蓋。
- **代價**：每個交易日多一次 workflow 執行，約多 3～5 分鐘的 Actions 時間，以及多一輪官方端點請求。法人、行情等資料會因為已經存在而跳過，實際只多兩個借券請求，再加上 `build-data.mjs` 重抓的 10 天法人資料。
- **TPEX 的公布時間還沒有實測**。如果 TPEX 晚於 22:45 才公布，上櫃的借券資料仍然會在隔天 18:00 由 14 天補漏機制補上，該日 `dist.json` 的上櫃個股會帶 `sbl_pending`（§7.5）。P0 要實測確認。

---

## 6. 特徵（擴充 `computeFeatures()`）

沿用吸籌規格 §6 的規則：以交易日序列為軸、窗口內有效值 < 80% 時設為 `null`、缺值不補 0。
已經有的特徵（`inst_net_20_pct`、`ret_20`、`dist_ma60`、`vol_ratio`、`margin_chg_20`、`big400_chg_4w`、`holders_chg_4w_pct`…）直接使用，不重算。

| 新特徵 | 定義 | 備註 |
|---|---|---|
| `inst_sell_days_20` | D20 中 (foreign_net + trust_net) < 0 的天數 | 和 `inst_buy_days_20` 對稱 |
| `big400_down_weeks` | 從最新一週往回數，big400_pct 連續週減的週數 | 和 `big400_up_weeks` 對稱 |
| `drawdown_60` | close(t) ÷ max(high, D60) − 1 | 0 代表在 60 日高點，負值越大跌越多 |
| `below_ma20` | close(t) < MA20(t) | 布林值；MA20 不足時為 null |
| `dump_days_20` | D20 中符合「量 ≥ 前 5 日均量 × 1.5、收黑（close < open）、日報酬 ≤ −3%」的天數 | 帶量長黑；「前 5 日」不含當天 |
| `sbl_chg_20_pct` | (sbl_balance(t) − sbl_balance(t−20)) ÷ issued_shares × 100 | 單位 %；分母用股本，避免小基數放大 |
| `sbl_ratio` | sbl_balance(t) ÷ issued_shares × 100 | 只顯示，不計分 |
| `short_margin_ratio` | short_balance(t) ÷ margin_balance(t) × 100（券資比） | 只顯示；margin_balance < 100 張時設為 null |

**sbl 的 t 對齊**：`sbl_balance(t)` 缺值時（當天還沒公布），整組 `sbl_*` 特徵設為 `null`，**不可以拿 t−1 的值頂替**。否則回測時會把晚上才公布的資料當成收盤就知道。

---

## 7. 評分與分類（`lib/distribution.mjs`）

> ⚠️ 以下門檻是**依吸籌規格鏡像推估的起始值，還沒有用實際資料校準**。P3 要用現有歷史資料跑分布，再依 §11 P3 的驗收標準調整。

### 7.1 評分（0～100）
| 群組 | 上限 | 規則 |
|---|---|---|
| **法人調節** | 30 | `inst_net_20_pct` ≤ −1.0 → 20；≤ −0.5 → 14；≤ −0.2 → 7。`inst_sell_days_20` ≥ 12 → +10；≥ 10 → +5 |
| **籌碼分散** | 25 | `big400_down_weeks` ≥ 3 → 12；= 2 → 6。`holders_chg_4w_pct` > +2% → +8。`big400_chg_4w` ≤ −0.5 → +5 |
| **高檔轉弱** | 20 | −15% ≤ `drawdown_60` ≤ −3% → 10（從高點回落，但還沒崩）。`dist_ma60` ≥ 5% → 5（仍在季線上方，代表位置偏高）。`below_ma20` → 5 |
| **量能異常** | 10 | `dump_days_20` ≥ 2 → 10；= 1 → 5 |
| **信用與借券** | 15 | `sbl_chg_20_pct` ≥ 0.5 → 10；≥ 0.2 → 5。`margin_chg_20` > +10% → 5（散戶融資接手） |

特徵為 `null` 時，該項給 0 分，並在 `signals` 中加上 `missing:<特徵名>`。

### 7.2 階段分類（依序判斷，先符合者為準）
| stage | 條件 | 說明 |
|---|---|---|
| `EXCLUDED` | `avg_value_20` < 2,000 萬，或價格資料不足 | 和吸籌相同 |
| `COLLAPSED` | `ret_20` < −25% 或 `drawdown_60` < −30% | 已經跌完一段，不再算「出貨中」，不論分數高低 |
| `DISTRIBUTION` | score ≥ 70 | |
| `CAUTION` | 55 ≤ score < 70 | |
| `NEUTRAL` | 其他 | |

### 7.3 訊號標籤
`inst_steady_sell`、`trust_selling`（`trust_net_20_pct` ≤ −0.2）、`big_holder_falling`、`holders_rising`、`off_high`、`below_ma20`、`dump_bar`、`sbl_rising`、`margin_chasing`、`collapsed`、`tdcc_warming_up`、`sbl_warming_up`（`sbl_daily` 不滿 21 個交易日）。

### 7.4 和吸籌的互斥檢查
同一檔同一天不應該同時是 `ACCUMULATION` 和 `DISTRIBUTION`。P3 驗收時要統計兩邊重疊的檔數，**有重疊就列出來回報**，不要自動處理掉。

### 7.5 品質旗標
- `sbl_daily` 不滿 21 個交易日時，`dist.json` 加上 `quality: "sbl_warming_up"`，前端顯示「借券資料累積不足，信用與借券分數僅供參考」。
- **`sbl_pending`**：掃描日 t 的借券資料還沒公布（18:00、20:00 的執行一定會遇到）。
  - 這時 `dist.json` 照樣產出，但頂層加上 `quality: "sbl_pending"`；如果只有單一市場缺資料，就在該市場個股的 `signals` 加上 `sbl_pending`。
  - 前端顯示「今日借券資料約 22:45 更新，目前信用與借券分數未計入」。
  - 22:45 的執行會用完整資料覆蓋。
  - 回測一律以 `dist_daily` 中**最後一次寫入**的結果為準。
- 集保的品質旗標沿用吸籌的規則。

---

## 8. 輸出

### 8.1 `dist.json`（R2 的 `dist.json`）
只包含 `DISTRIBUTION`、`CAUTION`、`COLLAPSED`，格式比照 `scan.json`：
```json
{
  "updated_at": "2026-10-16T18:12:03+08:00",
  "scan_date": "2026-10-16",
  "sbl_latest": "2026-10-15",
  "config_version": "d-v0.1",
  "quality": null,
  "counts": { "DISTRIBUTION": 12, "CAUTION": 35, "COLLAPSED": 20 },
  "stocks": [
    {
      "code": "1234", "name": "範例", "market": "TWSE",
      "score": 74, "stage": "DISTRIBUTION",
      "breakdown": { "inst": 24, "dispersion": 18, "price": 15, "volume": 5, "credit": 12 },
      "signals": ["inst_steady_sell", "big_holder_falling", "off_high", "sbl_rising"],
      "features": { "inst_net_20_pct": -0.71, "inst_sell_days_20": 13, "drawdown_60": -0.08, "sbl_chg_20_pct": 0.62, "short_margin_ratio": 18.4 },
      "close": 88.2
    }
  ],
  "note": "僅供研究參考，非投資建議，亦非放空建議。"
}
```

### 8.2 API（Worker 只新增路由）
- `GET /dist.json`
- `GET /api/dist?stage=DISTRIBUTION,CAUTION&min_score=50&market=TPEX&limit=50`：參數比照 `/api/scan`。
- `GET /api/stock/:code`：回應新增 `distribution: { score, stage, breakdown, signals }` 欄位，原有欄位不動。

### 8.3 前端
- `scan.html` 上方加「吸籌 / 出貨」切換，預設吸籌；出貨模式讀 `/dist.json`。
- 出貨模式用和吸籌**不同的強調色**，表頭也要寫明「出貨」，避免使用者把清單看成買進名單。
- 個股詳情顯示借券餘額占股本、券資比、20 日借券變化。

---

## 9. 已知限制

1. **借券賣出不等於看空**：資料包含券商避險（權證、ETF 申贖）和套利的部位。權證發行量大的熱門股，借券餘額天生就偏高。所以 v0 用的是 **20 日變化**，不用絕對水位。
2. **融券會強制回補**：除權息和股東會停止過戶前，融券會被強制回補，`short_balance` 會突然歸零，所以券資比只顯示、不計分。
3. **法人賣超的雜訊比買超多**：季底作帳、換股、ETF 調整成分股都會造成短期賣超。這也是為什麼法人調節群組要同時看賣超天數。
4. **鏡像門檻未必對稱**：出貨的型態（高檔震盪、量增價滯）和吸籌（低檔收斂）不是單純的正負對調，校準結果可能會需要改變計分結構，不只是調數字。

---

## 10. 測試
- `test/sbl-sources.test.mjs`：兩個 parser 用 fixture 測欄位位置、勾稽公式、休市日回傳 `null`、欄名改版時要拋錯。
- `test/features.test.mjs` 新增：`inst_sell_days_20`、`big400_down_weeks`、`drawdown_60`、`dump_days_20`（含「前 5 日不含當天」）、`sbl_chg_20_pct` 在 t 缺值時為 `null`。
- `test/distribution.test.mjs`：每個群組的邊界值；`COLLAPSED` 優先於高分；`missing:*` 標籤。
- 回歸測試：吸籌的 `scan_daily` 前後完全相同（§0 第 2 點）。

---

## 11. 實作階段與驗收標準

> 每個 Phase 完成後：執行測試 → commit → **停下來，用條列方式回報結果、差異和待決事項**。

### P0　端點 fixture
- `scripts/probe.mjs` 加入 twse-sbl、tpex-sbl，存 fixture（裁剪規則沿用 `endpoints.md`）。
- 把 §3 搬到 `endpoints.md`。
- 實測兩個市場的公布時間：同一個交易日在 18:00、20:30、22:30、22:45 各抓一次，記錄列數是從什麼時候開始不為 0、什麼時候不再變動。TPEX 若晚於 22:45 才公布，要回報並建議調整排程時間。
- 驗收：兩個 fixture 都存在，勾稽公式成立。

### P1　Source、Schema、Ingest
- `lib/sources/twse-sbl.mjs`、`tpex-sbl.mjs`、`sbl_daily` 表、接進 `ingest-daily.mjs` 和 `backfill.mjs --sbl`。
- 驗收：本機 backfill 60 個交易日；抽查 2330、5347 各一天的借券餘額，要和官網一致；連續執行兩次不重複寫入。

### P2　特徵
- 擴充 `computeFeatures()`，加上 §10 的測試。
- 驗收：吸籌回歸測試通過；`verify-scan.mjs` 可以印出任一檔的新特徵。

### P3　評分與校準
- `lib/distribution.mjs`、`dist_daily`、`scripts/score.mjs` 一起產生 `docs/dist.json`。
- 用現有歷史資料，對最近 20 個交易日逐日評分，回報：
  - 各階段檔數占可評分檔數的比例。**`DISTRIBUTION` 目標 ≤ 5%**，超過就提出調整後的門檻。
  - 每個群組的得分分布：有沒有某一項幾乎人人得分，失去分辨力（吸籌 v1.1「股東人數減少」就是這個問題）。
  - 和 `ACCUMULATION` 重疊的檔數（§7.4）。
  - 選做：DISTRIBUTION 名單在之後 5 日、20 日的報酬，和全市場中位數比較（資料夠長才做）。
- 驗收：使用者確認門檻後，`config_version` 定為 `d-v1.0`。

### P4　部署整合
- Worker 新增路由、workflow 上傳 `dist.json`、`scan.html` 加切換、README 新增一節。
- 排程（§5.1）：
  - `wrangler.jsonc` 的 `triggers.crons` 加上 `"45 14 * * MON-FRI"`，並更新註解為「台北 18:00 / 20:00 / 22:45」。
  - `update.yml` 的 `schedule` 加上 `'45 14 * * 1-5'`。
  - README 的「運作方式」更新排程時間。
- 驗收：
  - `wrangler dev --local` 時 `/dist.json`、`/api/dist`、`/api/stock/2330` 都正常，原有路由回應不變。
  - 在本機同一天依序模擬兩次執行：先在借券資料缺漏的狀態下跑一次，`dist.json` 要帶 `sbl_pending`；寫入借券資料後再跑一次，旗標要消失、`dist_daily` 被覆蓋，而且 `scan_daily` 兩次的結果完全相同。
  - 用 `wrangler dev --test-scheduled` 打 `/__scheduled?cron=45+14+*+*+MON-FRI`，確認有 dispatch workflow（用測試用的 token，或確認請求有送出即可）。
- **不要 merge**，由使用者 review 後自行 merge。

---

## 12. 測試資料抽查清單（P1 用）
| 日期 | 代號 | 市場 | 借券賣出當日餘額（股） |
|---|---|---|---|
| 2026-10-15 | 2330 | TWSE | 12,797,514 |
| 2026-10-15 | 2317 | TWSE | 78,452,749 |
| 2026-10-15 | 5347 | TPEX | 31,705,886 |
| 2026-10-15 | 6488 | TPEX | 17,000,000 |
| 2026-10-15 | 8299 | TPEX | 17,067,000 |

---

## 13. 待使用者決定

| # | 項目 | 何時需要 | 選項 / 預設 |
|---|---|---|---|
| 1 | ~~借券資料晚公布的處理方式~~ | — | **已定案（2026-10-16）**：新增台北 22:45 的 Cloudflare Cron 排程，跑完整 workflow，見 §5.1 |
| 2 | backfill 天數 | P1 | 60 個交易日（和現有歷史對齊） |
| 3 | 評分門檻 | P3 校準後 | 照 §7 起始值 |
| 4 | 前端切換方式 | P4 | 同頁切換（預設），或另開 `/dist.html` |
| 5 | 首頁「法人同步賣超」 | 任何時候 | 另開小 PR，不在本規格範圍內 |

---

## 14. 免責
本掃描器僅供研究參考，**非投資建議，亦非放空建議**。借券與融券資料包含避險及套利部位，無法單獨作為看空依據。
