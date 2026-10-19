# Hermes Agent 工具定義（台股籌碼 API）

讓 Hermes Agent（或任何支援 function calling 的 agent）查詢本站的「法人同步買超」、「主力吸籌掃描」與「疑似出貨風險訊號」資料。

- 工具定義採 JSON Schema（OpenAI／Hermes function calling 通用格式）。實際接入方式（tool 檔、MCP、OpenAPI）依你使用的 Hermes 版本調整，**參數與回應格式以本文件為準**。
- `BASE` = `https://tw-stocks.happytoo.cc`
- 全部端點都是 `GET`，回傳 JSON，允許跨來源（CORS `*`）。
- 若 Worker 設定了 secret `API_TOKEN`，`/api/*` 要帶 `Authorization: Bearer <token>`；沒設定就公開。
- 資料每個交易日 18:00、20:00、22:45（台北時間）更新。借券賣出約 22:30 才公布，所以 18:00、20:00 的出貨結果不含當天借券（見 `tw_dist`）。

## 端點總覽

| 工具 | 端點 | 用途 |
|---|---|---|
| `tw_cobuy` | `GET /api/cobuy` | 法人同步買超篩選，結果與網頁首頁相同 |
| `tw_scan` | `GET /api/scan` | 吸籌掃描清單（已評分、分類） |
| `tw_stock` | `GET /api/stock/{code}` | 單檔完整特徵、分數與近 20 日序列（含出貨評分 `distribution`） |
| `tw_dist` | `GET /api/dist` | 疑似出貨風險訊號清單（已評分、分類） |

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
| `stage` | `ACCUMULATION` | 逗號分隔：`ACCUMULATION` 吸籌（≥ 70 分）、`WATCH` 觀察（55～69 分）、`OVERHEATED` 過熱（20 日漲幅 > 25% 或量比 > 2.5，不論分數） |
| `min_score` | 0 | 最低分數 |
| `market` | 全部 | `TWSE`、`TPEX` |
| `limit` | 50 | 最多 200 |

回應：`{ scan_date, updated_at, quality, tdcc_weeks, count, stocks: [...] }`。每檔有 `score`、`stage`、`breakdown`、`signals`、`features`、`close`、`lights`，依分數由高到低排序。

- `quality` 為 `"tdcc_warming_up"` 時，集保資料不足 4 週，籌碼集中分數僅供參考，回答時要提醒。
- `breakdown`：`inst` 法人緩買（滿分 30）、`concentration` 籌碼集中（30）、`price` 價格未動（20）、`volume` 量能溫和（10）、`margin` 融資退場（10）。

## 3. `tw_stock` — 單檔明細

`GET /api/stock/{code}`（4 位數普通股代號）。查無此檔（ETF、權證、下市或代號錯誤）時回 `404 { "error": "not_found" }`。

回應包含 `score`、`stage`、`breakdown`、`signals`、`features`、`close`、`levels`、`lights`、`series`。只要是有資料的普通股都查得到，包含 `NEUTRAL`、`EXCLUDED`。

- `levels`（程式算好的價位，給分析報告用，不參與評分）：`close`、`prev_close`、`ma5`、`ma10`、`ma20`、`ma60`、`high_20`、`low_20`、`high_60`、`low_60`、`high_19_prev`、`high_59_prev`、`low_19_prev`（元）；`volume`、`vol_ma5`、`vol_ma5_prev`、`vol_ma20`（**股**）。`*_prev` 是不含當天的窗口（前 5 日均量、前 19／59 日最高、前 19 日最低）。
- `lights`（四維燈號，程式依 `stock-4d-3d-trade-report` §5 算好）：`chip` 籌碼、`volume` 量能、`ma` 均線、`pattern` 型態，各為 `"red"`（偏多）、`"green"`（不成立）或 `null`（資料不足，不可當成綠燈）；`red` 紅燈數、`valid` 有效燈數（扣除 `null`）。
- `bear_lights`（四維偏空燈號，出貨頁用，只顯示、不計入任何分數）：`chip`、`volume`、`ma`、`pattern` 各為 `true`（已轉弱）、`false`（還沒轉弱）或 `null`（資料不足，不可當成 `false`）；`bear` 轉弱燈數、`valid` 有效燈數。規則：籌碼＝20 日法人淨賣超 ≥ 股本 0.2%、20 天內賣超 ≥ 10 天、近 5 日合計 < 0；量能＝當天量 ≥ 前 5 日均量 × 1.5 且收黑，或 20 日內帶量長黑 ≥ 1 天；均線＝收盤 < MA20 且 MA5 < MA20；型態＝收盤 < 前 19 日最低，或疑似假突破（前 10 日最高 R，近 10 日曾收盤 > R，最新收盤 < R）。實作在 `lib/fourd.mjs` 的 `fourDBear`。
- `distribution`（出貨評分，欄位同 `tw_dist` 每檔的 `score`、`coverage`、`stage`、`breakdown`、`signals`，另帶自己的 `scan_date`、`run_id`、`config_version`、`market`）。**`null` 代表沒有出貨資料（舊版資料、不在當日股票池、出貨評分失敗），不代表沒有出貨風險。**
- `series`（近 20 個交易日，由舊到新）：`date`、`open`、`high`、`low`、`close`（元）、`volume`（股）、`inst_net`（外資＋投信）、`foreign_net`、`trust_net`、`dealer_net`（**股**）、`margin_balance`（融資餘額，**張**）。

