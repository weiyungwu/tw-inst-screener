# SPEC：主力出貨掃描器（Distribution Scanner）v0 草案

> 專案：`tw-inst-screener`（weiyungwu/tw-inst-screener）
> 版本：v0.4 草案 · 2026-10-16（**尚未實作，門檻待校準**）
> - v0.2：借券資料晚公布的處理方式定案，新增台北 22:45 排程（§5.1、§13 第 1 項）。
> - v0.3：依外部 review 修訂。新增：資料覆蓋率與 `PROVISIONAL` 階段（§7.2）、借券資料的實際取得時間（§4、§6）、`run_id` 與部分失敗的處理（§5.2、§8）、P3 的前瞻驗證與特徵增量測試（§11）、模組責任（§2.3）。修正 GitHub Actions 併發行為的錯誤描述（§5.1）。不採納的建議和理由記在 §2.4。
> - v0.4：依第二輪 review 補上四條規則：歷史股票池（§7.6）、前瞻報酬的缺值處理（§7.7）、併發驗收（§5.1、§11 P4）、建置一致性提示（§5.2、§8.3）。前端改為另開 `dist.html`（§8.3、§13 第 5 項）。
>
> 前置文件：[accumulation-scanner-spec.md](accumulation-scanner-spec.md)（吸籌掃描器）、[endpoints.md](endpoints.md)
> 本文件是實作規格。請**依 Phase 順序**實作，每個 Phase 完成後停下來回報，等使用者確認再繼續。

---

## 0. 執行規則

沿用吸籌規格 §0 的所有規則（零 npm 依賴、Node ≥ 22.13、缺值不補 0、Asia/Taipei、請求間隔 ≥ 3 秒、不 commit 資料檔），另外再加上下面幾條：

1. 開新分支 `feat/distribution-scanner`，PR 的 base 是 **`weiyungwu:master`**（本 repo 是 fork，不可以開到上游）。
2. **吸籌掃描器的行為不可以改變**：
   - `lib/score.mjs` 的 `CONFIG` 和 `scoreStock()` 不動。
   - `scan_daily` 的欄位不動。
   - `features` 只能**新增**欄位，不可以改既有欄位的名稱或定義。
   - **回歸驗收**：用同一個 DB，改動前後各跑一次 `score.mjs`，比對下面四項。比對時忽略本規格新增的鍵（新特徵、`distribution`、`run_id`）和 `updated_at`，其餘內容要完全相同：
     1. `scan_daily` 的 `score`、`stage`、`signals`、`features`。
     2. `docs/scan.json`。
     3. `data/features/*.json` 全部 90 個分片。
     4. `wrangler dev --local` 下，`/api/scan` 和 `/api/stock/2330` 的回應。
3. 出貨評分放在獨立模組 `lib/distribution.mjs`，有自己的 `CONFIG` 和 `config_version`（從 `d-v0.1` 開始），兩邊的門檻不共用。
4. Commit 訊息格式：`feat(dist): P<n> <摘要>`。

---

## 1. 背景與目標

### 1.1 現況
- 現有的三個功能都只找偏多的股票：首頁法人同步買超、吸籌評分（`lib/score.mjs`）、四維燈號（`lib/fourd.mjs`）。
- `margin_daily.short_balance`（融券餘額）每天都有寫入，但沒有任何特徵用到它。
- 台股主要的放空管道是**借券賣出**，外資幾乎都走這條路，量也遠大於融券，但目前完全沒有抓這份資料。

### 1.2 目標
新增一個掃描器，找出**疑似高檔派發的風險訊號**，是吸籌掃描器的反面。

> **用語原則**：「主力出貨」是從市場行為推論出來的，官方資料裡沒有這個欄位。每項資料能確認的只有事實本身，例如法人淨賣出、大戶比例下降、借券餘額上升，不能證明是誰在賣、為什麼賣。所以：
> - 程式和檔名沿用 `distribution`，方便和吸籌配對。
> - 前端、README、API 說明一律寫「**疑似出貨風險訊號**」，不寫「主力正在出貨」。

四類訊號同時成立時才列入：

| 層 | 問題 | 資料 |
|---|---|---|
| L1 法人流量 | 外資和投信是否持續、溫和地淨賣？ | 三大法人買賣超、外資持股 |
| L2 籌碼分散 | 大戶持股比例下降、股東人數增加？ | 集保股權分散表（每週） |
| L3 價量行為 | 價格還在相對高檔，但已經開始轉弱，或量增價滯？ | 每日收盤行情 |
| L4 信用與借券 | 融資增加、借券賣出餘額增加？ | 融資融券、**借券賣出（新增）** |

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
| 特徵計算 | 擴充 `lib/features.mjs` 的 `computeFeatures()` 輸出 | 兩個掃描器共用同一份特徵，`features/<nn>.json` 也只產一份 |
| 放空指標 | 計分用**借券賣出**，融券只用來顯示 | 融券在除權息和股東會前會強制回補，餘額會突然歸零，雜訊太大（§9） |
| 資料不足 | 計算覆蓋率，不足時分類為 `PROVISIONAL`（§7.2） | 「沒有訊號」和「無法判斷」不能混為一談 |
| 個股出貨資訊的來源 | 寫進 `features/<nn>.json` 分片，`/api/stock/:code` 從分片讀 | `dist.json` 只收錄部分階段，NEUTRAL 的個股在裡面找不到 |

