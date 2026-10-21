# 台股籌碼掃描器：法人同步買超 × 主力吸籌 × 疑似出貨風險

每個交易日收盤後,自動抓取證交所、櫃買中心、集保結算所的公開資料,替上市櫃普通股做三種籌碼篩選,做成**公開網頁**與 **API**。
手機或任何電腦用網址就能查看,資料自動更新,你的電腦不用開機。

- 正式網址:<https://tw-stocks.happytoo.cc>

| 頁面 | 網址 | 回答的問題 |
|---|---|---|
| 法人同步買超 | `/`(首頁) | 最近幾天,勾選的法人是不是**都**在買? |
| 主力吸籌掃描 | `/scan.html` | 有沒有人在股價還沒動時悄悄佈局?(0～100 分) |
| 疑似出貨風險 | `/dist.html` | 法人賣、大戶減、高檔轉弱、借券增加等現象是否同時出現?(0～100 分,實驗性) |

- **介面**:三頁共用頁籤導覽與篩選元件(`docs/ui.css`);右上角可切換深色/淺色,會記住選擇,沒選過時跟隨系統(`docs/theme.js`)。
- **手機**:代號、名稱兩欄凍結可橫滑對照;點列展開的明細固定在畫面內;頁尾說明預設收合。
- **API**:給 Hermes Agent 等 AI agent 使用,見下方各節與 [specs/hermes-tool.md](specs/hermes-tool.md)。

## 法人同步買超(首頁)
每一檔股票,網頁上**勾選的法人**(預設外資+自營商,可加勾投信)**各自**都要滿足:
- 外資含陸資;自營商含自行+避險
1. 在「累計天數」(預設 10 個交易日)內,**淨買超合計 > 0**
2. 在「連續買超天數」(預設 5 天)內,**每天都淨買超**

> 上述兩個參數可在網頁上即時調整;數值單位為「**張**」(股數 ÷ 1000)。

## 運作方式
```
Cloudflare Cron Triggers(週一至五 台北 18:00 / 20:00 / 22:45 準時)→ 觸發 GitHub Actions
GitHub Actions(自身排程常延遲,保留為備援)
   ├─ scripts/build-data.mjs    抓 TWSE + TPEX 三大法人 → data.json → 上傳 R2(首頁)
   └─ 從 R2 下載 db/history.sqlite
        ├─ scripts/ingest-daily.mjs   法人、行情、融資、外資持股、借券賣出
        ├─ scripts/ingest-weekly.mjs  集保股權分散(每週)
        ├─ scripts/score.mjs          吸籌與出貨評分 → scan.json、dist.json、features/*.json
        └─ 上傳資料庫與結果到 R2
Cloudflare Workers
   ├─ docs/                     靜態頁面,push 到 master 時自動部署
   └─ worker/index.js           /data.json、/scan.json、/dist.json、/api/* 從 R2 讀出;排程時觸發 GitHub Actions
```
- 資料來源:臺灣證券交易所(TWSE)、證券櫃檯買賣中心(TPEX)、臺灣集中保管結算所(TDCC)。
- 前端讀取同源 JSON,沒有 CORS 問題;資料更新只寫 R2,不 commit 回 repo,也不需重新部署。
- 前端沒有 build step;抓資料與評分腳本**零 npm 依賴**,需 Node ≥ 22.13(使用內建 `node:sqlite`);部署與上傳用 `wrangler`。

## 本機開發
```bash
node scripts/build-data.mjs     # 重新抓首頁資料,產生 docs/data.json(建議 TZ=Asia/Taipei)
node scripts/serve.mjs          # http://localhost:8080 預覽網頁
node scripts/verify.mjs         # 列印目前符合條件的股票(自我檢查用)
```
> `docs/data.json`、`scan.json`、`dist.json` 只存在本機(已列入 `.gitignore`、`docs/.assetsignore`),不會被 commit 或部署。
> 只想看畫面時,可以直接從正式站下載這三個檔案放進 `docs/`。
> 若要連同 Worker + R2 一起在本機測試:
> ```bash
> npx wrangler r2 object put tw-stocks-data/data.json --file docs/data.json --local
> npx wrangler dev                # 用本機模擬的 R2
> ```

## 部署到 Cloudflare
1. **Cloudflare → R2**:建立 bucket `tw-stocks-data`(名稱需與 `wrangler.jsonc` 一致)。
2. **Cloudflare → My Profile → API Tokens**:建立 Custom token,權限 `Account / Workers R2 Storage / Edit`。
3. **GitHub repo → Settings → Secrets and variables → Actions**:新增
   - `CLOUDFLARE_API_TOKEN`:上一步的 Token
   - `CLOUDFLARE_ACCOUNT_ID`:Cloudflare Dashboard 網址 `dash.cloudflare.com/<這段>/` 即是