### features 單位對照（解讀時最容易出錯）

| 特徵 | 單位 | 意義 |
|---|---|---|
| `inst_net_20_pct`、`trust_net_20_pct`、`dealer_net_20_pct` | % 股本（0.8 = 0.8%） | 20 日外資＋投信／投信／自營商淨買超占發行股數 |
| `inst_buy_days_20` | 天 | 20 日中外資＋投信淨買超為正的天數 |
| `inst_net_5` | **股** | 近 5 日外資＋投信淨買超合計 |
| `foreign_ratio_chg_20` | 百分點 | 外資持股比率 20 日變化 |
| `ret_20`、`dist_ma60`、`range_20`、`margin_chg_20`、`holders_chg_4w_pct` | 小數（0.05 = 5%） | 20 日漲幅、季線乖離、20 日振幅、融資 20 日變化、股東人數 4 週變化 |
| `vol_ratio` | 倍 | 20 日均量 ÷ 60 日均量 |
| `avg_value_20` | 元 | 20 日平均成交金額 |
| `big400_pct`、`big1000_pct`、`retail_pct` | % | 400 張以上大戶、千張大戶、50 張以下散戶的持股比例 |
| `big400_up_weeks` | 週 | 大戶比例連續週增週數 |
| `big400_chg_4w`、`retail_chg_4w` | 百分點 | 4 週變化 |
| `holders` | 人 | 集保股東人數 |
| `series[].inst_net`、`foreign_net`、`trust_net`、`dealer_net` | **股**（不是張） | 每日法人淨買超 |
| `series[].volume`、`levels.volume`、`vol_ma5`、`vol_ma5_prev`、`vol_ma20` | **股** | 成交量 |
| `series[].margin_balance` | 張 | 融資餘額 |
| `inst_sell_days_20` | 天 | 20 日中外資＋投信淨賣超（< 0）的天數 |
| `big400_down_weeks` | 週 | 大戶比例連續週減週數 |
| `drawdown_60` | 小數（−0.08 = 距 60 日最高 −8%） | 收盤 ÷ 60 日最高價 − 1 |
| `below_ma20` | 布林 | 收盤低於 MA20 |
| `dump_days_20` | 天 | 20 日中帶量長黑天數（量 ≥ 前 5 日均量 × 1.5、收黑、跌 ≥ 3%） |
| `sbl_chg_20_pct` | % 股本（0.5 = 0.5%） | 借券賣出餘額 20 日增加量占發行股數 |
| `sbl_ratio` | % 股本 | 借券賣出餘額占發行股數 |
| `short_margin_ratio` | %（18.4 = 18.4%） | 券資比（融券 ÷ 融資）；融資 < 100 張時為 `null` |

`null` 代表資料不足（停牌、新上市、不能融資、集保週數不夠），**不可當成 0**。對應的 `signals` 會有 `missing:<特徵名>`。

## 4. `tw_dist` — 疑似出貨風險訊號清單

`GET /api/dist?stage=DISTRIBUTION,CAUTION&min_score=50&min_coverage=0.85&market=TPEX&limit=50`

| 參數 | 預設 | 說明 |
|---|---|---|
| `stage` | `DISTRIBUTION` | 逗號分隔：`DISTRIBUTION` 疑似出貨（≥ 70 分）、`CAUTION` 注意（55～69 分），兩者都要覆蓋率 ≥ 0.85；`PROVISIONAL` 暫定（分數 ≥ 55 但覆蓋率不足）；`COLLAPSED` 已大幅下跌（20 日跌 > 25% 或距 60 日高 > 30%） |
| `min_score` | 0 | 最低分數 |
| `min_coverage` | 0 | 最低覆蓋率（0～1），超出範圍回 400 |
| `market` | 全部 | `TWSE`、`TPEX`（掃描日當天所屬市場） |
| `limit` | 50 | 最多 200 |

