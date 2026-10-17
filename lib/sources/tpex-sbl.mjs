// 上櫃借券賣出餘額(TPEX margin/sbl,信用額度總量管制餘額表)。欄位位置與上市相同,欄名略有不同。
import { fetchJson } from '../http.mjs';
import { ymd, slash } from '../dates.mjs';
import { checkFields, checkDate, parseSblRows } from '../parse.mjs';

const FIELDS = { 0: '股票代號', 8: '前日餘額', 9: '當日賣出', 10: '當日還券', 11: '當日調整數額', 12: '當日餘額' };

// 回應 → Map<code, {sbl_balance, sbl_sell, sbl_return}>(股);休市或尚未公布(totalCount 0、data 為空)回傳 null
export function parseTpexSbl(j, expectDate, minRows) {
  const table = j && Array.isArray(j.tables) ? j.tables[0] : null;
  if (!table || !Array.isArray(table.data) || table.data.length === 0) return null;
  if (expectDate) checkDate('tpex-sbl', j.date, expectDate);
  if (!String(table.title ?? '').includes('信用額度總量管制餘額表')) throw new Error(`tpex-sbl 主表標題為「${table.title}」。端點可能改版。`);
  checkFields('tpex-sbl', table.fields, FIELDS);
  return parseSblRows('tpex-sbl', table.data, minRows);
}

export async function fetchTpexSbl(date, minRows) {
  const url = `https://www.tpex.org.tw/www/zh-tw/margin/sbl?date=${slash(date)}&response=json`;
  return parseTpexSbl(await fetchJson(url), ymd(date), minRows);
}
