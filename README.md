# 台股：法人同步買超選股器

自動找出**最近數個交易日,勾選的法人(外資/投信/自營商)「都」買超**的台股(上市 + 上櫃),做成一個
**公開網頁**,手機/任何電腦用網址即可查看,每個交易日收盤後**自動更新**,你的電腦不用開機。

## 篩選條件
每一檔股票,網頁上**勾選的法人**(預設外資+自營商,可加勾投信)**各自**都要滿足:
- 外資含陸資;自營商含自行+避險
1. 在「累計天數」(預設 10 個交易日)內,**淨買超合計 > 0**
2. 在「連續買超天數」(預設 5 天)內,**每天都淨買超**

> 上述兩個參數可在網頁上即時調整;數值單位為「**張**」(股數 ÷ 1000)。

## 運作方式
```
Cloudflare Cron Triggers(週一至五 台北 18:00 / 20:00 準時)→ 觸發 GitHub Actions
GitHub Actions(自身排程常延遲,保留為備援)
   └─ scripts/build-data.mjs  抓 TWSE + TPEX 三大法人買賣超 → 篩選 → data.json → 上傳 R2
Cloudflare Workers
   ├─ docs/                   靜態頁面(index.html / app.js),push 到 master 時自動部署
   └─ worker/index.js         /data.json 從 R2(bucket tw-stocks-data)讀出回傳;排程時觸發 GitHub Actions
```
- 資料來源:臺灣證券交易所(TWSE T86)、證券櫃檯買賣中心(TPEX)。
- 前端讀取同源 `/data.json`,沒有 CORS 問題;資料更新只寫 R2,不 commit 回 repo、也不需重新部署。
- 抓資料腳本**零 npm 依賴**,只需 Node 18+;部署與上傳用 `wrangler`(需 Node 22+)。

## 本機開發
```bash
node scripts/build-data.mjs     # 重新抓資料,產生 docs/data.json(建議 TZ=Asia/Taipei)
node scripts/serve.mjs          # http://localhost:8080 預覽網頁
node scripts/verify.mjs         # 列印目前符合條件的股票(自我檢查用)
```
> `docs/data.json` 只存在本機(已列入 `.gitignore`、`docs/.assetsignore`),不會被 commit 或部署。
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

- **資料**:歷史存在 SQLite(`data/history.sqlite`),放在 R2 的 `db/history.sqlite`。每次 workflow 下載 → 補資料 → 上傳。
  集保股權分散表每週寫入新的一週時,另外備份到 `backups/history-<集保日期>.sqlite`。
- **需求**:Node ≥ 22.13(使用內建 `node:sqlite`),runtime 零 npm 依賴。
- **API**(`/api/*` 允許跨來源;設定 Worker secret `API_TOKEN` 後需帶 `Authorization: Bearer <token>`):
  - `GET /scan.json`:今日 ACCUMULATION / WATCH / OVERHEATED 清單
  - `GET /api/scan?stage=ACCUMULATION,WATCH&min_score=50&market=TPEX&limit=50`
  - `GET /api/stock/2330`:單檔完整特徵、分數與近 20 日序列(依代號前兩碼讀 `features/23.json`)
  - `GET /api/cobuy?days=10&streak=5&insts=foreign,trust&market=TPEX&sort=foreign&limit=50`:法人同步買超,篩選規則與首頁相同(單位張)
  - Hermes Agent 等 agent 的工具定義與系統提示見 [specs/hermes-tool.md](specs/hermes-tool.md)

```bash
# 本機(建議先 export TZ=Asia/Taipei)
node scripts/ingest-daily.mjs            # 補近 14 天缺漏的法人、收盤行情、融資、外資持股
node scripts/ingest-weekly.mjs           # 集保最新一週(已有就略過)
node scripts/score.mjs                   # 產生 docs/scan.json、data/features/*.json、scan_daily
node scripts/verify-scan.mjs             # 今日各階段檔數與 ACCUMULATION 前 20 檔
node scripts/verify-scan.mjs --stats     # 各表日期數、筆數與缺漏
node --test                              # 單元測試
```

### 首次部署
workflow 下載不到 `db/history.sqlite` 時會**直接失敗**(不會建空檔覆蓋歷史),所以第一次要先在本機建好再上傳:
```bash
node scripts/backfill.mjs --days 60      # 回補 60 個交易日(約 25~30 分鐘,請求間隔 3 秒)
node scripts/ingest-weekly.mjs           # 集保最新一週
node scripts/backfill.mjs --tdcc-weeks 4 # 選用:從集保官網回補前 4 週(一檔一週一次請求,約 2,000 檔 × 4 ≈ 7 小時)
npx wrangler r2 object put tw-stocks-data/db/history.sqlite --file data/history.sqlite --remote
```
回補可以中斷後重跑,已存在的日期與個股會跳過。集保未滿 4 週時,頁面會顯示「籌碼集中分數僅供參考」。

### 本機測試 Worker
```bash
node scripts/score.mjs
npx wrangler r2 object put tw-stocks-data/scan.json --file docs/scan.json --local
for f in data/features/*.json; do npx wrangler r2 object put "tw-stocks-data/features/$(basename $f)" --file "$f" --local; done
npx wrangler dev                         # http://localhost:8787/scan.html、/api/scan、/api/stock/2330
```

## 免責
本專案僅供研究參考,**非投資建議**。資料以官方公告為準,程式可能因官方端點調整而需維護。
