# 實作計畫：主力出貨掃描器（Distribution Scanner）

> 依據：[distribution-scanner-spec.md](distribution-scanner-spec.md) v0.4（含 2026-10-16 定案：另開 `dist.html`） · 分支 `feat/distribution-scanner` · PR base `weiyungwu:master`
> 測試指令：`node --test`（零 npm 依賴；Node 22 不接受目錄參數 `test/`）

## 概要
把規格的 P0～P4 拆成 19 個 S/M 任務。每個任務都讓系統維持在可運作的狀態，每個 Phase 結束時停下來回報（規格 §11）。

## 架構決策（補充規格沒寫的部分）
- **T0 回歸基準要最先做**：§0 第 2 點的回歸比對需要「改動前」的快照。只要動了 `features.mjs` 或 `score.mjs` 就拿不到了，所以 T0 排在所有程式改動之前。
- **兩個 sbl parser 共用一個驗證函式**（逐列勾稽、列數 ≥ 80%、餘額 ≥ 0、代號不重複）。兩處都要用，所以不算過度抽象；放在 `lib/parse.mjs`，沿用既有的 `checkFields()` 慣例。
- **`universe(t)`、`market(t)`、前瞻報酬都寫成純函式**，用 fixture 測試，不直接查 DB。
- **校準分析（T13）是一次性的腳本**，輸出報告給使用者看，不進正式 workflow。

## 依賴圖
```
T0 回歸基準 ─────────────────────────────┐
T1 fixture ─┬─ T3 twse parser ─┐          │
            └─ T4 tpex parser ─┼─ T6 ingest/backfill ─ T8 sbl 特徵 ─┐
T5 schema ─────────────────────┘                                   │
T7 非 sbl 特徵 ────────────────────────────────────────────────────┤（T0 用於驗收）
                                         T9 評分 ─┐                │
                                         T10 股票池 ┼─ T11 score.mjs 整合 ─ T12 前瞻報酬 ─ T13 校準報告
                                                                   │
                         T14 Worker ─ T15 前端 ─ T16 workflow ─ T17 本機模擬 ─ T18 併發驗收
T2 公布時間實測（獨立，crontab 自動執行）
```

---

## Phase 0：前置

### T0：回歸比對腳本與改動前快照
**說明**：寫一個比對腳本，產生 §0 第 2 點四項輸出的快照，比對時忽略新增的鍵（新特徵、`distribution`、`run_id`）和 `updated_at`。在任何程式改動前，用目前的 DB 先存一份基準快照。
**驗收**：
- [ ] 對同一份程式碼跑兩次，比對結果是「完全相同」。
- [ ] 手動改掉一個既有特徵值時，比對會失敗並指出差異位置。
**驗證**：`node scripts/regress.mjs snapshot` → `node scripts/regress.mjs compare`
**依賴**：無 · **檔案**：`scripts/regress.mjs`（快照放 `data/`，不 commit） · **規模**：S
> `wrangler dev` 的 API 回應那一項要另外啟動 Worker，腳本只負責抓下來比對。

### T1：端點 fixture 與 endpoints.md
**說明**：`probe.mjs` 加入 twse-sbl、tpex-sbl，存 fixture，把規格 §3 搬到 `endpoints.md`。
**驗收**：
- [ ] 兩個 fixture 都存在，裁剪規則和既有的一致。
- [ ] 一次性檢查：fixture 的每一列都符合借券勾稽公式；如果有例外，回報。
**驗證**：`node scripts/probe.mjs`、對 fixture 執行勾稽檢查
**依賴**：無 · **檔案**：`scripts/probe.mjs`、`test/fixtures/twse-sbl.json`、`test/fixtures/tpex-sbl.json`、`specs/endpoints.md` · **規模**：S

### T2：公布時間實測（已完成 2026-10-20）
> 結果：兩市場 20:30:00 都還沒資料、22:30:00 已是最終值，TPEX 沒有晚於 22:45，不需要調整排程；10-16 的 20:30、22:30 因電腦睡眠沒量到。細節見 `specs/endpoints.md`。crontab 已刪除。

