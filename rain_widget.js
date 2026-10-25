// ☔ 多久會下雨 — iPhone 主畫面小工具 (Scriptable)
// 小 (正方形)：多久下雨 + 未來 24 小時降雨長條
// 中 (長方形)：同樣內容，長條比較大
//
// 🔍 換地點：點一下小工具 → 選「搜尋地點」→ 輸入地名 → 選結果
//    選「改回現在位置」就恢復用手機定位
// 📌 也可以長按小工具 →「編輯小工具」→ Parameter 輸入地名，那個小工具就固定看那裡 (優先)

// ===== 可以自己改的地方 =====
const APP_URL = 'https://yugohsu.github.io/LINE/';   // 選單裡「打開下雨通知」的網址
const RAIN_MIN = 0.1;                                 // 15 分鐘累積 0.1mm 以上算「有下雨」
const HOUR_RAIN = 0.3;                                // 1 小時累積 0.3mm 以上，長條畫成深藍色
const REFRESH_MIN = 10;                               // 希望幾分鐘更新一次 (iPhone 會自己決定，通常 10~30 分)
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
  snow: new Color('#7b6fbf'),        // 下雪：薰衣草紫
  snowBg: new Color('#efedf8'),
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

// ---------- 搜尋地點 (回傳多個結果讓你選) ----------
async function searchList(q) {
  try {
    const r = await new Request(GAS_URL + '?geo=' + encodeURIComponent(q)).loadJSON();
    if (r && r.ok) return r.list && r.list.length ? r.list : [{ name: r.name, label: r.name, lat: r.lat, lon: r.lon }];
  } catch (e) {}
  try {
    const r = await new Request('https://geocoding-api.open-meteo.com/v1/search?count=6&language=zh&name=' + encodeURIComponent(q)).loadJSON();
    return (r.results || []).map(g => ({
      name: g.name, label: [g.name, g.admin1, g.country].filter(Boolean).join(', '), lat: g.latitude, lon: g.longitude
    }));
  } catch (e) {}
  return [];
}

// ---------- 存「小工具要看的地點」----------
const PICK_KEY = 'rain_widget_pick';
function getPick() {
  try { return Keychain.contains(PICK_KEY) ? JSON.parse(Keychain.get(PICK_KEY)) : null; } catch (e) { return null; }
}

// ---------- 在 Scriptable 裡打開時的選單 ----------
async function menu() {
  const pick = getPick();
  const a = new Alert();
  a.title = '☔ 多久下雨';
  a.message = '小工具現在看的是：' + (pick ? '📌 ' + pick.name : '📍 現在位置');
  a.addAction('🔍 搜尋地點');
  a.addAction('📍 改回現在位置');
  a.addAction('☔ 打開下雨通知');
  a.addCancelAction('只看預覽');
  const i = await a.presentSheet();

  if (i === 0) {
    const ask = new Alert();
    ask.title = '🔍 搜尋地點';
    ask.message = '輸入地名、景點或城市';
    ask.addTextField('例如：小樽、新竹、北海道神宮', '');
    ask.addAction('搜尋');
    ask.addCancelAction('取消');
    if (await ask.presentAlert() === -1) return;
    const q = ask.textFieldValue(0).trim();
    if (!q) return;

    const list = await searchList(q);
    if (!list.length) {
      const no = new Alert();
      no.title = '找不到「' + q + '」';
      no.message = '換個寫法試試，例如加上城市名';
      no.addAction('好');
      await no.presentAlert();
      return;
    }
    let chosen = list[0];
    if (list.length > 1) {
      const sel = new Alert();
      sel.title = '要看哪一個？';
      list.forEach(r => sel.addAction('📍 ' + r.label));
      sel.addCancelAction('取消');
      const k = await sel.presentSheet();
      if (k === -1) return;
      chosen = list[k];
    }
    Keychain.set(PICK_KEY, JSON.stringify({ name: chosen.name, lat: chosen.lat, lon: chosen.lon }));
  } else if (i === 1) {
    if (Keychain.contains(PICK_KEY)) Keychain.remove(PICK_KEY);
  } else if (i === 2) {
    Safari.open(APP_URL);
    return 'open';
  }
}

