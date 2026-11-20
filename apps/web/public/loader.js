// [•] loader, before React. A same-origin file rather than an inline
// <script>, so it runs under the 1.3.1 CSP (script-src 'self', no
// unsafe-eval) whether or not Tauri's hashes switch off 'unsafe-inline'.
// Classic and synchronous: it runs before the deferred module script.
// Before React: the loader's theme. Dark unless a saved app theme is
// readable now; all four app themes are light.
(function () {
  var el = document.getElementById('li-loader');
  try {
    var t = localStorage.getItem('lockin.theme');
    if (t === 'operator' || t === 'notebook' || t === 'bento' || t === 'botanical') {
      el.classList.replace('li-dark', 'li-light');
    }
  } catch (e) { /* storage blocked: stay dark */ }
})();
// main.tsx calls this once the snapshot boot is done. Any boot error
// calls it too (the listeners below), so the loader can never hang.
window.lockInLoaderFinish = function () {
  var el = document.getElementById('li-loader');
  if (!el || el.classList.contains('li-done')) return;
  el.classList.add('li-done');
  el.addEventListener('animationend', function (e) {
    if (e.animationName === 'li-fade') el.remove();
  });
};
window.addEventListener('error', window.lockInLoaderFinish, true);
window.addEventListener('unhandledrejection', window.lockInLoaderFinish);
