// 各來源共用的解析小工具

// 只保留普通個股:4 位數字、首位非 0(排除 ETF/債/權證等 0050、00679B、6 位權證)
export const isCommonStock = (code) => /^[1-9]\d{3}$/.test(code);

// 字串轉整數:去除千分位逗號/空白,'--'、''、null 視為 0
// (inst 來源沿用的既有行為;價量等來源缺值必須是 null,不可沿用此函式)
export function toInt(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[,\s]/g, '');
  if (s === '' || s === '--' || s === '---') return 0;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

// 字串轉數字,缺值回傳 null(價量/融資/外資持股用;不可把缺值變 0)
// 去除千分位逗號、空白、%;'--'、'---'、'----'、'' 視為缺值;其他無法解析的字串直接報錯(端點改版要大聲失敗)
export function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,\s%]/g, '');
  if (s === '' || /^-{2,}$/.test(s)) return null;
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error(`無法解析的數字「${v}」`);
  return n;
}

// 依位置確認欄位名稱(去除 <br> 與空白後比對),不符就報錯,避免欄位位移後默默存錯
export function checkFields(source, fields, expected) {
  const norm = (s) => String(s ?? '').replace(/<br\s*\/?>/gi, '').replace(/\s/g, '');
  for (const [i, name] of Object.entries(expected)) {
    if (norm(fields?.[i]) !== norm(name)) {
      throw new Error(`${source} 欄位 ${i} 應為「${name}」,實際為「${fields?.[i]}」。端點可能改版。`);
    }
  }
}

// 回應的資料日期必須是要求的日期(防止官方把別天的資料回傳)
export function checkDate(source, actual, expected) {
  if (String(actual) !== expected) throw new Error(`${source} 回應日期 ${actual} 與要求日期 ${expected} 不符`);
}

// 借券賣出(twse-sbl/tpex-sbl 共用):逐列驗證後回傳普通股 Map<code, {sbl_balance, sbl_sell, sbl_return}>(股)
// 任一項不成立就報錯、整個市場不回傳資料(出貨規格 §5):
//   每一列(含 ETF)借券勾稽 前日 8 + 賣出 9 − 還券 10 + 調整 11 = 當日 12;餘額 ≥ 0;代號不重複;
//   普通股列數 ≥ minRows(該市場 stocks 檔數 × 80%,擋下 HTTP 200 但只有部分資料的回應)
export function parseSblRows(source, rows, minRows) {
  if (!Number.isFinite(minRows)) throw new Error(`${source} 缺少 minRows,無法檢查列數`);
  const seen = new Set();
  const map = new Map();
  for (const row of rows) {
    const code = String(row[0]).trim();
    if (seen.has(code)) throw new Error(`${source} 代號 ${code} 重複出現`);
    seen.add(code);
    const [prev, sell, ret, adj, bal] = [8, 9, 10, 11, 12].map((i) => toNum(row[i]));
    // 缺值(null)會被 + 當成 0,先擋下,勾稽才有意義
    if (![prev, sell, ret, adj, bal].every(Number.isInteger)) throw new Error(`${source} ${code} 借券欄位不是整數:${JSON.stringify(row.slice(8, 13))}`);
    if (prev < 0 || bal < 0) throw new Error(`${source} ${code} 借券餘額為負`);
    if (prev + sell - ret + adj !== bal) throw new Error(`${source} ${code} 借券勾稽不符(${prev} + ${sell} − ${ret} + ${adj} ≠ ${bal}),欄位可能錯位。端點可能改版。`);
    if (isCommonStock(code)) map.set(code, { sbl_balance: bal, sbl_sell: sell, sbl_return: ret });
  }
  if (map.size < minRows) throw new Error(`${source} 普通股只有 ${map.size} 列,少於 ${Math.ceil(minRows)},回應可能不完整`);
  return map;
}