回應：`{ scan_date, updated_at, run_id, quality, sbl_status, config_version, experimental, note, count, stocks: [...] }`。每檔有 `score`、`coverage`、`stage`、`breakdown`、`signals`、`features`、`close`、`lights`、`bear_lights`，依階段、分數排序。尚未產生時回 `503 { "error": "dist_not_ready" }`。

- **用語**：一律稱「疑似出貨風險訊號」。官方資料只能確認「法人淨賣出」「借券餘額增加」這類事實，不能證明是誰在賣、為什麼賣。
- **解讀期間（`experimental: true`，依 2026-04～10 回測）**：名單之後 **20 日**平均落後同期個股約 2%；**5 日幾乎沒有差異**；期間內最大上漲幅度和其他個股相同。只能當 20 日左右的風險提示，**不能當放空時點**。
- `coverage`：算得出來的配分 ÷ 100。缺資料的項目給 0 分，**0 分代表無法判斷，不代表沒有風險**。
- `sbl_status`：`{ "TWSE": "ok" | "pending", "TPEX": … }`。`pending` 代表當天借券還沒公布（18:00、20:00 那兩次一定是），該市場個股的 `signals` 帶 `sbl_pending`、信用與借券分數未計入。`quality` 為 `"sbl_pending"` 或 `"sbl_warming_up"` 時要提醒。
- `breakdown`：`inst` 法人調節（滿分 30）、`dispersion` 籌碼分散（25）、`price` 高檔轉弱（20）、`volume` 量能異常（10）、`credit` 信用與借券（15）。籌碼分散組因集保週數少，門檻尚未經回測驗證。
- `COLLAPSED` 是價格狀態：已大跌一段，不適用高檔派發判斷，**不代表風險解除**。`PROVISIONAL` 不可當成正式結果。
- `bear_lights`：四維偏空燈號，定義同 `tw_stock`，出貨頁顯示的是這組。轉弱燈多代表轉弱的地方多，和出貨訊號互相印證，但**不能證明是誰在賣**；`false` 只代表該項還沒轉弱。
- `lights`：四維偏多燈號，定義同 `tw_stock`。在出貨清單中，紅燈 ≥ 3 代表價量仍偏多，出貨訊號可能不準（頁面標「走勢仍強」），不可解讀成買進訊號。
- 兩組燈號都不影響出貨分數；舊版 `dist.json` 沒有這兩個欄位。

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
      "description": "查詢單一台股普通股的吸籌特徵、分數、各群組得分、出貨評分(distribution,null 代表沒有出貨資料)與近 20 日法人淨買(股)、收盤價、成交量。",
      "parameters": {
        "type": "object",
        "properties": { "code": { "type": "string", "pattern": "^[1-9]\\d{3}$", "description": "4 位數股票代號,例如 2330" } },
        "required": ["code"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "tw_dist",
      "description": "台股疑似出貨風險訊號清單(每日收盤後評分 0~100,實驗性)。DISTRIBUTION=疑似出貨、CAUTION=注意、PROVISIONAL=暫定(資料不足)、COLLAPSED=已大幅下跌。回傳分數、覆蓋率、各群組得分、訊號與特徵。僅為 20 日風險提示,非放空建議。",
      "parameters": {
        "type": "object",
        "properties": {
          "stage": { "type": "array", "items": { "type": "string", "enum": ["DISTRIBUTION", "CAUTION", "PROVISIONAL", "COLLAPSED"] }, "default": ["DISTRIBUTION"] },
          "min_score": { "type": "integer", "minimum": 0, "maximum": 100, "default": 0 },
          "min_coverage": { "type": "number", "minimum": 0, "maximum": 1, "default": 0 },
          "market": { "type": "string", "enum": ["TWSE", "TPEX"] },
          "limit": { "type": "integer", "minimum": 1, "maximum": 200, "default": 50 }
        }
      }
    }
  }
]
```

### 呼叫實作（參考）

把工具參數轉成查詢字串即可，陣列用逗號串接：

```js
const BASE = 'https://tw-stocks.happytoo.cc';
const headers = process.env.TW_API_TOKEN ? { Authorization: `Bearer ${process.env.TW_API_TOKEN}` } : {};

