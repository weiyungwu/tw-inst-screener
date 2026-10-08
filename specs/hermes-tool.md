# Hermes Agent 工具定義（台股籌碼 API）

讓 Hermes Agent（或任何支援 function calling 的 agent）查詢本站的「法人同步買超」與「主力吸籌掃描」資料。

- 工具定義採 JSON Schema（OpenAI／Hermes function calling 通用格式）。實際接入方式（tool 檔、MCP、OpenAPI）依你使用的 Hermes 版本調整，**參數與回應格式以本文件為準**。
- `BASE` = `https://tw-inst-screener.<你的子網域>.workers.dev`
- 全部端點都是 `GET`，回傳 JSON，允許跨來源（CORS `*`）。
- 若 Worker 設定了 secret `API_TOKEN`，`/api/*` 要帶 `Authorization: Bearer <token>`；沒設定就公開。
- 資料每個交易日 18:00、20:00（台北時間）更新。

## 端點總覽

| 工具 | 端點 | 用途 |
|---|---|---|
| `tw_cobuy` | `GET /api/cobuy` | 法人同步買超篩選，結果與網頁首頁相同 |
| `tw_scan` | `GET /api/scan` | 吸籌掃描清單（已評分、分類） |
| `tw_stock` | `GET /api/stock/{code}` | 單檔完整特徵、分數與近 20 日序列 |

## 1. `tw_cobuy` — 法人同步買超

`GET /api/cobuy?days=10&streak=5&insts=foreign,dealer&market=TPEX&sort=foreign&limit=50`

| 參數 | 預設 | 說明 |
|---|---|---|
| `days` | 10 | 累計天數。每個勾選的法人在最近 `days` 個交易日的買賣超加總都要 > 0 |
| `streak` | 5 | 連續買超天數。每個勾選的法人從最後一天往前都要連續買超至少 `streak` 天 |
| `insts` | `foreign,dealer` | 逗號分隔：`foreign` 外資（含陸資）、`trust` 投信、`dealer` 自營商（自行＋避險）。**每個都要各自符合** |
| `market` | 全部 | `TWSE` 上市、`TPEX` 上櫃 |
| `sort` | `insts` 的第一個 | 依哪個法人的累計買超由大到小排序 |
| `limit` | 50 | 最多 200 |

`days`、`streak` 超過資料天數（目前 10 天）時以資料天數為準，實際套用值見回應的 `params`。

回應：

```json
{
  "updated_at": "2026-10-07T13:24:34+08:00",
  "trading_days": ["2026-09-21", "…", "2026-10-06"],
  "unit": "張",
  "params": { "days": 10, "streak": 5, "insts": ["foreign", "dealer"], "market": "ALL", "sort": "foreign" },
  "count": 5,
  "stocks": [
    {
      "code": "3711", "name": "日月光投控", "market": "TWSE",
      "foreign_sum": 30125, "foreign_streak": 5, "foreign_daily": [ … 10 筆 … ],
      "trust_sum": -8750, "trust_streak": 0, "trust_daily": [ … ],
      "dealer_sum": 2887, "dealer_streak": 5, "dealer_daily": [ … ]
    }
  ]
}
```

- 單位是**張**（股數 ÷ 1000），正數為買超。`*_daily` 和 `trading_days` 一一對應，由舊到新。
- `count` 是符合的總檔數，`stocks` 最多 `limit` 檔。

## 2. `tw_scan` — 吸籌掃描清單

`GET /api/scan?stage=ACCUMULATION,WATCH&min_score=50&market=TPEX&limit=50`

| 參數 | 預設 | 說明 |
|---|---|---|
| `stage` | `ACCUMULATION` | 逗號分隔：`ACCUMULATION` 吸籌（≥ 60 分）、`WATCH` 觀察（45～59 分）、`OVERHEATED` 過熱（20 日漲幅 > 25% 或量比 > 2.5，不論分數） |
| `min_score` | 0 | 最低分數 |
| `market` | 全部 | `TWSE`、`TPEX` |
| `limit` | 50 | 最多 200 |