4. **Cloudflare → Workers & Pages → Create application → Import a repository**:選本 repo,
   名稱填 `tw-inst-screener`(需與 `wrangler.jsonc` 的 `name` 一致),Build command 留空,
   Deploy command 用預設 `npx wrangler deploy`。之後 push 到 `master` 會自動部署。
5. **GitHub → Settings → Developer settings → Fine-grained tokens**:建立只授權本 repo、
   `Actions: Read and write` 的 token,存到 Worker 的 Secret `GITHUB_TOKEN`
   (Cloudflare → Worker → Settings → Variables and Secrets,或 `npx wrangler secret put GITHUB_TOKEN`)。
   token 到期後 Cloudflare 排程會失效,只剩 GitHub 自身排程。
6. 到 GitHub **Actions** 頁手動跑一次「更新法人買賣超資料」(Run workflow),把資料寫進 R2,
   完成後開 `https://tw-inst-screener.<你的子網域>.workers.dev/` 即可查看。之後每個交易日會自動更新。

## 主力吸籌掃描器(`/scan.html`)
每個交易日收盤後,依四類訊號替上市櫃普通股評分(0~100),找出「法人緩買、大戶集中、價格還沒噴、融資退場」的個股。
完整規格見 [specs/accumulation-scanner-spec.md](specs/accumulation-scanner-spec.md),各端點實測欄位見 [specs/endpoints.md](specs/endpoints.md)。

### 評分(v1.1,門檻集中在 `lib/score.mjs` 的 `CONFIG`)
| 群組 | 滿分 | 說明 |
|---|---|---|
| 法人 | 30 | 20 日淨買超占股本比、20 日內買超天數 |
| 籌碼集中 | 30 | 400 張以上大戶連續增加週數、**股東人數 4 週減少超過 2%**、大戶比例 4 週變化 |
| 價格位置 | 20 | 20 日漲幅 −5%~10%、離季線 ±10% 內、20 日振幅 ≤ 15% |
| 量能 | 10 | 量比 1.0~1.8 得 10 分、0.8~1.0 得 5 分 |
| 融資 | 10 | 融資 20 日減少;20 日前餘額 < 100 張時視為資料不足(0 分) |

- **階段**:吸籌 `ACCUMULATION` ≥ 70、觀察 `WATCH` 55~69、其餘 `NEUTRAL`;20 日漲幅 > 25% 或量比 > 2.5 為過熱 `OVERHEATED`;
  20 日均成交值 < 2,000 萬為 `EXCLUDED`。
- 集保資料不足(未滿 4 週)時其他群組合計上限 70,實際上最多只到觀察。
- `scan.json` 帶 `config_version`,調整規則時遞增,回測可區分新舊版本。

### 四維燈號
吸籌頁的「四維」欄(可依紅燈數排序)顯示籌碼、量能、均線、型態四顆燈,紅燈偏多、綠燈不成立、灰色為資料不足(不當綠燈)。
出貨頁改用**四維偏空**燈號(`bear_lights`,`lib/fourd.mjs` 的 `fourDBear`):綠燈 = 已轉弱(台股綠跌)、空心 = 還沒轉弱、灰色 = 資料不足,
條件和偏多燈號左右對稱,均線、型態沿用出貨報告 skill v1.1 的「趨勢偏空」與「疑似假突破」。偏多紅燈 ≥ 3 時另標「走勢仍強」。
兩組燈號都只顯示,不影響吸籌或出貨分數。
規則見 [specs/stock-4d-3d-trade-report_v4.md](specs/stock-4d-3d-trade-report_v4.md) §5,實作在 `lib/fourd.mjs`:
- **籌碼**:20 日法人淨買超 ≥ 股本 0.2%、20 日內買超 ≥ 10 天、近 5 日法人合計 > 0
- **量能**:帶量上攻(量 ≥ 1.5 × 前 5 日均量且收紅),或量比 1.0~1.8 且非爆量長黑
- **均線**:收盤同時站上 5 / 10 / 20 / 60 日均線
- **型態**:收盤 > 前 19 日最高,或 ≥ 前 59 日最高

> 「前 N 日」都不含當天,避免當天數值跟自己比。

- **資料**:歷史存在 SQLite(`data/history.sqlite`),放在 R2 的 `db/history.sqlite`。每次 workflow 下載 → 補資料 → 上傳。
  集保股權分散表每週寫入新的一週時,另外備份到 `backups/history-<集保日期>.sqlite`。