async function call(name, args) {
  const q = new URLSearchParams(
    Object.entries(args).filter(([, v]) => v != null).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
  );
  // 每個工具明確對應路徑;未知工具直接報錯,不要預設走某個端點(否則新工具忘了加會默默拿到別的資料)
  const PATHS = { tw_stock: () => `/api/stock/${args.code}`, tw_cobuy: () => `/api/cobuy?${q}`, tw_scan: () => `/api/scan?${q}`, tw_dist: () => `/api/dist?${q}` };
  if (!PATHS[name]) throw new Error(`unknown tool: ${name}`);
  const path = PATHS[name]();
  const r = await fetch(BASE + path, { headers });
  return r.json(); // 錯誤也是 JSON:{ error, ... },直接交給模型
}
```

## 系統提示（建議）

```
你可以使用 tw_cobuy、tw_scan、tw_stock、tw_dist 四個工具查詢台股籌碼資料。

- 回答前先說明資料日期:tw_cobuy 看 trading_days 最後一天,tw_scan/tw_stock 看 scan_date。
- 注意單位:tw_cobuy 是「張」;tw_stock 的 series.inst_net 是「股」;features 單位依工具說明,比例類多為小數(0.05 = 5%)。
- 欄位為 null 代表資料不足,要說「資料不足」,不可當成 0 推論。
- quality 為 tdcc_warming_up 時,提醒籌碼集中分數僅供參考。
- 引用具體數字說明哪些訊號成立、哪些缺漏;同一檔若同時出現在法人同步買超與吸籌清單,可特別指出。
- 出貨資料(tw_dist、tw_stock 的 distribution)一律稱「疑似出貨風險訊號」,不說「主力正在出貨」。只能當 20 日左右的風險提示,5 日沒有分辨力,不提供放空進場價或放空時點。
- distribution 為 null 要說「沒有出貨資料」,不可說「沒有出貨風險」。coverage < 0.85、PROVISIONAL、帶 sbl_pending 時要說明哪些資料還沒計入。COLLAPSED 要說「已大幅下跌,不適用高檔派發判斷」。
- 同一檔同時在吸籌清單與出貨清單時要特別指出,不要自行判斷哪一邊對。
- 只做資料整理與分析,不給買賣建議;結尾註明「僅供研究參考,非投資建議」,提到出貨資料時加「亦非放空建議」。
```

## 提問範例

- 「找出最近 10 天外資和投信都買超、且連續買超至少 3 天的上櫃股，依外資累計排序列前 10 檔。」
  → `tw_cobuy({ insts: ["foreign","trust"], streak: 3, market: "TPEX", limit: 10 })`
- 「今天吸籌分數最高的 10 檔是哪些？每檔是哪些群組拿分？」
  → `tw_scan({ limit: 10 })`
- 「法人同步買超和吸籌清單有哪些重疊？逐檔分析。」
  → `tw_cobuy({})` ＋ `tw_scan({ stage: ["ACCUMULATION","WATCH"], limit: 200 })` 取交集，再對每檔 `tw_stock`
- 要產出完整的分析報告時，建議改用 Hermes skill `specs/台股籌碼資料_Skill_v1.3.md` 抓資料，再交給 `stock-4d-3d-trade-report`（規格見 `specs/stock-4d-3d-trade-report_v4.md`）產生報告。
- 「今天疑似出貨風險分數最高的上櫃股？借券資料算進去了嗎？」
  → `tw_dist({ stage: ["DISTRIBUTION","CAUTION"], market: "TPEX", limit: 10 })`，並看回應的 `sbl_status`
- 「我的持股 2330 有沒有出貨風險訊號？」
  → `tw_stock({ code: "2330" })`，看 `distribution`
- 要產出出貨風險的完整報告時，用 `台股籌碼資料` skill 的任務 C 產生資料包，再交給 `stock-dist-risk-report`（規格見 `specs/stock-dist-risk-report_v1.md`）。
- 「3481 最近籌碼怎麼樣？」
  → `tw_stock({ code: "3481" })`

## 免責

本系統只是籌碼與價量的統計篩選工具，不構成投資建議；疑似出貨風險訊號亦非放空建議。吸籌分數權重為 v1 主觀設定，尚未經回測驗證；出貨評分 `d-v1.0` 為實驗性，回測樣本短（見 [distribution-calibration.md](distribution-calibration.md)）。