回應：`{ scan_date, updated_at, quality, tdcc_weeks, count, stocks: [...] }`。每檔有 `score`、`stage`、`breakdown`、`signals`、`features`、`close`，依分數由高到低排序。

- `quality` 為 `"tdcc_warming_up"` 時，集保資料不足 4 週，籌碼集中分數僅供參考，回答時要提醒。
- `breakdown`：`inst` 法人緩買（滿分 30）、`concentration` 籌碼集中（30）、`price` 價格未動（20）、`volume` 量能溫和（10）、`margin` 融資退場（10）。

## 3. `tw_stock` — 單檔明細

`GET /api/stock/{code}`（4 位數普通股代號）。查無此檔（ETF、權證、下市或代號錯誤）時回 `404 { "error": "not_found" }`。

回應包含 `score`、`stage`、`breakdown`、`signals`、`features`、`close`、`levels`、`series`。只要是有資料的普通股都查得到，包含 `NEUTRAL`、`EXCLUDED`。

- `levels`（程式算好的價位，給分析報告用，不參與評分）：`close`、`prev_close`、`ma5`、`ma10`、`ma20`、`ma60`、`high_20`、`low_20`、`high_60`、`low_60`（元）；`volume`、`vol_ma5`、`vol_ma20`（**股**）。
- `series`（近 20 個交易日，由舊到新）：`date`、`open`、`high`、`low`、`close`（元）、`volume`（股）、`inst_net`（外資＋投信）、`foreign_net`、`trust_net`、`dealer_net`（**股**）、`margin_balance`（融資餘額，**張**）。

### features 單位對照（解讀時最容易出錯）

| 特徵 | 單位 | 意義 |
|---|---|---|
| `inst_net_20_pct`、`trust_net_20_pct`、`dealer_net_20_pct` | % 股本（0.8 = 0.8%） | 20 日外資＋投信／投信／自營商淨買超占發行股數 |
| `inst_buy_days_20` | 天 | 20 日中外資＋投信淨買超為正的天數 |
| `foreign_ratio_chg_20` | 百分點 | 外資持股比率 20 日變化 |
| `ret_20`、`dist_ma60`、`range_20`、`margin_chg_20`、`holders_chg_4w_pct` | 小數（0.05 = 5%） | 20 日漲幅、季線乖離、20 日振幅、融資 20 日變化、股東人數 4 週變化 |
| `vol_ratio` | 倍 | 20 日均量 ÷ 60 日均量 |
| `avg_value_20` | 元 | 20 日平均成交金額 |
| `big400_pct`、`big1000_pct`、`retail_pct` | % | 400 張以上大戶、千張大戶、50 張以下散戶的持股比例 |
| `big400_up_weeks` | 週 | 大戶比例連續週增週數 |
| `big400_chg_4w`、`retail_chg_4w` | 百分點 | 4 週變化 |
| `holders` | 人 | 集保股東人數 |
| `series[].inst_net`、`foreign_net`、`trust_net`、`dealer_net` | **股**（不是張） | 每日法人淨買超 |
| `series[].volume`、`levels.volume`、`vol_ma5`、`vol_ma20` | **股** | 成交量 |
| `series[].margin_balance` | 張 | 融資餘額 |

`null` 代表資料不足（停牌、新上市、不能融資、集保週數不夠），**不可當成 0**。對應的 `signals` 會有 `missing:<特徵名>`。

## 工具定義（JSON Schema）

