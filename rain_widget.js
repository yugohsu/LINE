// ☔ 多久會下雨 — iPhone 主畫面小工具 (Scriptable)
// 小 (正方形)：多久下雨 + 未來 24 小時降雨長條
// 中 (長方形)：同樣內容，長條比較大
// 點小工具會打開下雨通知網頁
//
// 📌 指定地點：長按小工具 →「編輯小工具」→ Parameter 輸入地名 (例如：小樽、新竹、北海道神宮)
//    Parameter 空白 = 用手機現在的位置

// ===== 可以自己改的地方 =====
const APP_URL = 'https://yugohsu.github.io/LINE/';   // 點小工具要打開的網址
const RAIN_MIN = 0.1;                                 // 15 分鐘累積 0.1mm 以上算「有下雨」
const HOUR_RAIN = 0.3;                                // 1 小時累積 0.3mm 以上，長條畫成深藍色
const REFRESH_MIN = 10;                               // 希望幾分鐘更新一次 (iPhone 會自己決定，通常 10~30 分)
const TEST_PLACE = '';                                // 在 Scriptable 裡按執行時要測試的地點 (空白 = 現在位置)
// 下雨通知 Apps Script 網址 (用來把中文地名換成經緯度)
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwGL9LSy0zDw0fS83oVSOL-RSoce7PQUjJQgvs216_TqxmF3VEbNTH7yOlSiEV9mc6dWg/exec';

// ===== 顏色 (土金色系，和下雨通知一樣) =====
const C = {
  bg: new Color('#f2eee6'),
  rainBg: new Color('#e3edf8'),
  ink: new Color('#2a2117'),
  muted: new Color('#7d7263'),
  gold: new Color('#9a7432'),
  rain: new Color('#3a78c2'),
  rainLight: new Color('#a9c6e8'),
  track: new Color('#e6dfd2'),
  red: new Color('#c24a36')
};

// ---------- 取得位置 (拿不到就用上次的位置) ----------
async function getLocation() {
  try {
    Location.setAccuracyToHundredMeters();
    const loc = await Location.current();
    Keychain.set('rain_widget_loc', JSON.stringify({ latitude: loc.latitude, longitude: loc.longitude }));
    return loc;
  } catch (e) {
    if (Keychain.contains('rain_widget_loc')) return JSON.parse(Keychain.get('rain_widget_loc'));
    return null;
  }
}

async function getPlaceName(lat, lon) {
  try {
    const r = await Location.reverseGeocode(lat, lon, 'zh_TW');
    const p = r && r[0];
    if (!p) return '';
    return p.subLocality || p.locality || p.administrativeArea || '';
  } catch (e) {
    return '';
  }
}

// ---------- 指定地點：地名 → 經緯度 (查過一次就記住) ----------
async function findPlace(name) {
  // 也可以直接輸入「緯度,經度」，例如 43.19,141.00
  const m = name.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { latitude: +m[1], longitude: +m[2] };

  const key = 'rain_widget_geo_' + name;
  if (Keychain.contains(key)) return JSON.parse(Keychain.get(key));

  let found = null;
  // 1. 用下雨通知的搜尋 (Google 地圖，中文地名最準)
  try {
    const r = await new Request(GAS_URL + '?geo=' + encodeURIComponent(name)).loadJSON();
    if (r && r.ok) found = { latitude: r.lat, longitude: r.lon };
  } catch (e) {}
  // 2. 備用：Open-Meteo 地名搜尋
  if (!found) {
    try {
      const r = await new Request('https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&name=' + encodeURIComponent(name)).loadJSON();
      const g = r && r.results && r.results[0];
      if (g) found = { latitude: g.latitude, longitude: g.longitude };
    } catch (e) {}
  }
  if (!found) throw new Error('找不到「' + name + '」\n請換個寫法，例如加上城市名');
  Keychain.set(key, JSON.stringify(found));
  return found;
}

// ---------- 抓天氣 ----------
async function getWeather(lat, lon) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
    '&minutely_15=precipitation,snowfall' +
    '&hourly=precipitation,precipitation_probability,snowfall' +
    '&forecast_minutely_15=32&forecast_hours=26&past_minutely_15=1&timezone=auto';
  const d = await new Request(url).loadJSON();
  if (d.error) throw new Error(d.reason || '天氣資料錯誤');
  const off = d.utc_offset_seconds || 0;
  const ms = s => {
    const p = s.split(/[-T:]/);
    return Date.UTC(+p[0], +p[1] - 1, +p[2], +p[3], +p[4]) - off * 1000;
  };
  return {
    m: d.minutely_15.time.map((t, i) => ({
      end: ms(t), mm: d.minutely_15.precipitation[i] || 0, snow: d.minutely_15.snowfall[i] || 0
    })),
    h: d.hourly.time.map((t, i) => ({
      end: ms(t), mm: d.hourly.precipitation[i] || 0, snow: d.hourly.snowfall[i] || 0,
      prob: d.hourly.precipitation_probability[i] || 0
    }))
  };
}