**說明**：本機 crontab 在 2026-10-16（五）、10-19（一）的 18:00、20:30、22:30、22:45、23:30 自動抓兩個市場的資料（腳本與結果在 `~/sbl-timing/`：`log.tsv` 記列數、指紋、抽查值，`raw/` 存原始回應）。23:30 是額外加的，用來確認 22:45 之後數值不再變動。量完要刪掉 crontab。電腦需要在這些時間開著、沒有休眠。整理結果時，記錄列數從什麼時候開始不為 0、什麼時候不再變動，以及 20:30 和 22:30 兩次的數值差異。
**驗收**：
- [ ] 有四個時間點的紀錄。
- [ ] 如果 TPEX 晚於 22:45 才公布，提出排程調整建議。
**依賴**：無（獨立腳本） · **檔案**：`specs/endpoints.md` · **規模**：XS

### Checkpoint P0
- [ ] 測試通過、fixture 勾稽成立
- [ ] commit `feat(dist): P0 …`，回報後等使用者確認

---

## Phase 1：資料源、Schema、Ingest

### T3：twse-sbl parser 與共用驗證
**說明**：依位置解析、用欄名驗證，加上 §5 的合理性檢查（共用函式）。休市日回傳 `null`。
**驗收**：
- [ ] 用 fixture 解析出來的 2330 餘額 = 12,797,514。
- [ ] 欄名改版、勾稽不符、列數不足、餘額為負、代號重複時，都會拋錯而且不回傳資料。
**驗證**：`node --test test/sbl-sources.test.mjs`
**依賴**：T1 · **檔案**：`lib/sources/twse-sbl.mjs`、`lib/parse.mjs`、`test/sbl-sources.test.mjs` · **規模**：S

### T4：tpex-sbl parser
**說明**：讀 `tables[0]`，重複使用 T3 的驗證函式。
**驗收**：
- [ ] 5347 = 31,705,886、6488 = 17,000,000。
- [ ] `totalCount: 0` 時回傳 `null`；異常情況和 T3 一樣會拋錯。
**依賴**：T3 · **檔案**：`lib/sources/tpex-sbl.mjs`、`test/sbl-sources.test.mjs` · **規模**：S

### T5：`sbl_daily` schema 與 upsert 規則
**說明**：建表、建索引。寫入規則：`fetched_at` 只在第一次寫入時設定；數值不同時，更新數值和 `fetched_at`，並在 `ingest_log` 記 `sbl revised`。
**驗收**：
- [ ] 相同數值寫兩次，`fetched_at` 不變。
- [ ] 數值改變時，`fetched_at` 會更新，而且有一筆 `sbl revised` 紀錄。
**驗證**：`node --test test/db.test.mjs`
**依賴**：無 · **檔案**：`db/schema.sql`、`lib/db.mjs`、`test/db.test.mjs` · **規模**：S

### T6：接進 ingest-daily、backfill、verify-scan
**說明**：`sbl` 來源（14 天補漏、`empty` 不寫入、驗證失敗記 `error`）、`backfill.mjs --sbl`、`verify-scan --stats` 加印 sbl 的日期數和缺漏。發行股數檢查只記警告。
**驗收**：
- [ ] 本機 backfill 60 個交易日成功（大約 6 分鐘）。
- [ ] 抽查 §12 的五筆資料，全部相符。
- [ ] 連續跑兩次 `ingest-daily`，不會重複寫入，`fetched_at` 不變。
**驗證**：`node scripts/backfill.mjs --sbl`、`node scripts/verify-scan.mjs --stats`
**依賴**：T3、T4、T5 · **檔案**：`scripts/ingest-daily.mjs`、`scripts/backfill.mjs`、`scripts/verify-scan.mjs`、`lib/ingest.mjs` · **規模**：M

