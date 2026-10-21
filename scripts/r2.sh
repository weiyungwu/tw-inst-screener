#!/usr/bin/env bash
# R2 上傳/下載加重試(GitHub Actions 用)。用法同 wrangler:scripts/r2.sh put <bucket/key> --file <path> [其他參數]
# R2 偶爾回暫時性錯誤(例如 2026-10-20 20:00 上傳 features/90.json 回 503),整次執行因此失敗。
# 失敗時等 5、15 秒各重試一次;三次都失敗才回傳錯誤,讓 workflow 照原本的規則處理。
set -u
for wait in 5 15 0; do
  npx -y wrangler@4 r2 object "$@" --remote && exit 0
  status=$?
  [ "$wait" -eq 0 ] && break
  echo "::warning::R2 $1 $2 失敗(exit $status),${wait} 秒後重試"
  sleep "$wait"
done
echo "::error::R2 $1 $2 重試 3 次仍失敗"
exit "$status"