// ---------- 判斷：多久會下雨 ----------
const pad = n => String(n).padStart(2, '0');
const hm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const hh = t => pad(new Date(t).getHours()) + '時';
const level = (mm, snow) => snow > 0 ? '下雪' : mm < RAIN_MIN ? '沒雨' : mm < 0.5 ? '小雨' : mm < 2 ? '中雨' : '大雨';
const minText = min => min >= 60 ? (Math.round(min / 30) / 2).toString() + '小時' : Math.round(min) + '分';

function analyze(w) {
  const now = Date.now();
  const slots = w.m.map(s => ({ start: s.end - 15 * 60000, end: s.end, mm: s.mm, snow: s.snow }))
    .filter(s => s.end > now);
  const wet = s => s.mm >= RAIN_MIN || s.snow > 0;

  // 未來 24 小時 (每小時一格；包含「現在這一小時」)
  const day = w.h.filter(x => x.end > now).slice(0, 24).map(x => ({ start: x.end - 3600000, mm: x.mm, snow: x.snow, prob: x.prob }));
  const total = day.reduce((a, x) => a + x.mm, 0);
  const maxProb = day.reduce((a, x) => Math.max(a, x.prob), 0);
  const info = '最高 ' + maxProb + '%・共 ' + (total < 0.1 ? '0' : total.toFixed(1)) + 'mm';

  const base = { day, info, total, maxProb };
  const cur = slots[0];
  const rank = { '沒雨': 0, '小雨': 1, '中雨': 2, '大雨': 3, '下雪': 4 };
  // 從第 i 格開始連續下雨的那一段：最大雨勢 + 停的時間
  const block = i => {
    let word = '沒雨', end = null;
    for (let j = i; j < slots.length; j++) {
      if (!wet(slots[j])) { end = slots[j].start; break; }
      const w2 = level(slots[j].mm, slots[j].snow);
      if (rank[w2] > rank[word]) word = w2;
    }
    return { word, end };
  };

  // 正在下
  if (cur && wet(cur)) {
    const b = block(0);
    return Object.assign(base, {
      mode: 'raining', icon: cur.snow > 0 ? '❄️' : '🌧️',
      big: '正在' + level(cur.mm, cur.snow),
      small: b.end ? '下到 ' + hm(b.end) : '會一直下 ☔'
    });
  }

  // 8 小時內會下 (每 15 分鐘的預報)
  const fi = slots.findIndex(wet);
  if (fi >= 0) {
    const first = slots[fi];
    const b = block(fi);
    const min = Math.max(0, (first.start - now) / 60000);
    return Object.assign(base, {
      mode: 'soon', icon: first.snow > 0 ? '❄️' : '🌦️',
      big: min < 10 ? '快' + b.word + '了' : minText(min) + '後 ' + b.word,
      small: hm(first.start) + '～' + (b.end ? hm(b.end) : '很久')
    });
  }

  // 24 小時內可能下 (逐時預報)
  const hot = x => x.mm >= HOUR_RAIN || x.snow > 0 || x.prob >= 60;
  const li = day.findIndex(hot);
  if (li >= 0) {
    const later = day[li];
    let lj = li;
    while (lj + 1 < day.length && hot(day[lj + 1])) lj++;
    const endT = day[lj].start + 3600000;
    return Object.assign(base, {
      mode: 'dry', icon: '⛅',
      big: minText(Math.max(60, (later.start - now) / 60000)) + '後 ' + (day.slice(li, lj + 1).some(x => x.snow > 0) ? '下雪' : '下雨'),
      small: hm(later.start) + '～' + hm(endT) + '（機率 ' + Math.max(...day.slice(li, lj + 1).map(x => x.prob)) + '%）'
    });
  }
  return Object.assign(base, { mode: 'dry', icon: '☀️', big: '不會下雨', small: '未來 24 小時' });
}

