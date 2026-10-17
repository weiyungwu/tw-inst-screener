// 上市借券賣出餘額(TWSE TWT93U,信用額度總量管制餘額表)。融券與借券欄名重複,依位置解析、用欄名驗證。
import { fetchJson } from '../http.mjs';
import { ymd } from '../dates.mjs';
import { checkFields, checkDate, parseSblRows } from '../parse.mjs';

// 8 前日餘額 9 當日賣出 10 當日還券 11 當日調整 12 當日餘額(借券賣出,單位股)
const FIELDS = { 0: '代號', 8: '前日餘額', 9: '當日賣出', 10: '當日還券', 11: '當日調整', 12: '當日餘額' };

// 回應 → Map<code, {sbl_balance, sbl_sell, sbl_return}>(股);休市或尚未公布(data 為空)回傳 null
// minRows:普通股最少列數(呼叫端以 sblMinRows():該市場有行情的檔數 × 0.8)
export function parseTwseSbl(j, expectDate, minRows) {
  if (!j || j.stat !== 'OK') return null;
  if (expectDate) checkDate('twse-sbl', j.date, expectDate);
  if (!Array.isArray(j.data) || j.data.length === 0) return null;
  if (!String(j.title ?? '').includes('信用額度總量管制餘額表')) throw new Error(`twse-sbl 主表標題為「${j.title}」。端點可能改版。`);
  checkFields('twse-sbl', j.fields, FIELDS);
  return parseSblRows('twse-sbl', j.data, minRows);
}

export async function fetchTwseSbl(date, minRows) {
  const url = `https://www.twse.com.tw/exchangeReport/TWT93U?response=json&date=${ymd(date)}`;
  return parseTwseSbl(await fetchJson(url), ymd(date), minRows);
}