### Checkpoint P1
- [ ] 全部測試通過
- [ ] T0 回歸比對仍然完全相同（P1 不應該影響評分）
- [ ] commit、回報、等確認

---

## Phase 2：特徵

### T7：價量與籌碼類新特徵
**說明**：`inst_sell_days_20`、`big400_down_weeks`、`drawdown_60`、`below_ma20`、`dump_days_20`。
**驗收**：
- [ ] 每個特徵都有邊界測試；`dump_days_20` 有一個「前 5 日不含當天」的測試，算法改錯時這個測試要會失敗。
- [ ] 有效值 < 80% 時為 `null`。
- [ ] T0 回歸比對通過。
**驗證**：`node --test test/features.test.mjs`、`node scripts/regress.mjs compare`
**依賴**：T0 · **檔案**：`lib/features.mjs`、`test/features.test.mjs` · **規模**：S

### T8：借券與券資比特徵
**說明**：`sbl_chg_20_pct`、`sbl_ratio`、`short_margin_ratio`；`score.mjs` 載入 `sbl_daily`。t 日缺值時整組為 `null`，不可以用 t−1 頂替。
**驗收**：
- [ ] t 日缺值時為 `null`；`sbl_balance` > 發行股數時為 `null`；`margin_balance` < 100 張時券資比為 `null`。
- [ ] T0 回歸比對通過；`verify-scan` 可以印出新特徵。
**依賴**：T6、T7 · **檔案**：`lib/features.mjs`、`scripts/score.mjs`、`scripts/verify-scan.mjs`、`test/features.test.mjs` · **規模**：M

### Checkpoint P2
- [ ] 測試通過、回歸比對通過 → commit、回報、等確認

---

## Phase 3：評分、校準與驗證

### T9：`lib/distribution.mjs` 純評分
**說明**：§7.1 五個群組、`coverage`、§7.2 階段（依序判斷）、§7.3 訊號、`missing:*` 標籤，`config_version: 'd-v0.1'`。不 import `score.mjs`。
**驗收**：
- [ ] 每個群組都有邊界值測試；`COLLAPSED` 優先於高分。
- [ ] score 70、coverage 0.8 → `PROVISIONAL`。這個測試要能在有人把 null 改成「當成沒風險」時失敗。
- [ ] 只差借券為 null 時：coverage 從 1.0 → 0.9。
**驗證**：`node --test test/distribution.test.mjs`
**依賴**：無（只依賴特徵的名稱） · **檔案**：`lib/distribution.mjs`、`test/distribution.test.mjs` · **規模**：S

### T10：歷史股票池 `universe(t)` / `market(t)`
**說明**：§7.6 的純函式，輸入 price 列和 sbl 列；沒有借券資料時退回 `stocks.market`，並加上 `market_assumed`。
**驗收**：
- [ ] fixture：t 之後才上市、t 之前已經下市的股票，都不在 `universe(t)` 內；t 之後才轉上市的股票，`market(t)` = TPEX。
**依賴**：無 · **檔案**：`lib/distribution.mjs`、`test/distribution.test.mjs` · **規模**：S

### T11：score.mjs 整合輸出
**說明**：`dist_daily` 表、`run_id`、`docs/dist.json`（含 `sbl_status`、`quality`、`counts`）、分片加上 `distribution` 鍵，三種檔案的頂層都帶 `run_id`/`scan_date`/`updated_at`。先算完兩套評分，再一次寫出所有檔案。重算後階段有變動的檔數，記在 `ingest_log`（`source: 'dist'`）。
**驗收**：
- [ ] `dist.json` 符合 §8.1 的格式；分片中 NEUTRAL、EXCLUDED 的個股也有 `distribution`。
- [ ] 只缺 TPEX 借券時，`sbl_status.TPEX = "pending"`，只有上櫃個股帶 `sbl_pending`。
- [ ] T0 回歸比對通過。
**依賴**：T8、T9、T10 · **檔案**：`scripts/score.mjs`、`db/schema.sql`、`lib/db.mjs` · **規模**：M

