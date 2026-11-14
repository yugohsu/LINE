// 多久下雨（自動從 GitHub 抓最新版，網路慢就用手機裡存的版本）
const CODE_URL = 'https://yugohsu.github.io/LINE/rain_widget.js';
const fm = FileManager.local();
const path = fm.joinPath(fm.documentsDirectory(), 'rain_widget_cache.js');
let code = '';
try {
  const req = new Request(CODE_URL + '?t=' + Date.now());
  req.headers = { 'Cache-Control': 'no-cache' };
  req.timeoutInterval = 5;   // 最多等 5 秒
  code = await req.loadString();
  if (code.indexOf('Script.complete') < 0) throw new Error('下載內容不對');
  fm.writeString(path, code);
} catch (e) {
  code = fm.fileExists(path) ? fm.readString(path) : '';
}
if (!code) throw new Error('下載不到小工具程式，請檢查網路');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
await new AsyncFunction(code)();