- **需求**:Node ≥ 22.13(使用內建 `node:sqlite`),runtime 零 npm 依賴。
- **API**(`/api/*` 允許跨來源;設定 Worker secret `API_TOKEN` 後需帶 `Authorization: Bearer <token>`):
  - `GET /scan.json`:今日 ACCUMULATION / WATCH / OVERHEATED 清單(含四維燈號 `lights`)
  - `GET /api/scan?stage=ACCUMULATION,WATCH&min_score=50&market=TPEX&limit=50`
  - `GET /api/stock/2330`:單檔完整特徵、分數、四維燈號、均線與價位(`levels`)及近 20 日序列(依代號前兩碼讀 `features/23.json`)
  - `GET /api/cobuy?days=10&streak=5&insts=foreign,trust&market=TPEX&sort=foreign&limit=50`:法人同步買超,篩選規則與首頁相同(單位張)
  - Hermes Agent 等 agent 的工具定義與系統提示見 [specs/hermes-tool.md](specs/hermes-tool.md);
    抓資料用的 skill 見 [specs/台股籌碼資料_Skill_v1.6.md](specs/台股籌碼資料_Skill_v1.6.md);
    報告 skill:偏多交易劇本 [specs/stock-4d-3d-trade-report_v4.md](specs/stock-4d-3d-trade-report_v4.md)、疑似出貨風險與持股防守 v1.2 [specs/stock-dist-risk-report_v1.md](specs/stock-dist-risk-report_v1.md)(含四維偏空燈號、結構檢查、假突破/假跌破、推翻條件)
  - Hermes 透過 Telegram 安裝的是 skill 檔的**複本**:repo 裡的 skill 更新後,要把新檔再傳給 Hermes 並請它取代同名 skill。

```bash
# 本機(建議先 export TZ=Asia/Taipei)
node scripts/ingest-daily.mjs            # 補近 14 天缺漏的法人、收盤行情、融資、外資持股、借券賣出
node scripts/ingest-weekly.mjs           # 集保最新一週(已有就略過)
node scripts/score.mjs                   # 產生 docs/scan.json、docs/dist.json、data/features/*.json,寫入 scan_daily、dist_daily
node scripts/verify-scan.mjs             # 今日各階段檔數與 ACCUMULATION 前 20 檔
node scripts/verify-scan.mjs --stats     # 各表日期數、筆數與缺漏
node --test test/*.test.mjs              # 單元測試
```

### 首次部署
workflow 下載不到 `db/history.sqlite` 時會**直接失敗**(不會建空檔覆蓋歷史),所以第一次要先在本機建好再上傳:
```bash
node scripts/backfill.mjs --days 60      # 回補 60 個交易日,含借券(每天約 10 個請求、間隔 3 秒,實測約 1 小時以上)
node scripts/ingest-weekly.mjs           # 集保最新一週
node scripts/backfill.mjs --tdcc-weeks 4 # 選用:從集保官網回補前 4 週(一檔一週一次請求,約 2,000 檔 × 4 ≈ 7 小時)
npx wrangler r2 object put tw-stocks-data/db/history.sqlite --file data/history.sqlite --remote
```
回補可以中斷後重跑,已存在的日期與個股會跳過。集保未滿 4 週時,頁面會顯示「籌碼集中分數僅供參考」。

> **上傳之後,R2 的 `db/history.sqlite` 就是正本**:workflow 每天都在更新它,本機的 DB 只是工作副本。
> 不要再把本機的 DB 上傳覆蓋 R2,否則 R2 上較新的資料會不見。本機需要最新資料時,反過來從 R2 下載:
> `npx wrangler r2 object get tw-stocks-data/db/history.sqlite --file data/history.sqlite --remote`。
> 回補要在 R2 啟用前做完;已上線後若要補歷史,先下載 R2 最新版、在本機回補,並確認上傳前沒有 workflow 正在執行。

### 本機測試 Worker
```bash
node scripts/score.mjs
npx wrangler r2 object put tw-stocks-data/scan.json --file docs/scan.json --local
npx wrangler r2 object put tw-stocks-data/dist.json --file docs/dist.json --local
for f in data/features/*.json; do npx wrangler r2 object put "tw-stocks-data/features/$(basename $f)" --file "$f" --local; done
npx wrangler dev                         # http://localhost:8787/scan.html、/dist.html、/api/scan、/api/dist、/api/stock/2330
```

## 疑似出貨風險訊號(`/dist.html`)
吸籌掃描器的反面:找出法人淨賣出、大戶比例下降、股價從高點回落、帶量長黑、借券賣出餘額增加等現象同時出現的個股。
完整規格見 [specs/distribution-scanner-spec.md](specs/distribution-scanner-spec.md),校準結果見 [specs/distribution-calibration.md](specs/distribution-calibration.md)。

