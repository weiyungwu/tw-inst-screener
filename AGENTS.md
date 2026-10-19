# AGENTS.md

給在本 repo 工作的 AI coding agent（Claude Code、Codex、Hermes 等）。專案介紹與部署見 [README.md](README.md)；這裡只寫**改程式時容易踩錯的規則**。

## 溝通
- 回覆、commit 訊息、PR 說明、程式註解一律用**繁體中文**。
- 本 repo 是 fork。PR 一律開到 `weiyungwu/tw-inst-screener` 的 `master`，**不可開到上游**；合併方式用 squash。

## 目錄
| 路徑 | 內容 |
|---|---|
| `docs/` | 靜態網頁（無 build step）。`ui.css` 三頁共用樣式、`theme.js` 深淺色切換 |
| `lib/` | 評分規則：`score.mjs` 吸籌、`distribution.mjs` 出貨、`fourd.mjs` 四維燈號、`features.mjs` 特徵 |
| `scripts/` | 抓資料（`ingest-*`、`backfill`）、評分（`score.mjs`）、驗證與校準 |
| `worker/` | Cloudflare Worker：從 R2 回傳 JSON 與 `/api/*` |
| `specs/` | 規格、Hermes 工具定義（`hermes-tool.md`）與 Hermes skill 檔 |
| `test/` | `node:test` 單元測試 |

## 指令
```bash
node --test test/*.test.mjs        # 單元測試（直接寫 `node --test test/` 會把目錄當成單一檔案而失敗）
node scripts/serve.mjs             # http://localhost:8080 預覽 docs/
DB_PATH=/tmp/copy.sqlite node scripts/score.mjs   # 驗證評分輸出；用資料庫複本，不要直接寫 data/history.sqlite
```
- 需要 Node ≥ 22.13（內建 `node:sqlite`）。runtime **零 npm 依賴**，不要加套件。
- `docs/data.json`、`scan.json`、`dist.json` 與 `data/` 都不進 git。預覽畫面時可以從正式站 <https://tw-stocks.happytoo.cc> 下載 JSON 放進 `docs/`。

## 資料與評分
- **單位最容易出錯**：法人淨買超在 `series` 是**股**、在首頁與 `/api/cobuy` 是**張**；比例類特徵多為小數（0.05 = 5%），`*_pct` 是 % 股本。完整對照見 `specs/hermes-tool.md`。
- `null` 代表資料不足，**不可當成 0**；缺資料的評分項目給 0 分並列入 `missing:*`，0 分不代表沒有風險。
- 改評分門檻要遞增 `CONFIG.version`（吸籌 `lib/score.mjs`、出貨 `lib/distribution.mjs`），回測靠它區分新舊版本。
- 四維偏多燈號規則同時寫在 `lib/fourd.mjs` 與 `specs/stock-4d-3d-trade-report_v4.md` §5，**改一邊就要改另一邊**。
- 四維偏空燈號（`fourDBear`，出貨頁）的均線、型態沿用 `specs/stock-dist-risk-report_v1.md` §5 結構檢查；規則也寫在 `specs/hermes-tool.md` 與 `docs/dist.html` 頁尾，改規則時這幾處要一起改。兩組燈號都**只顯示、不計分**。
- 出貨評分失敗**不可影響吸籌**：吸籌照常輸出，`dist.json` 保留上一版。
- 改 API 回應欄位時，同步更新 `specs/hermes-tool.md` 與 `specs/台股籌碼資料_Skill_v1.2.md`。

## 用語（網頁、API、skill 都適用）
- 出貨相關一律稱「**疑似出貨風險訊號**」，不寫「主力正在出貨」；借券不等於放空，法人賣超不等於主力做空。
- 出貨名單只能當 20 日左右的風險提示，**不提供放空進場價或放空時點**。
- 頁面與報告結尾保留免責：「非投資建議」，出貨相關另加「亦非放空建議」。

## 前端
- 顏色用 CSS 變數，深色與淺色都要定義（淺色在 `ui.css` 的 `:root[data-theme="light"]`）。台股慣例**紅漲綠跌**：`--pos` 紅、`--neg` 綠。
- 各頁強調色：首頁與吸籌頁藍色、出貨頁橘色（避免把出貨清單看成買進名單），在各頁 `<style>` 設定。
- 樣式放在 `ui.css`（共用）或各頁 `<style>`（該頁特有）；HTML 不寫 inline style（JS 動態算出的寬度等數值除外）。
- 改完要檢查桌面與手機寬度（390px）、深色與淺色主題，並確認頁面沒有水平溢出。

## Hermes skill
- `specs/` 裡的 skill 檔（`台股籌碼資料_Skill_*`、`stock-4d-3d-trade-report_*`、`stock-dist-risk-report_*`）是 Hermes Agent 的 skill 原稿。
- Hermes 是透過 Telegram 安裝**複本**：skill 改版合併後，要提醒使用者把新檔傳給 Hermes，並請它**取代**同名 skill（不要新增）。
- 報告 skill 的數字只能來自資料包，不連網補值；新增規則要能用資料包的數字照算。