### T12：前瞻報酬計算（§7.7）
**說明**：純函式。從 t+1 開盤價起算 5 日、20 日的報酬，以及最大不利變動。每筆結果一定是「有效」或六種缺值原因之一。
**驗收**：
- [ ] 每種缺值原因各有一個案例；`delisted` 不會算成 0，也不會用最後收盤價補。
- [ ] `market_changed` 照常計算報酬，但另外標示。
**依賴**：T10 · **檔案**：`lib/forward.mjs`、`test/forward.test.mjs` · **規模**：S

### T13：逐日評分與校準報告
**說明**：用歷史資料逐日評分，產出 §11 P3 的五項報告：分布、特徵增量測試（Spearman、逐一移除特徵）、前瞻驗證（三個比較組）、樣本外（前 2/3、後 1/3）、市場狀態與吸籌重疊。
**驗收**：
- [ ] 五項都有結果；後段不足 15 天時寫明「樣本不足，無法判斷」。
- [ ] 缺值率差距超過 5 個百分點時有標示；吸籌重疊的檔數有列出。
- [ ] 前瞻結果和比較組沒有差異時，照實寫出。
**依賴**：T11、T12 · **檔案**：`scripts/calibrate-dist.mjs`、`specs/distribution-calibration.md` · **規模**：M

### Checkpoint P3（使用者決策點）
> 2026-10-17 定案：門檻維持 d-v0.1 不調整，定為 `d-v1.0`、`experimental: true`（`dist.json` 帶出）。T15、T16 的前端與 README 要註明：訊號以 20 日為參考期間、5 日沒有分辨力、名單個股期間內的上漲幅度和其他股票相同（最大不利變動無差異）。籌碼分散組待集保累積 20 週以上再重新校準。

- [ ] 使用者看過報告，決定門檻 → `config_version` 才改成 `d-v1.0`（標示為「實驗性」）
- [ ] 沒有差異時，由使用者決定要調整計分結構，還是暫停上線（§13 第 4 項）

---

## Phase 4：部署整合

### T14：Worker 路由
**說明**：`/dist.json`、`/api/dist`（加上 `min_coverage`）、`/api/stock/:code` 回傳 `distribution`；舊版分片回傳 `null`。
**驗收**：
- [ ] 在 `wrangler dev --local` 下，三個路由都正常；用舊版分片時，回傳 `distribution: null`，不會出錯。
- [ ] T0 回歸比對的 API 項目通過。
**依賴**：T11 · **檔案**：`worker/index.js` · **規模**：S

### T15：出貨風險頁 `dist.html` 與提示
**說明**：新增 `dist.html` + `dist.js`（`scan.html` 不改），`index.html`、`scan.html` 導覽列加連結。不同的強調色、`PROVISIONAL`/`COLLAPSED` 分組顯示、覆蓋率、§8.3 的四種提示、個股詳情的借券資訊。
**驗收**：
- [ ] 本機 R2 準備五組檔案：四組各自只顯示對應的提示；完全一致的那組不顯示任何提示。
- [ ] 手機寬度版面正常（沿用 #5 的自適應）。
- [ ] `scan.html` 只多一個連結，吸籌頁行為不變。
**依賴**：T14 · **檔案**：`docs/dist.html`、`docs/dist.js`、`docs/style.css`、`docs/index.html`、`docs/scan.html` · **規模**：M

### T16：workflow、排程、README
**說明**：出貨評分和上傳 `dist.json` 設 `continue-on-error`；`wrangler.jsonc` 加上 `45 14 * * MON-FRI`；`update.yml` 加上 `'45 14 * * 1-5'`；README 新增一節（用語照 §1.2）。
**驗收**：
- [ ] `update.yml` 沒有 `inputs:`；grep 確認沒有任何腳本讀取觸發來源的日期。
- [ ] `wrangler dev --test-scheduled` 打 `/__scheduled?cron=45+14+*+*+MON-FRI`，確認有送出 dispatch。
**依賴**：T11 · **檔案**：`.github/workflows/update.yml`、`wrangler.jsonc`、`README.md` · **規模**：S