> **用語**:官方資料只能確認「法人淨賣出」「借券餘額增加」這類事實,**不能證明是誰在賣、為什麼賣**。
> 所以頁面與 API 一律稱「**疑似出貨風險訊號**」,不寫「主力正在出貨」;程式與檔名沿用 `distribution`。

### 評分(d-v1.0,**實驗性**;門檻在 `lib/distribution.mjs` 的 `CONFIG`,和吸籌不共用)
| 群組 | 滿分 | 說明 |
|---|---|---|
| 法人調節 | 30 | 20 日淨賣超占股本比、20 日內賣超天數 |
| 籌碼分散 | 25 | 400 張以上大戶連續減少週數、股東人數 4 週增加超過 2%、大戶比例 4 週減少 |
| 高檔轉弱 | 20 | 距 60 日高點回落 3%~15%、仍在季線上 5% 以上、跌破月線 |
| 量能異常 | 10 | 20 日內帶量長黑天數(量 ≥ 前 5 日均量 × 1.5、收黑、跌 ≥ 3%) |
| 信用與借券 | 15 | 借券賣出餘額 20 日增加占股本比、融資 20 日增加超過 10% |

- **缺資料不加分也不扣分**:特徵算不出來時該項 0 分,另外算**覆蓋率**(算得出來的配分 ÷ 100)。0 分代表「無法判斷」,不代表「沒有風險」。
- **階段**:`DISTRIBUTION` ≥ 70、`CAUTION` 55~69,都要覆蓋率 ≥ 85%;分數夠但覆蓋率不足為 `PROVISIONAL`(暫定);
  20 日跌幅 > 25% 或距 60 日高點 > 30% 為 `COLLAPSED`(已大幅下跌,不適用高檔派發判斷,**不代表風險解除**);
  20 日均成交值 < 2,000 萬為 `EXCLUDED`。
- **怎麼解讀(依 2026-04 ~ 10 回測,樣本短)**:名單個股之後 **20 日**平均落後同期個股約 2%,**5 日幾乎沒有差異**;
  期間內的最大上漲幅度和其他個股差不多。只適合當作 20 日左右的風險提示,**不適合抓短線放空時點**。
  籌碼分散組只有數週集保資料,門檻尚未經前瞻驗證。

### 借券賣出與 22:45 排程
- 新增資料源:TWSE `TWT93U`、TPEX `margin/sbl`(借券賣出餘額,單位股),存 `sbl_daily`;每列都要通過勾稽,任一不符整個市場當天不寫入。
- 借券比其他資料晚公布:實測兩個市場都在 20:30 之後、22:30 之前公布,22:30 之後不再變動(見 [specs/endpoints.md](specs/endpoints.md))。
  所以多一個 **22:45** 排程補當天借券、重算出貨分數(其他來源已存在會跳過)。
  18:00、20:00 那兩次的出貨結果會帶 `sbl_pending`,覆蓋率下降,頁面會提示「借券資料約 22:45 更新」。
- 出貨評分或上傳失敗不影響吸籌:`dist.json` 停在上一版,頁面依 `scan_date` 顯示「出貨結果停在…」。

### API
- `GET /dist.json`:今日 `DISTRIBUTION` / `CAUTION` / `PROVISIONAL` / `COLLAPSED` 清單(每檔含四維偏多 `lights` 與四維偏空 `bear_lights`),頂層有 `sbl_status`(各市場借券是否已公布)、`run_id`、`experimental`
- `GET /api/dist?stage=DISTRIBUTION,CAUTION&min_score=50&min_coverage=0.85&market=TPEX&limit=50`:參數比照 `/api/scan`,另加 `min_coverage`(0~1)
- `GET /api/stock/2330` 多一個 `distribution` 欄位(分數、覆蓋率、階段、訊號,帶自己的 `scan_date`、`run_id`)。
  **`distribution: null` 代表「沒有出貨資料」,不代表「沒有出貨風險」。**

```bash
node scripts/backfill.mjs --sbl          # 回補借券賣出(60 個交易日約 6 分鐘以上)
node scripts/calibrate-dist.mjs          # 逐日重算出貨評分,產生校準報告(唯讀)
node scripts/regress.mjs snapshot|compare  # 確認吸籌輸出沒有被改到
```

## 免責
本專案僅供研究參考,**非投資建議**;疑似出貨風險訊號**亦非放空建議**。資料以官方公告為準,程式可能因官方端點調整而需維護。
