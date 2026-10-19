'use strict';

// 深色/淺色切換:記住使用者的選擇,沒選過就跟系統設定。
// 在 <head> 同步載入,畫面出來前就決定主題,避免淺色使用者先看到一閃深色
(() => {
  const KEY = 'theme';
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* 無痕模式等情況讀不到,就跟系統 */ }
  root.dataset.theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.onclick = () => {
      const next = root.dataset.theme === 'light' ? 'dark' : 'light';
      root.dataset.theme = next;
      try { localStorage.setItem(KEY, next); } catch { /* 存不了只影響下次開啟 */ }
    };
  });
})();