// ---------- 抓天氣 ----------
async function getWeather(lat, lon) {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
    '&minutely_15=precipitation,rain,snowfall' +
    '&hourly=precipitation,precipitation_probability,rain,snowfall' +
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
      end: ms(t), mm: d.minutely_15.precipitation[i] || 0, snow: d.minutely_15.snowfall[i] || 0,
      rain: (d.minutely_15.rain || [])[i] || 0
    })),
    h: d.hourly.time.map((t, i) => ({
      end: ms(t), mm: d.hourly.precipitation[i] || 0, snow: d.hourly.snowfall[i] || 0,
      rain: (d.hourly.rain || [])[i] || 0,
      prob: d.hourly.precipitation_probability[i] || 0
    }))
  };
}

// ---------- 判斷：多久會下雨 ----------
const pad = n => String(n).padStart(2, '0');
const hm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const hh = t => pad(new Date(t).getHours()) + '時';
// 15 分鐘的雨量 (mm) / 積雪 (cm) → 白話
const level = (mm, snow, rain) => {
  if (snow > 0) {
    if ((rain || 0) >= RAIN_MIN) return '雨夾雪';
    return snow < 0.1 ? '小雪' : snow < 0.5 ? '中雪' : '大雪';
  }
  return mm < RAIN_MIN ? '沒雨' : mm < 0.5 ? '小雨' : mm < 2 ? '中雨' : '大雨';
};
const isSnow = word => word.indexOf('雪') >= 0;
const iconOf = word => word === '雨夾雪' ? '🌨️' : isSnow(word) ? '❄️' : null;
const minText = min => min >= 60 ? (Math.round(min / 30) / 2).toString() + '小時' : Math.round(min) + '分';