### 2.2 資料流
```
ingest-daily.mjs ── 新增 twse-sbl / tpex-sbl ──▶ sbl_daily
scripts/score.mjs
  ├─ lib/features.mjs  computeFeatures()（新增空方特徵）
  ├─ lib/score.mjs     scoreStock()        ─▶ scan_daily、scan.json（不變）
  └─ lib/distribution.mjs scoreDistribution() ─▶ dist_daily、dist.json（新增）
  兩者合併 ─▶ features/<nn>.json（每檔新增 distribution 鍵）
```

### 2.3 模組責任
| 檔案 | 負責 | 不可以做的事 |
|---|---|---|
| `lib/sources/twse-sbl.mjs`、`tpex-sbl.mjs` | 解析、勾稽、合理性檢查（§5） | 計算特徵 |
| `lib/features.mjs` | 新增空方特徵（§6） | 改既有特徵的定義 |
| `lib/distribution.mjs` | 出貨評分、覆蓋率、階段、訊號（§7），純函式 | import `lib/score.mjs` 的 `CONFIG` |
| `scripts/score.mjs` | 呼叫兩套評分，寫入資料表和輸出檔，加上 `run_id` | 在這裡寫評分規則 |
| `worker/index.js` | 新增 `/dist.json`、`/api/dist`；`/api/stock/:code` 回傳 `distribution` | 改既有路由的回應欄位 |

### 2.4 外部 review 未採納的建議（v0.3）
| 建議 | 決定 | 理由 |
|---|---|---|
| 每檔輸出「支持證據、反證、判斷失效條件」 | **延後**到 d-v1.0 校準之後 | `signals` 已經列出支持的證據。反證和失效條件要各自定義規則，也要驗證，工作量等於再寫一套評分，v0 先不做 |
| 和同產業、相近市值的股票比較 | **不採納**，改用流動性分組 | 專案沒有產業分類資料，新增資料源超出本規格範圍。改用已經有的 `avg_value_20` 分成三組比較（§11 P3） |
| 另外處理存活者偏差 | **v0.4 改為採納**，規則見 §7.6、§7.7 | v0.3 認為「DB 是每天的快照，所以股票池本來就是當時的市場」。v0.4 核對 `scripts/score.mjs` 後發現這個前提不完全成立：評分迴圈走的是 `stocks` 表，也就是「曾經出現過的所有股票」加上「目前的市場別」，不是「t 日當時的股票池」。吸籌評分不改（§0），出貨評分和回測要改用 §7.6 的歷史股票池 |
| workflow 加 `queue: max` 讓多個執行排隊 | **不採納，但要驗收**（§5.1、§11 P4） | 每次執行都是完整而且冪等的流程，後面的執行包含前面的工作，被取消的待執行工作不會造成資料遺失。這個推論要用 P4 的併發驗收實際證明 |
| 加資料更新鎖、完整的 build_id 一致性檢查 | **簡化採納** | concurrency 已經保證同時只有一個執行在跑，不需要另外加鎖。`scan.json`、`dist.json` 都帶 `run_id` 和 `scan_date`，前端依 §8.3 提示版本不一致和資料延遲 |
| 依資料覆蓋率把分數等比例放大到 100 分 | **不採納** | 缺漏的群組不一定和已知群組有相同的風險分布，放大會誤導；只保留原始分數和覆蓋率 |

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
  market       TEXT NOT NULL CHECK (market IN ('TWSE','TPEX')),  -- 當日資料來自哪個市場（§7.6）
  sbl_balance  INTEGER,        -- 借券賣出當日餘額（股）
  sbl_sell     INTEGER,        -- 當日借券賣出（股）
  sbl_return   INTEGER,        -- 當日還券（股）
  fetched_at   TEXT NOT NULL,  -- 實際抓到的時間（台北），回測時用來對齊可取得時點
  PRIMARY KEY (date, code)
);
CREATE INDEX IF NOT EXISTS idx_sbl_code ON sbl_daily(code, date);