```json
[
  {
    "type": "function",
    "function": {
      "name": "tw_cobuy",
      "description": "台股法人同步買超篩選:勾選的每個法人(外資/投信/自營商)各自在最近 days 日買超加總 > 0,且最近連續買超至少 streak 天。結果與網站首頁相同。數值單位為張。",
      "parameters": {
        "type": "object",
        "properties": {
          "days": { "type": "integer", "minimum": 1, "maximum": 10, "default": 10, "description": "累計天數" },
          "streak": { "type": "integer", "minimum": 1, "maximum": 10, "default": 5, "description": "連續買超天數" },
          "insts": { "type": "array", "items": { "type": "string", "enum": ["foreign", "trust", "dealer"] }, "default": ["foreign", "dealer"], "description": "要同時符合的法人" },
          "market": { "type": "string", "enum": ["TWSE", "TPEX"], "description": "省略為上市＋上櫃" },
          "sort": { "type": "string", "enum": ["foreign", "trust", "dealer"], "description": "依哪個法人累計買超排序,預設 insts 第一個" },
          "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "tw_scan",
      "description": "台股主力吸籌掃描清單(每日收盤後評分 0~100)。ACCUMULATION=吸籌、WATCH=觀察、OVERHEATED=過熱。回傳分數、各群組得分、訊號與特徵。",
      "parameters": {
        "type": "object",
        "properties": {
          "stage": { "type": "array", "items": { "type": "string", "enum": ["ACCUMULATION", "WATCH", "OVERHEATED"] }, "default": ["ACCUMULATION"] },
          "min_score": { "type": "integer", "minimum": 0, "maximum": 100, "default": 0 },
          "market": { "type": "string", "enum": ["TWSE", "TPEX"] },
          "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "tw_stock",
      "description": "查詢單一台股普通股的吸籌特徵、分數、各群組得分與近 20 日法人淨買(股)、收盤價、成交量。",
      "parameters": {
        "type": "object",
        "properties": { "code": { "type": "string", "pattern": "^[1-9]\\d{3}$", "description": "4 位數股票代號,例如 2330" } },
        "required": ["code"]
      }
    }
  }
]
```

### 呼叫實作（參考）

把工具參數轉成查詢字串即可，陣列用逗號串接：

```js
const BASE = 'https://tw-inst-screener.<你的子網域>.workers.dev';
const headers = process.env.TW_API_TOKEN ? { Authorization: `Bearer ${process.env.TW_API_TOKEN}` } : {};

async function call(name, args) {
  const q = new URLSearchParams(
    Object.entries(args).filter(([, v]) => v != null).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
  );
  const path = name === 'tw_stock' ? `/api/stock/${args.code}`
    : name === 'tw_cobuy' ? `/api/cobuy?${q}`
    : `/api/scan?${q}`;
  const r = await fetch(BASE + path, { headers });
  return r.json(); // 錯誤也是 JSON:{ error, ... },直接交給模型
}
```

## 系統提示（建議）

```
你可以使用 tw_cobuy、tw_scan、tw_stock 三個工具查詢台股籌碼資料。

- 回答前先說明資料日期:tw_cobuy 看 trading_days 最後一天,tw_scan/tw_stock 看 scan_date。
- 注意單位:tw_cobuy 是「張」;tw_stock 的 series.inst_net 是「股」;features 單位依工具說明,比例類多為小數(0.05 = 5%)。
- 欄位為 null 代表資料不足,要說「資料不足」,不可當成 0 推論。
- quality 為 tdcc_warming_up 時,提醒籌碼集中分數僅供參考。
- 引用具體數字說明哪些訊號成立、哪些缺漏;同一檔若同時出現在法人同步買超與吸籌清單,可特別指出。
- 只做資料整理與分析,不給買賣建議;結尾註明「僅供研究參考,非投資建議」。
```

## 提問範例

- 「找出最近 10 天外資和投信都買超、且連續買超至少 3 天的上櫃股，依外資累計排序列前 10 檔。」
  → `tw_cobuy({ insts: ["foreign","trust"], streak: 3, market: "TPEX", limit: 10 })`
- 「今天吸籌分數最高的 10 檔是哪些？每檔是哪些群組拿分？」
  → `tw_scan({ limit: 10 })`
- 「法人同步買超和吸籌清單有哪些重疊？逐檔分析。」
  → `tw_cobuy({})` ＋ `tw_scan({ stage: ["ACCUMULATION","WATCH"], limit: 200 })` 取交集，再對每檔 `tw_stock`
- 要產出完整的分析報告時，建議改用 Hermes skill `specs/台股籌碼資料_Skill_v1.1.md` 抓資料，再交給 `stock-4d-3d-trade-report` 產生報告。
- 「3481 最近籌碼怎麼樣？」
  → `tw_stock({ code: "3481" })`

## 免責

本系統只是籌碼與價量的統計篩選工具，不構成投資建議。分數權重為 v1 主觀設定，尚未經回測驗證。