### T17：本機模擬驗收
**說明**：依照 §11 P4 的模擬流程：先在缺借券資料的狀態下執行，再補上資料執行一次；模擬只缺 TPEX；模擬出貨評分失敗。
**驗收**：
- [ ] 第二次執行後旗標消失、`dist_daily` 被覆蓋，`scan_daily` 兩次完全相同。
- [ ] 出貨評分失敗時，`scan.json` 照常產出，前端顯示「出貨結果停在…」。
**依賴**：T14、T15、T16 · **規模**：S（主要是執行和記錄）

### T18：併發驗收（對外操作，要先確認）
**說明**：暫時新增 `concurrency-test.yml`，推到遠端分支，連續觸發三次，記錄結果後刪除。
**驗收**：
- [ ] 第 1 次完成、第 2 次 `cancelled`、第 3 次完成，而且開始時間晚於第 2 次的觸發時間。
- [ ] 三次的 run 連結寫進回報；這個 workflow 已經刪除，不會 merge。
**依賴**：T16 · **檔案**：`.github/workflows/concurrency-test.yml`（暫時） · **規模**：XS

> **2026-10-17 結果**:`workflow_dispatch` 需要 workflow 已在預設分支,所以改用以 `origin/master` 為基礎的暫時分支 `ci/concurrency-test`、`on: push` 觸發(concurrency 行為和觸發方式無關)。三次 push 間隔約 13 秒(UTC 05:20:07、05:20:20、05:20:33):
> - 第 1 次 [39005879320](https://github.com/weiyungwu/tw-inst-screener/actions/runs/39005879320):success,job 05:20:12 ~ 05:21:45
> - 第 2 次 [39005894877](https://github.com/weiyungwu/tw-inst-screener/actions/runs/39005894877):**cancelled**(05:20:36 被第 3 次取代,job 沒有開始)
> - 第 3 次 [39005909512](https://github.com/weiyungwu/tw-inst-screener/actions/runs/39005909512):success,job 05:21:47 開始(第 1 次結束後、晚於第 2 次的觸發時間)
> - 暫時分支已從遠端與本機刪除,沒有 merge。

### Checkpoint P4
- [ ] 全部測試和回歸比對通過
- [ ] 開 PR 到 `weiyungwu:master`，**不 merge**

---

## 風險與對策
| 風險 | 影響 | 對策 |
|---|---|---|
| 沒有改動前的快照，回歸比對無從做起 | 高 | T0 排在最前面，基準快照存在 `data/` |
| fixture 中有列不符合勾稽公式（例如停券股的調整數） | 中 | T1 先做一次全列檢查，有例外就回報，不要默默放寬 |
| TPEX 晚於 22:45 才公布 | 中 | T2 實測；隔天 14 天補漏機制是退路 |
| 歷史資料只有約 60 天，校準結論不可靠 | 高 | T13 照實標示樣本不足；d-v1.0 標示「實驗性」 |
| `score.mjs` 整合時不小心改到吸籌的輸出 | 高 | 每個動到 `features.mjs`/`score.mjs` 的任務，驗收都包含 T0 比對 |
| T18 會推到 GitHub、觸發 Actions | 低 | 用獨立的 group 名稱，執行前先問使用者 |

## 平行化
- 可以平行：T2（已排程）、T5、T7、T9、T10、T12 彼此之間沒有依賴。
- 必須依序：T6 → T8 → T11 → T13（共用 DB 和 `score.mjs`）。

## 已定案（2026-10-16）
1. 規格標頭改成 v0.4。
2. T2 用本機 crontab 自動抓。
3. 校準報告放進 repo：`specs/distribution-calibration.md`。
4. 前端另開 `dist.html`（規格 §8.3、§13 第 5 項已同步）。