-- 出貨掃描結果（全部個股，供回測）
CREATE TABLE IF NOT EXISTS dist_daily (
  date       TEXT NOT NULL,
  code       TEXT NOT NULL,
  score      INTEGER NOT NULL,  -- 原始分數，不依覆蓋率放大
  coverage   REAL NOT NULL,     -- 可計算的配分 ÷ 100（§7.2）
  stage      TEXT NOT NULL,
  breakdown  TEXT NOT NULL,     -- JSON
  signals    TEXT NOT NULL,     -- JSON array
  config_version TEXT NOT NULL,
  run_id     TEXT,              -- GitHub Actions 的 GITHUB_RUN_ID；本機執行為 'local'
  PRIMARY KEY (date, code)
);
```
- 特徵已經存在 `scan_daily.features`（擴充後也會包含空方特徵），`dist_daily` 不重複存。
- 個股範圍沿用 `isCommonStock()`，ETF 等不存。
- **`fetched_at` 只在第一次寫入時設定**。重抓時如果數值相同，就不更新 `fetched_at`；如果數值不同，就更新數值和 `fetched_at`，並在 `ingest_log` 記一筆 `message: 'sbl revised'`。這樣才看得出官方事後修正過資料。

---

## 5. Ingest

- `ingest-daily.mjs` 新增 `sbl` 來源（twse-sbl、tpex-sbl），一樣會補近 14 天的缺漏，寫入 `ingest_log`。
- 「當天抓到 0 列，但當天是交易日」記為 `empty`，**不寫任何列**；下一次執行時會重試。這樣當天晚上沒抓到的資料，隔天就會自動補上。
- **「解析成功」不等於「資料有效」**。下面任何一項不成立，整個市場當天的資料都**不寫入**，`ingest_log` 記為 `error`，並在訊息中寫明原因：
  - 主表的 title 和欄名符合 §3.2（沿用現有 `checkFields()`）。
  - 每一列都符合借券勾稽公式。現有的融資 parser 只驗第一列；借券資料要逐列驗證，因為成本很低，又能抓到單一列錯位或截斷。P0 要先確認 fixture 的每一列都成立；如果有合理的例外，要回報後再決定是否放寬。
  - 普通股列數 ≥ 該市場 `stocks` 檔數的 80%。用來擋下 HTTP 200 但內容只有部分資料的回應。
  - 所有餘額都 ≥ 0。
  - 同一個代號在同一市場只出現一次。
- `sbl_balance` > 發行股數的個股，只記警告，不擋寫入；這一檔的 `sbl_*` 特徵設為 `null`。發行股數可能在增資或減資時和借券資料不同步。
- `backfill.mjs` 加上 `--sbl` 選項。60 個交易日 × 2 市場 × 3 秒，大約 6 分鐘。回補的資料 `fetched_at` 會是回補當下的時間，所以回測不能用 `fetched_at` 篩掉回補資料，見 §6。
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
- GitHub 自身的排程也比照既有做法，加上 `'45 14 * * 1-5'` 作為備援。
- **併發行為（v0.3 修正）**：workflow 設了 `concurrency: update-data`、`cancel-in-progress: false`，這**不是**「全部排隊執行」。依 GitHub 官方文件，預設的 `queue: single` 下，同一群組最多只有一個執行中、一個待執行；有新的執行進來時，**原本待執行的那一個會被取消**，由新的取代。
  - 這對本專案沒有傷害：每次執行都是完整的流程，被取消的那次要做的事，取代它的那次都會做到，而且是用更新的時間點。
  - 真正要保證的只有一件事：**同時只能有一個執行在讀寫 `history.sqlite`**，避免下載和上傳交錯、覆蓋掉新資料。這一點現有的 concurrency 設定已經保證。
  - 所以不強制採用 `queue: max`（§2.4），但這個推論要靠下面的不變條件成立，並且在 P4 驗收。
- **不變條件：處理的日期在執行開始時才決定**。這是「被取代不會漏掉資料」的前提：
  - 每一步都要用執行當下的時間（`todayTaipei()`）和 DB 內容，決定要補哪些日期、要評分哪一天。現有的 `ingest-daily.mjs` 和 `score.mjs` 已經是這樣。
  - **不可以**從觸發來源（cron 字串、dispatch 的 inputs、觸發時間）帶入要處理的日期。之後若有人加上這種參數，就會破壞這個前提，必須改用 `queue: max`。
  - 依這個條件，最後被執行的那一次，開始時間一定晚於所有被取消的觸發，所以看得到的資料至少和它們一樣新。
- **殘餘風險**：如果最後一個執行本身失敗，當天就沒有成功的 22:45 結果，要等隔天 18:00 補上。這和 concurrency 無關，靠 Cloudflare 排程的失敗紀錄和 GitHub 的失敗通知發現。
- **代價**：每個交易日多一次 workflow 執行，約多 3～5 分鐘的 Actions 時間，以及多一輪官方端點請求。法人、行情等資料會因為已經存在而跳過，實際只多兩個借券請求，再加上 `build-data.mjs` 重抓的 10 天法人資料。
- **TPEX 的公布時間還沒有實測**。如果 TPEX 晚於 22:45 才公布，上櫃的借券資料仍然會在隔天 18:00 由 14 天補漏機制補上，該日上櫃個股會是 `sbl_pending`（§7.5）。P0 要實測確認。

### 5.2 部分失敗與執行版本
現有 workflow 的順序是：ingest → 上傳 DB → 評分 → 上傳結果。出貨的步驟依下面的規則加進去：

| 狀況 | 處理方式 | 使用者看到的結果 |
|---|---|---|
| 借券 ingest 失敗 | 不影響其他來源；`sbl_daily` 該日沒有資料 | 出貨結果帶 `sbl_pending` |
| 出貨評分或上傳 `dist.json` 失敗 | 這兩步設 `continue-on-error: true`，吸籌的上傳照常進行 | `dist.json` 停在上一次的版本，`scan_date` 比 `scan.json` 舊 |
| 吸籌評分失敗 | 和現在一樣讓 job 失敗。`score.mjs` 先算完兩套評分，再一次寫出所有檔案，不會只寫出一半 | 全部維持上一次的版本 |
| R2 上傳中途失敗，分片版本不一 | 不做交易式更新，靠 `run_id` 讓前端看得出來 | 見下 |

- **建置版本欄位**：`scan.json`、`dist.json`、每個 `features/<nn>.json` 的頂層都要有下面三個欄位。`scan.json` 原本就有 `scan_date`、`updated_at`，只新增 `run_id`。
  - `run_id`：`GITHUB_RUN_ID`，本機執行為 `'local'`。
  - `scan_date`：資料所屬的交易日。
  - `updated_at`：產生檔案的時間。
- 同一次 `score.mjs` 執行產生的所有檔案，`run_id` 和 `scan_date` 一定相同。所以只要兩個檔案的這兩個欄位不同，就代表某一步上傳失敗，或 R2 正在更新到一半。前端怎麼提示見 §8.3。
- `/api/stock/:code` 回應的 `distribution` 會帶自己的 `scan_date` 和 `run_id`，讓呼叫端可以自己判斷。

---

## 6. 特徵（擴充 `lib/features.mjs` 的 `computeFeatures()`）

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

**借券資料的時點對齊**：
- `sbl_balance(t)` 缺值時（當天還沒公布），整組 `sbl_*` 特徵設為 `null`，**不可以拿 t−1 的值頂替**。否則回測時會把晚上才公布的資料當成收盤就知道。
- 每日排程（18:00、20:00、22:45）都只用到當時 DB 裡真的有的資料，不會偷看未來。
- **回測的可取得時點**：借券資料的官方公布時間是 t 當天的 22:30 前後，比其他每日資料晚。所以回測時，t 日的出貨分數視為 **t 日 22:45 才知道**，前瞻報酬從 **t+1 的開盤價**起算，不從 t 收盤起算。
- `fetched_at` 用來稽核即時抓到的資料（例如找出事後被修正的日期），**不用來篩選回測資料**，因為回補資料的 `fetched_at` 都是回補當下的時間（§5）。

---

## 7. 評分與分類（`lib/distribution.mjs`）

> ⚠️ 以下門檻是**依吸籌規格鏡像推估的起始值，還沒有用實際資料校準**。P3 要用現有歷史資料跑分布、做前瞻驗證，再依 §11 P3 的驗收標準調整。各群組內的特徵可能高度相關、重複計分（例如 `drawdown_60`、`dist_ma60`、`below_ma20` 都是價格位置），P3 要用特徵增量測試確認每個特徵有沒有提供額外的分辨力。

### 7.1 評分（0～100）
| 群組 | 上限 | 規則 |
|---|---|---|
| **法人調節** | 30 | `inst_net_20_pct` ≤ −1.0 → 20；≤ −0.5 → 14；≤ −0.2 → 7。`inst_sell_days_20` ≥ 12 → +10；≥ 10 → +5 |
| **籌碼分散** | 25 | `big400_down_weeks` ≥ 3 → 12；= 2 → 6。`holders_chg_4w_pct` > +2% → +8。`big400_chg_4w` ≤ −0.5 → +5 |
| **高檔轉弱** | 20 | −15% ≤ `drawdown_60` ≤ −3% → 10（從高點回落，但還沒崩）。`dist_ma60` ≥ 5% → 5（仍在季線上方，代表位置偏高）。`below_ma20` → 5 |
| **量能異常** | 10 | `dump_days_20` ≥ 2 → 10；= 1 → 5 |
| **信用與借券** | 15 | `sbl_chg_20_pct` ≥ 0.5 → 10；≥ 0.2 → 5。`margin_chg_20` > +10% → 5（融資增加） |

- 特徵為 `null` 時，該項給 0 分，並在 `signals` 中加上 `missing:<特徵名>`。
- **這 0 分代表「無法判斷」，不代表「沒有風險」**。所以另外計算覆蓋率（§7.2），而且分數**不依覆蓋率放大**（§2.4）。

### 7.2 覆蓋率與階段分類

**覆蓋率** `coverage` = 所有「特徵不是 null」的計分項配分加總 ÷ 100。
例如借券資料還沒公布時，`sbl_chg_20_pct` 的 10 分算不到，`coverage` 最多 0.90。

**階段**依序判斷，先符合者為準：
| stage | 條件 | 說明 |
|---|---|---|
| `EXCLUDED` | `avg_value_20` < 2,000 萬，或價格資料不足 | 和吸籌相同 |
| `COLLAPSED` | `ret_20` < −25% 或 `drawdown_60` < −30% | 見下方說明 |
| `DISTRIBUTION` | score ≥ 70，且 `coverage` ≥ 0.85 | |
| `CAUTION` | 55 ≤ score < 70，且 `coverage` ≥ 0.85 | |
| `PROVISIONAL` | score ≥ 55，但 `coverage` < 0.85 | 資料不足，暫定，不可以當成正式結果 |
| `NEUTRAL` | 其他 | |

- **`COLLAPSED` 是價格狀態，不是低風險**。它代表股票已經大跌一段，所以不再符合「高檔派發」的定義，**不代表下跌風險已經解除**。前端要把它和 `NEUTRAL` 分開顯示，文字寫「已大幅下跌，不適用高檔派發判斷」。
- **低分但覆蓋率不足的個股**（score < 55 且 `coverage` < 0.85）仍然分類為 `NEUTRAL`，但 `signals` 會帶 `low_coverage`。前端不用特別顯示，API 呼叫端可以自己篩選。
- **0.85 的由來**：借券資料晚公布時最多缺 10 分，`coverage` 會是 0.90，仍然可以正式分類；如果集保也不足（再缺 25 分），就會變成 `PROVISIONAL`。這個門檻在 P3 要和實際的缺漏分布一起確認。

### 7.3 訊號標籤
`inst_steady_sell`、`trust_selling`（`trust_net_20_pct` ≤ −0.2）、`big_holder_falling`、`holders_rising`、`off_high`、`below_ma20`、`dump_bar`、`sbl_rising`、`margin_rising`、`collapsed`、`low_coverage`、`sbl_pending`、`tdcc_warming_up`、`sbl_warming_up`（`sbl_daily` 不滿 21 個交易日）。

### 7.4 和吸籌的互斥檢查
同一檔同一天不應該同時是 `ACCUMULATION` 和 `DISTRIBUTION`。P3 驗收時要統計兩邊重疊的檔數，**有重疊就列出來回報**，不要自動處理掉。

### 7.5 品質旗標
- `sbl_daily` 不滿 21 個交易日時，`dist.json` 加上 `quality: "sbl_warming_up"`，前端顯示「借券資料累積不足，信用與借券分數僅供參考」。
- **`sbl_pending`**：掃描日 t 的借券資料還沒公布（18:00、20:00 的執行一定會遇到）。這個狀態**依市場分開判斷**：
  - `dist.json` 頂層加上 `sbl_status: { "TWSE": "ok" | "pending", "TPEX": "ok" | "pending" }`；任一市場是 `pending` 時，`quality` 為 `"sbl_pending"`。
  - 缺資料的那個市場，所有個股的 `signals` 都加上 `sbl_pending`。這些個股的 `coverage` 會因此下降，再由 §7.2 的規則決定是否變成 `PROVISIONAL`。
  - 前端顯示「今日借券資料約 22:45 更新，目前信用與借券分數未計入」，並註明是哪個市場。
  - 22:45 的執行會用完整資料覆蓋。
  - 回測一律以 `dist_daily` 中**最後一次寫入**的結果為準。如果隔天才補齊，以補齊後重算的結果為準。重算後階段有變動的檔數，記在 `ingest_log`（`source: 'dist'`），方便追蹤同一天結果改變的情況。
- 集保的品質旗標沿用吸籌的規則。

### 7.6 歷史股票池（point-in-time universe）
**問題**：現有的 `scripts/score.mjs` 走的是 `stocks` 表。這張表只增不減，而且 `market` 存的是**最近一次看到的**市場別。所以對歷史日期 t 評分時會有兩個問題：
- t 之後才上市的股票也會出現。目前因為沒有行情而被分到 `EXCLUDED`，所以結果碰巧沒錯，但這是巧合，不是規則保證的。
- t 之後才由上櫃轉上市的股票，會被當成 t 日就在上市。這會影響 §7.5 依市場判斷的 `sbl_pending`。

**規則**（只適用於出貨評分和回測，吸籌的迴圈不改，見 §0）：
- **t 日的股票池** `universe(t)` = `price_daily` 在 t 日有資料列的代號，不論收盤價是不是 null。
  - 停牌的股票仍然在股票池內，之後依 §7.2 分到 `EXCLUDED`。
  - t 日已經下市、沒有資料列的股票不在股票池內。
- **t 日的市場別** `market(t)`：
  - 優先取 `sbl_daily.market`（t 日或往前最近一筆）。
  - 沒有借券資料時才退回 `stocks.market`，並在 `signals` 加上 `market_assumed`。
- **不可以**用「目前還在交易的股票清單」回溯任何歷史日期，也不可以用 `stocks` 表當成歷史股票池。
- `dist_daily` 只寫入 `universe(t)` 內的個股。
- P3 回報時要列出每天的股票池檔數，以及其中 `market_assumed` 的檔數。

### 7.7 前瞻報酬的缺值處理（回測用）
前瞻報酬的定義見 §6 和 §11 P3。對每一檔、每一個期間（5 日、20 日），結果一定是「有效」或下面其中一種缺值原因，**不可以默默剔除**：

| 原因代碼 | 判斷 | 說明 |
|---|---|---|
| `not_matured` | t+1 或 t+N 晚於 DB 最新的交易日 | 期間還沒走完，不是個股的問題 |
| `no_entry` | t+1 沒有開盤價（停牌或無成交） | 無法進場，報酬無從計算 |
| `suspended` | t+1～t+N 之間有交易日沒有收盤價，但之後又恢復交易 | 停牌 |
| `delisted` | t+N 之前 `price_daily` 中斷，而且之後再也沒有出現 | 疑似下市 |
| `market_changed` | 期間內 `market(t)` 改變 | 不是缺值：`price_daily` 不分市場，價格是連續的，照常計算報酬，但要另外列出檔數。這種股票的價格如果中斷，代表轉市場當天的行情漏抓，改歸為 `other_missing` |
| `other_missing` | 其他缺漏 | 列出代號，人工檢查 |

- 最大不利變動用同一套規則：期間內只要有一天沒有最高價，就照上表判斷原因。
- **P3 回報格式**：每個名單（`DISTRIBUTION`、`CAUTION`、`NEUTRAL`），每個期間，都要列出：
  - 有效樣本數、各原因的缺值檔數。
  - 缺值率（缺值 ÷ 全部，`not_matured` 除外）。
  - 名單和比較組的缺值率差距超過 5 個百分點時，要特別標示。這種情況代表結果可能被缺值扭曲，例如出貨名單比較容易停牌或下市。
- `delisted` 不可以當成報酬 0，也不可以用最後收盤價補。

---

## 8. 輸出

### 8.1 `dist.json`（R2 的 `dist.json`）
只包含 `DISTRIBUTION`、`CAUTION`、`PROVISIONAL`、`COLLAPSED`，格式比照 `scan.json`：
```json
{
  "updated_at": "2026-10-16T22:51:40+08:00",
  "scan_date": "2026-10-16",
  "run_id": "12345678901",
  "sbl_latest": "2026-10-16",
  "sbl_status": { "TWSE": "ok", "TPEX": "ok" },
  "config_version": "d-v0.1",
  "quality": null,
  "counts": { "DISTRIBUTION": 12, "CAUTION": 35, "PROVISIONAL": 4, "COLLAPSED": 20 },
  "stocks": [
    {
      "code": "1234", "name": "範例", "market": "TWSE",
      "score": 74, "coverage": 1.0, "stage": "DISTRIBUTION",
      "breakdown": { "inst": 24, "dispersion": 18, "price": 15, "volume": 5, "credit": 12 },
      "signals": ["inst_steady_sell", "big_holder_falling", "off_high", "sbl_rising"],
      "features": { "inst_net_20_pct": -0.71, "inst_sell_days_20": 13, "drawdown_60": -0.08, "sbl_chg_20_pct": 0.62, "short_margin_ratio": 18.4 },
      "close": 88.2
    }
  ],
  "note": "疑似出貨風險訊號，僅供研究參考，非投資建議，亦非放空建議。"
}
```

### 8.2 API（Worker 只新增路由）
- `GET /dist.json`
- `GET /api/dist?stage=DISTRIBUTION,CAUTION&min_score=50&min_coverage=0.85&market=TPEX&limit=50`：參數比照 `/api/scan`，另外加上 `min_coverage`。
- `GET /api/stock/:code`：從 `features/<nn>.json` 分片讀取，回應新增一個 `distribution` 欄位，原有欄位不動：
  ```json
  "distribution": { "scan_date": "2026-10-16", "score": 41, "coverage": 0.9, "stage": "NEUTRAL", "breakdown": { … }, "signals": ["sbl_pending"] }
  ```
  - 只要這一檔有被評分，不論哪個階段（包括 `NEUTRAL`、`EXCLUDED`），`distribution` 都會有值。
  - 分片是舊版、還沒有出貨資料時，回傳 `"distribution": null`。API 說明要寫明：**`null` 代表「沒有出貨資料」，不代表「沒有出貨風險」**。
  - `dist.json` 是清單頁和 `/api/dist` 的來源，`dist_daily` 是回測的來源，Worker 不讀 `dist_daily`。

### 8.3 前端
- 另開一頁 `docs/dist.html`（邏輯放 `docs/dist.js`），讀 `/dist.json`；版本提示需要比對時另外讀 `/scan.json`。`scan.html` 不改，只在 `index.html`、`scan.html` 的導覽列加上連到 `dist.html` 的連結。
- 出貨頁用和吸籌**不同的強調色**，表頭寫明「疑似出貨風險」，避免使用者把清單看成買進名單。
- `PROVISIONAL` 和 `COLLAPSED` 各自分組顯示，不和正式階段混在一起，說明文字照 §7.2。
- 顯示覆蓋率。
- **版本與延遲提示**。頁首一律顯示資料日期（`scan_date`）和更新時間（`updated_at`），並依序檢查下面四種狀況，符合的都要顯示：
  | 狀況 | 判斷 | 提示文字 |
  |---|---|---|
  | 出貨結果落後 | `dist.json` 的 `scan_date` 早於 `scan.json` 的 `scan_date` | 「出貨結果停在 YYYY-MM-DD，尚未更新到最新交易日」 |
  | 版本不一致 | `scan_date` 相同但 `run_id` 不同 | 「吸籌與出貨結果來自不同次更新，可能有一項更新失敗」 |
  | 借券資料延遲 | `dist.json` 的 `sbl_status` 有 `pending` | 「今日〇〇借券資料約 22:45 更新，信用與借券分數未計入」 |
  | 資料過舊 | 現在時間減 `updated_at` 超過 4 天 | 「資料超過 4 天未更新，排程可能已停止」 |
- **「資料過舊」為什麼用 4 天**：前端沒有交易日曆，判斷不出昨天是不是國定假日。一般週末加上週一放假的三天連假，從週五的資料到週二 18:00 更新，間隔不到 4 天，不會誤報。比這更長的連假（例如春節）仍然會顯示提示，這是已知、可以接受的誤報。
- 個股詳情頁比對 `/api/stock/:code` 的 `distribution.run_id` 和 `dist.json` 的 `run_id`，不同時顯示「版本不一致」的提示。
- 個股詳情顯示借券餘額占股本、券資比、20 日借券變化。

---

## 9. 已知限制

1. **每個訊號都只是事實，不能證明意圖**：法人賣超不等於法人在出貨，大戶比例下降不等於大戶賣給散戶，融資增加不等於散戶接刀。這些訊號同時出現只代表風險升高，所以對外用語一律是「疑似出貨風險訊號」（§1.2）。
2. **借券賣出不等於看空**：資料包含券商避險（權證、ETF 申贖）和套利的部位。權證發行量大的熱門股，借券餘額天生就偏高。所以 v0 用的是 **20 日變化**，不用絕對水位。
3. **融券會強制回補**：除權息和股東會停止過戶前，融券會被強制回補，`short_balance` 會突然歸零，所以券資比只顯示、不計分。
4. **法人賣超的雜訊比買超多**：季底作帳、換股、ETF 調整成分股都會造成短期賣超。這也是為什麼法人調節群組要同時看賣超天數。
5. **空頭市場時誤報會增加**：大盤普遍下跌時，很多股票都會同時符合跌破月線、法人賣超等條件，清單會變長，卻不一定是個股的派發。P3 要檢查名單檔數和大盤漲跌的關係（§11）。
6. **鏡像門檻未必對稱**：出貨的型態（高檔震盪、量增價滯）和吸籌（低檔收斂）不是單純的正負對調，校準結果可能會需要改變計分結構，不只是調數字。
7. **歷史資料很短**：目前只有約 60 個交易日的每日資料，集保的週數更少。P3 的前瞻驗證和樣本外測試**樣本量不足以下定論**，d-v1.0 要標示為「實驗性」，等資料累積再重新驗證。

---

## 10. 測試
- `test/sbl-sources.test.mjs`：
  - 兩個 parser 用 fixture 測欄位位置、逐列勾稽、休市日回傳 `null`、欄名改版時要拋錯。
  - §5 的合理性檢查：列數不足、餘額為負、代號重複時，都要拋錯並且不回傳資料。
- `test/features.test.mjs` 新增：
  - `inst_sell_days_20`、`big400_down_weeks`、`drawdown_60`。
  - `dump_days_20`（含「前 5 日不含當天」）。
  - `sbl_chg_20_pct` 在 t 缺值時為 `null`；`sbl_balance` > 發行股數時為 `null`。
- `test/distribution.test.mjs`：
  - 每個群組的邊界值；`COLLAPSED` 優先於高分；`missing:*` 標籤。
  - `coverage` 的計算。
  - 同樣的特徵，只差借券為 `null` 時：`coverage` 從 1.0 降到 0.9、分數降低，但階段**不會**因為缺資料而被當成風險較低。用一組 score 70、coverage 0.8 的案例，確認結果是 `PROVISIONAL`，不是 `NEUTRAL`。
  - **這個測試要能在有人把 null 改回「當成沒風險」時失敗**。
- 歷史股票池（§7.6）：
  - 準備一組 fixture，含 t 之後才上市的股票、t 之前已經下市的股票、t 之後才轉上市的股票。
  - 確認前兩者都不在 `universe(t)` 內，第三者的 `market(t)` 是上櫃。
- 前瞻報酬（§7.7）：每一種缺值原因各一個案例，`delisted` 不可以被算成 0 報酬。
- 回歸測試：§0 第 2 點列出的四項比對。

---

## 11. 實作階段與驗收標準

> 每個 Phase 完成後：執行測試 → commit → **停下來，用條列方式回報結果、差異和待決事項**。

### P0　端點 fixture
- `scripts/probe.mjs` 加入 twse-sbl、tpex-sbl，存 fixture（裁剪規則沿用 `endpoints.md`）。
- 把 §3 搬到 `endpoints.md`。
- 實測兩個市場的公布時間：同一個交易日在 18:00、20:30、22:30、22:45 各抓一次，記錄列數是從什麼時候開始不為 0、什麼時候不再變動。TPEX 若晚於 22:45 才公布，要回報並建議調整排程時間。
- 同一天 20:30 和 22:30 兩次抓到的數值如果不同，要記錄差異，作為 §4 `fetched_at` 規則的依據。
- 驗收：兩個 fixture 都存在，逐列勾稽成立。

### P1　Source、Schema、Ingest
- `lib/sources/twse-sbl.mjs`、`tpex-sbl.mjs`、`sbl_daily` 表、接進 `ingest-daily.mjs` 和 `backfill.mjs --sbl`。包含 §5 的合理性檢查。
- 驗收：本機 backfill 60 個交易日；抽查 2330、5347 各一天的借券餘額，要和官網一致；連續執行兩次不重複寫入，`fetched_at` 不變。

### P2　特徵
- 擴充 `lib/features.mjs` 的 `computeFeatures()`，加上 §10 的測試。
- 驗收：§0 第 2 點的回歸比對通過；`verify-scan.mjs` 可以印出任一檔的新特徵。

### P3　評分、校準與驗證
- `lib/distribution.mjs`、`dist_daily`、`scripts/score.mjs` 一起產生 `docs/dist.json`，分片加上 `distribution`。
- 用現有歷史資料逐日評分，回報下面五項：
  1. **分布**：各階段檔數占可評分檔數的比例，**`DISTRIBUTION` 目標 ≤ 5%**，超過就提出調整後的門檻。也要列出每個群組的得分分布：有沒有某一項幾乎人人得分，失去分辨力（吸籌 v1.1「股東人數減少」就是這個問題）。
  2. **特徵增量測試**：
     - 列出計分特徵兩兩之間的相關係數（Spearman）。
     - 每次拿掉一個計分特徵，重新分類，列出 `DISTRIBUTION` 名單的變動檔數。
     - 拿掉後名單幾乎不變、和同組其他特徵又高度相關的特徵，要建議降權或移除。
  3. **前瞻驗證（必做）**：對每個交易日的 `DISTRIBUTION`、`CAUTION` 名單，計算之後 5 日、20 日的兩項數字：
     - 報酬：從 t+1 開盤起算（§6）。
     - 最大不利變動：期間最高價相對 t+1 開盤的漲幅。
     - 比較組：(a) 同一天全部可評分個股的中位數；(b) 同一天、同一個流動性組別的中位數，流動性組別用 `avg_value_20` 分成三等分；(c) `NEUTRAL` 個股的中位數。
     - 股票池依 §7.6，缺值依 §7.7 分類並回報有效樣本數。
  4. **樣本外**：資料依時間分成前 2/3、後 1/3。門檻只能用前段調整，後段只用來報告結果。後段的天數不足 15 個交易日時，要明白寫出「樣本不足，無法判斷」，**不可以省略這一項**。
  5. **市場狀態**：列出每天 `DISTRIBUTION` 檔數和當天大盤 20 日漲跌的關係，確認名單不是單純跟著大盤走（§9 第 5 點）。另外要列出和 `ACCUMULATION` 重疊的檔數（§7.4），以及 `PROVISIONAL` 的檔數和造成的原因。
- **驗收**：
  - 檔數比例符合目標，**不能單獨作為通過條件**。
  - 使用者看過前瞻驗證和樣本外的結果並確認門檻後，`config_version` 才定為 `d-v1.0`，並依 §9 第 7 點標示為「實驗性」。
  - 如果前瞻結果和比較組沒有差異，要照實回報，由使用者決定要調整計分結構還是暫停上線。

### P4　部署整合
- Worker 新增路由、workflow 上傳 `dist.json`（§5.2 的 `continue-on-error`）、新增 `dist.html` 並在 `index.html`、`scan.html` 加連結、README 新增一節（用語照 §1.2）。
- 排程（§5.1）：
  - `wrangler.jsonc` 的 `triggers.crons` 加上 `"45 14 * * MON-FRI"`，並更新註解為「台北 18:00 / 20:00 / 22:45」。
  - `update.yml` 的 `schedule` 加上 `'45 14 * * 1-5'`。
  - README 的「運作方式」更新排程時間。
- 驗收：
  - `wrangler dev --local` 時 `/dist.json`、`/api/dist`、`/api/stock/2330` 都正常。
  - §0 第 2 點的回歸比對通過。
  - 用舊版分片時，`/api/stock/2330` 回傳 `distribution: null`，不會出錯。
  - 在本機同一天依序模擬兩次執行：
    1. 第一次在借券資料缺漏的狀態下執行，`dist.json` 要帶 `sbl_pending`。
    2. 寫入借券資料後再執行一次：旗標要消失、`dist_daily` 被覆蓋，而且 `scan_daily` 兩次的結果完全相同。
    3. 另外模擬只缺 TPEX 的情況，`sbl_status` 要正確，只有上櫃個股帶 `sbl_pending`。
  - 模擬出貨評分失敗時，`scan.json` 仍然正常上傳，前端顯示「出貨結果停在 YYYY-MM-DD」。
  - **建置一致性**：用本機 R2 準備四組檔案，前端要各自顯示 §8.3 對應的提示，而且只顯示該提示：
    1. `dist.json` 的 `scan_date` 較舊。
    2. `scan_date` 相同但 `run_id` 不同。
    3. `sbl_status` 有 `pending`。
    4. `updated_at` 是 5 天前。
    另外準備一組完全一致的檔案，前端**不可以**出現任何提示。
  - **併發驗收**（§5.1）。不可以用正式的 `update.yml` 測試，因為它會寫入正式的 R2：
    1. 在分支上新增暫時的 `.github/workflows/concurrency-test.yml`，`concurrency` 的設定和 `update.yml` 相同，但 group 名稱改成 `concurrency-test`。
    2. 唯一的步驟：印出 `GITHUB_RUN_ID` 和開始時間（台北），然後 `sleep 90`。
    3. 用 `gh workflow run concurrency-test.yml --ref feat/distribution-scanner` 間隔約 10 秒連續觸發三次，記下每次的觸發時間。
    4. 確認結果：第 1 次完成；第 2 次被取消（`cancelled`）；第 3 次完成，而且**開始時間晚於第 2 次的觸發時間**。
    5. 把三次的 run 連結和時間寫進 P4 回報，驗收後刪除這個 workflow，不可以 merge。
    6. 另外 grep 檢查 `update.yml` 沒有 `inputs:`，所有腳本都沒有讀取觸發來源的日期，確認 §5.1 的不變條件成立。
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
| 3 | 評分門檻、`coverage` 門檻 0.85 | P3 校準後 | 照 §7 起始值 |
| 4 | 前瞻驗證沒有顯著差異時的處置 | P3 | 由使用者決定：調整計分結構，或暫停上線 |
| 5 | ~~前端切換方式~~ | — | **已定案（2026-10-16）**：另開 `dist.html`，見 §8.3 |
| 6 | 首頁「法人同步賣超」 | 任何時候 | 另開小 PR，不在本規格範圍內 |

---

## 14. 免責
本掃描器輸出的是**疑似出貨風險訊號**，僅供研究參考，**非投資建議，亦非放空建議**。借券與融券資料包含避險及套利部位，法人、集保與信用資料也都無法證明交易意圖，不能單獨作為看空依據。