function analyze(w) {
  const now = Date.now();
  const slots = w.m.map(s => ({ start: s.end - 15 * 60000, end: s.end, mm: s.mm, snow: s.snow, rain: s.rain }))
    .filter(s => s.end > now);
  const wet = s => s.mm >= RAIN_MIN || s.snow > 0;

  // 未來 24 小時 (每小時一格；包含「現在這一小時」)
  const day = w.h.filter(x => x.end > now).slice(0, 24).map(x => ({ start: x.end - 3600000, mm: x.mm, snow: x.snow, rain: x.rain, prob: x.prob }));
  const total = day.reduce((a, x) => a + x.mm, 0);
  const maxProb = day.reduce((a, x) => Math.max(a, x.prob), 0);
  const info = '最高 ' + maxProb + '%・共 ' + (total < 0.1 ? '0' : total.toFixed(1)) + 'mm';

  const base = { day, info, total, maxProb };
  const cur = slots[0];
  const rank = { '沒雨': 0, '小雨': 1, '中雨': 2, '大雨': 3, '雨夾雪': 4, '小雪': 5, '中雪': 6, '大雪': 7 };
  // 從第 i 格開始連續下雨的那一段：最大雨勢 + 停的時間
  const block = i => {
    let word = '沒雨', end = null;
    for (let j = i; j < slots.length; j++) {
      if (!wet(slots[j])) { end = slots[j].start; break; }
      const w2 = level(slots[j].mm, slots[j].snow, slots[j].rain);
      if (rank[w2] > rank[word]) word = w2;
    }
    return { word, end };
  };

  // 正在下
  if (cur && wet(cur)) {
    const b = block(0);
    const word = level(cur.mm, cur.snow, cur.rain);
    return Object.assign(base, {
      mode: 'raining', snow: isSnow(word), icon: iconOf(word) || '🌧️',
      big: '正在' + word,
      small: b.end ? '下到 ' + hm(b.end) : (isSnow(word) ? '會一直下 ❄️' : '會一直下 ☔')
    });
  }

  // 8 小時內會下 (每 15 分鐘的預報)
  const fi = slots.findIndex(wet);
  if (fi >= 0) {
    const first = slots[fi];
    const b = block(fi);
    const min = Math.max(0, (first.start - now) / 60000);
    return Object.assign(base, {
      mode: 'soon', snow: isSnow(b.word), icon: iconOf(b.word) || '🌦️',
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
    const seg = day.slice(li, lj + 1);
    const snowy = seg.some(x => x.snow > 0);
    const word = snowy ? (seg.some(x => x.rain >= HOUR_RAIN) ? '雨夾雪' : '下雪') : '下雨';
    return Object.assign(base, {
      mode: 'dry', snow: snowy, icon: snowy ? (iconOf(word) || '❄️') : '⛅',
      big: minText(Math.max(60, (later.start - now) / 60000)) + '後 ' + word,
      small: hm(later.start) + '～' + hm(endT) + '（機率 ' + Math.max(...day.slice(li, lj + 1).map(x => x.prob)) + '%）'
    });
  }
  return Object.assign(base, { mode: 'dry', icon: '☀️', big: '不會下雨', small: '未來 24 小時' });
}

// ---------- 畫 24 小時降雨長條 ----------
// 長條高度 = 降雨機率；深藍 = 真的會下雨，紫色 = 會下雪，淺藍 = 只是有機率
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
    dc.addPath(bar); dc.setFillColor(d.snow > 0 ? C.snow : real ? C.rain : C.rainLight); dc.fillPath();
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

// 置中的一行字 (左右各放一個彈性空白)
function centerText(stack, text, size) {
  const row = stack.addStack();
  row.addSpacer();
  addText(row, text, size, C.muted, 'bold');
  row.addSpacer();
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
  addText(top, r.big, bigSize, r.snow ? C.snow : r.mode === 'dry' ? C.gold : C.rain, 'heavy');
  stack.addSpacer(1);
  addText(stack, r.small, smallSize, C.ink, 'bold');
}

function buildWidget(r, place) {
  const w = new ListWidget();
  w.backgroundColor = r.mode === 'raining' ? (r.snow ? C.snowBg : C.rainBg) : C.bg;
  w.url = TAP_URL;
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
    centerText(w, place, 13);
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
  centerText(w, place, 14);
  return w;
}

function errorWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = TAP_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60000);
  addText(w, '☔ 多久會下雨', 15, C.muted, 'bold');
  w.addSpacer(6);
  const t = w.addText(msg);
  t.font = Font.boldSystemFont(14);
  t.textColor = C.red;
  return w;
}

// ---------- 執行 ----------
// 點小工具 → 打開 Scriptable 跑這支程式 → 出現選單
const TAP_URL = 'scriptable:///run/' + encodeURIComponent(Script.name());

let skip = false;
if (!config.runsInWidget) {
  skip = (await menu()) === 'open';
}

if (!skip) {
  let widget;
  try {
    const param = String((config.runsInWidget ? args.widgetParameter : '') || '').trim();
    const pick = getPick();
    let loc, place;
    if (param) {
      // 📌 小工具 Parameter 指定的地點
      loc = await findPlace(param);
      place = '📌' + param;
    } else if (pick) {
      // 📌 從選單搜尋選的地點
      loc = { latitude: pick.lat, longitude: pick.lon };
      place = '📌' + pick.name;
    } else {
      // 📍 現在位置
      loc = await getLocation();
      if (loc) place = '📍' + ((await getPlaceName(loc.latitude, loc.longitude)) || '目前位置');
    }
    if (!loc) {
      widget = errorWidget('拿不到位置\n請點小工具 → 搜尋地點\n或允許 Scriptable 定位');
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
}
Script.complete();