// ---------- 畫 24 小時降雨長條 ----------
// 長條高度 = 降雨機率；深藍 = 真的會下 (雨量明顯)，淺藍 = 只是有機率
function drawDay(day, width, height) {
  const dc = new DrawContext();
  dc.size = new Size(width, height);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const n = 24, gap = 1.5;
  const bw = (width - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const x = i * (bw + gap);
    const track = new Path();
    track.addRoundedRect(new Rect(x, 0, bw, height), 2, 2);
    dc.addPath(track); dc.setFillColor(C.track); dc.fillPath();
    const d = day[i];
    if (!d) continue;
    const real = d.mm >= HOUR_RAIN || d.snow > 0;
    const p = Math.max(real ? 35 : 0, d.prob);
    if (p < 5) continue;
    const h = Math.max(3, height * p / 100);
    const bar = new Path();
    bar.addRoundedRect(new Rect(x, height - h, bw, h), 2, 2);
    dc.addPath(bar); dc.setFillColor(real ? C.rain : C.rainLight); dc.fillPath();
  }
  return dc.getImage();
}

// ---------- 小工具畫面 ----------
function addText(stack, text, size, color, weight) {
  const t = stack.addText(text);
  t.font = weight === 'heavy' ? Font.heavySystemFont(size) : Font.boldSystemFont(size);
  t.textColor = color;
  t.minimumScaleFactor = 0.5;
  t.lineLimit = 1;
  return t;
}

// 長條下面的時間 (現在 / 12 小時後 / 24 小時後)
function timeLabels(stack, day, width, size) {
  const row = stack.addStack();
  row.size = new Size(width, 0);
  const t0 = day[0] ? day[0].start : Date.now();
  addText(row, '現在', size, C.muted, 'bold');
  row.addSpacer();
  addText(row, hh(t0 + 12 * 3600000), size, C.muted, 'bold');
  row.addSpacer();
  addText(row, hh(t0 + 24 * 3600000), size, C.muted, 'bold');
}

function headline(stack, r, bigSize, smallSize) {
  const top = stack.addStack();
  top.centerAlignContent();
  addText(top, r.icon, bigSize * 0.75, C.ink, 'bold');
  top.addSpacer(4);
  addText(top, r.big, bigSize, r.mode === 'dry' ? C.gold : C.rain, 'heavy');
  stack.addSpacer(1);
  addText(stack, r.small, smallSize, C.ink, 'bold');
}

function buildWidget(r, place) {
  const w = new ListWidget();
  w.backgroundColor = r.mode === 'raining' ? C.rainBg : C.bg;
  w.url = APP_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60000);
  const family = config.widgetFamily || 'small';

  if (family === 'small') {
    // ===== 正方形 =====
    // 第 1 行：🌦️ 44分後 大雨
    // 第 2 行：17:15～18:15
    // 第 3 行：24 小時降雨長條 + 時間
    // 第 4 行：📌 地點
    w.setPadding(12, 12, 10, 12);
    headline(w, r, 24, 20);
    w.addSpacer();
    const img = w.addImage(drawDay(r.day, 130, 40));
    img.imageSize = new Size(130, 40);
    w.addSpacer(2);
    timeLabels(w, r.day, 130, 10);
    w.addSpacer(4);
    addText(w, place, 13, C.muted, 'bold');
    return w;
  }

  // ===== 中 / 大：左邊文字，右邊 24 小時長條 =====
  w.setPadding(14, 14, 12, 14);
  const row = w.addStack();
  const left = row.addStack();
  left.layoutVertically();
  headline(left, r, 28, 22);
  row.addSpacer(12);

  const right = row.addStack();
  right.layoutVertically();
  right.addSpacer(4);
  const img = right.addImage(drawDay(r.day, 150, 70));
  img.imageSize = new Size(150, 70);
  right.addSpacer(3);
  timeLabels(right, r.day, 150, 11);

  w.addSpacer();
  addText(w, place, 14, C.muted, 'bold');
  return w;
}

function errorWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = APP_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60000);
  addText(w, '☔ 多久會下雨', 15, C.muted, 'bold');
  w.addSpacer(6);
  const t = w.addText(msg);
  t.font = Font.boldSystemFont(14);
  t.textColor = C.red;
  return w;
}

// ---------- 執行 ----------
let widget;
try {
  const param = String((config.runsInWidget ? args.widgetParameter : TEST_PLACE) || '').trim();
  let loc, place;
  if (param) {
    // 📌 指定地點
    loc = await findPlace(param);
    place = '📌' + param;
  } else {
    // 📍 現在位置
    loc = await getLocation();
    if (loc) place = '📍' + ((await getPlaceName(loc.latitude, loc.longitude)) || '目前位置');
  }
  if (!loc) {
    widget = errorWidget('拿不到位置\n請打開 Scriptable 執行一次，並允許定位');
  } else {
    widget = buildWidget(analyze(await getWeather(loc.latitude, loc.longitude)), place);
  }
} catch (e) {
  widget = errorWidget(e.message.indexOf('找不到') === 0 ? e.message : '更新失敗，稍後會再試\n' + e.message);
}

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentSmall();
}
Script.complete();
