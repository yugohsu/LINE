// 多久會下雨 — iPhone 主畫面小工具 (Scriptable)
// 小 (正方形)：現在天氣 + 未來 12 小時降雨長條
// 中 / 大 (長方形)：第 1 行 現在天氣 + 多久下雨，地點在右上角
//                  第 2 行 未來 24 小時降雨長條 (每小時一條刻度，每 3 小時標幾點；白天黃底、晚上藍灰底)
//
// 換地點：點一下小工具 → 選「搜尋地點」→ 輸入地名 → 選結果
//         選「改回現在位置」就恢復用手機定位
// 也可以長按小工具 →「編輯小工具」→ Parameter 輸入地名，那個小工具就固定看那裡 (優先)

// ===== 可以自己改的地方 =====
const APP_URL = 'https://yugohsu.github.io/LINE/';   // 選單裡「打開下雨通知」的網址
const RAIN_MIN = 0.1;                                 // 15 分鐘降水 0.1mm 以上才算「有下」(雨雪都算)
const HOUR_RAIN = 0.3;                                // 1 小時降水 0.3mm 以上，長條畫成深色
const SNOW_RATIO = 0.7;                               // 雪佔降水 70% 以上 = 下雪
const MIX_RATIO = 0.3;                                // 雪佔 30%~70% = 雨夾雪；低於 30% = 下雨
const SMALL_HOURS = 12;                               // 正方形小工具顯示幾小時
const WIDE_HOURS = 24;                                // 長方形小工具顯示幾小時
const LABEL_EVERY = 3;                                // 每幾小時標一次時間數字 (1 = 每小時都標，字會比較小)
const PAD = 16;                                       // 小工具左右留白 (大字和長條的第一格會對齊)
const REFRESH_MIN = 10;                               // 希望幾分鐘更新一次 (iPhone 會自己決定，通常 10~30 分)
// 下雨通知 Apps Script 網址 (用來把中文地名換成經緯度)
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwGL9LSy0zDw0fS83oVSOL-RSoce7PQUjJQgvs216_TqxmF3VEbNTH7yOlSiEV9mc6dWg/exec';

// ===== 顏色 (土金色系，和下雨通知一樣) =====
const C = {
  bg: new Color('#f2eee6'),
  rainBg: new Color('#e3edf8'),
  ink: new Color('#2a2117'),
  muted: new Color('#7d7263'),
  gold: new Color('#9a7432'),        // 晴天
  cloud: new Color('#6b6f78'),       // 陰天 / 多雲
  rain: new Color('#3a78c2'),
  rainLight: new Color('#a9c6e8'),
  snow: new Color('#7b6fbf'),        // 下雪：薰衣草紫
  snowBg: new Color('#efedf8'),
  track: new Color('#e6dfd2'),
  dayTrack: new Color('#f3e1ad'),    // 白天的底色：淡黃
  nightTrack: new Color('#cfd0e3'),  // 晚上的底色：藍灰
  tick: new Color('#a89c88'),
  now: new Color('#e2662d'),        // 現在這一格：橘色框
  red: new Color('#c24a36')
};

// ---------- 防止卡住：每一步都有時間限制 ----------
// iPhone 小工具整支程式只能跑約 30 秒，超過就會出現 timeout 錯誤
function withTimeout(promise, sec, fallback) {
  const safe = promise.catch(() => fallback);
  let timer;
  try {
    timer = new Promise(res => Timer.schedule(sec * 1000, false, () => res(fallback)));
  } catch (e) {
    return safe;   // 這支 iPhone 不能用計時器，就直接等結果
  }
  return Promise.race([safe, timer]);
}

// ---------- 取得位置 (拿不到或太慢就用上次的位置) ----------
async function getLocation() {
  const saved = Keychain.contains('rain_widget_loc') ? JSON.parse(Keychain.get('rain_widget_loc')) : null;
  try {
    Location.setAccuracyToKilometer();   // 公里級就夠了，比較快
  } catch (e) {}
  const loc = await withTimeout(Location.current(), 6, null);
  if (loc && loc.latitude) {
    const v = { latitude: loc.latitude, longitude: loc.longitude };
    Keychain.set('rain_widget_loc', JSON.stringify(v));
    return v;
  }
  return saved;
}

// 地名 (查過的位置會記住，太慢就用上次的)
async function getPlaceName(lat, lon) {
  const key = 'rain_widget_place';
  const saved = Keychain.contains(key) ? JSON.parse(Keychain.get(key)) : null;
  // 和上次位置差不到約 1 公里，直接用上次的地名
  if (saved && Math.abs(saved.lat - lat) < 0.01 && Math.abs(saved.lon - lon) < 0.01) return saved.name;
  const r = await withTimeout(Location.reverseGeocode(lat, lon, 'zh_TW'), 4, null);
  const p = r && r[0];
  const name = p ? (p.subLocality || p.locality || p.administrativeArea || '') : '';
  if (name) {
    Keychain.set(key, JSON.stringify({ lat, lon, name }));
    return name;
  }
  return saved ? saved.name : '';
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
    const rq = new Request(GAS_URL + '?geo=' + encodeURIComponent(name));
    rq.timeoutInterval = 8;
    const r = await rq.loadJSON();
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
  a.title = '多久下雨';
  a.message = '小工具現在看的是：' + (pick ? pick.name + '（固定地點）' : '現在位置');
  a.addAction('搜尋地點');
  a.addAction('改回現在位置');
  a.addAction('打開下雨通知');
  a.addCancelAction('只看預覽');
  const i = await a.presentSheet();

  if (i === 0) {
    const ask = new Alert();
    ask.title = '搜尋地點';
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
      list.forEach(r => sel.addAction(r.label));
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
    '&current=weather_code,cloud_cover' +
    '&minutely_15=precipitation,rain,snowfall' +
    '&hourly=precipitation,precipitation_probability,rain,snowfall,is_day' +
    '&forecast_minutely_15=32&forecast_hours=26&past_minutely_15=1&timezone=auto';
  // 天氣資料：最多等 12 秒；抓不到就用上次存下來的 (12 小時內)
  const fm = FileManager.local();
  const cache = fm.joinPath(fm.documentsDirectory(), 'rain_widget_weather.json');
  let d = null, why = '';
  try {
    const req = new Request(url);
    req.timeoutInterval = 12;
    d = await withTimeout(req.loadJSON(), 13, null);
    if (d && !d.error && d.minutely_15) {
      fm.writeString(cache, JSON.stringify({ t: Date.now(), lat, lon, d }));
    } else {
      why = d && d.reason ? d.reason : '';
      d = null;
    }
  } catch (e) { d = null; why = e.message || ''; }
  if (!d && fm.fileExists(cache)) {
    const c = JSON.parse(fm.readString(cache));
    if (Date.now() - c.t < 12 * 3600000 && Math.abs(c.lat - lat) < 0.05 && Math.abs(c.lon - lon) < 0.05) d = c.d;
  }
  if (!d) throw new Error('連不到天氣資料\n請確認 Scriptable 可以用行動數據' + (why ? '\n' + why : ''));
  const off = d.utc_offset_seconds || 0;
  const ms = s => {
    const p = s.split(/[-T:]/);
    return Date.UTC(+p[0], +p[1] - 1, +p[2], +p[3], +p[4]) - off * 1000;
  };
  const cur = d.current || {};
  return {
    code: cur.weather_code == null ? 0 : cur.weather_code,
    cloud: cur.cloud_cover == null ? 0 : cur.cloud_cover,
    m: d.minutely_15.time.map((t, i) => ({
      end: ms(t), mm: d.minutely_15.precipitation[i] || 0, snow: d.minutely_15.snowfall[i] || 0,
      rain: (d.minutely_15.rain || [])[i] || 0
    })),
    h: d.hourly.time.map((t, i) => ({
      end: ms(t), mm: d.hourly.precipitation[i] || 0, snow: d.hourly.snowfall[i] || 0,
      rain: (d.hourly.rain || [])[i] || 0,
      prob: d.hourly.precipitation_probability[i] || 0,
      isDay: (d.hourly.is_day || [])[i]
    }))
  };
}

// ---------- 判斷 ----------
const pad = n => String(n).padStart(2, '0');
const hm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };

// 雪佔降水的比例 (積雪 1cm ≈ 0.7mm 的水)
const snowRatio = (mm, snow) => mm > 0 ? Math.min(1, (snow * 0.7) / mm) : 0;
// 類型：'rain' / 'mix' / 'snow'
const kindOf = (mm, snow) => {
  const r = snowRatio(mm, snow);
  return r >= SNOW_RATIO ? 'snow' : r >= MIX_RATIO ? 'mix' : 'rain';
};

// 15 分鐘的降水 (mm) / 積雪 (cm) → 小雨 中雨 大雨 雨夾雪 小雪 中雪 大雪
const level = (mm, snow) => {
  if (mm < RAIN_MIN) return '';
  const k = kindOf(mm, snow);
  if (k === 'snow') return snow < 0.2 ? '小雪' : snow < 0.7 ? '中雪' : '大雪';
  if (k === 'mix') return '雨夾雪';
  return mm < 0.5 ? '小雨' : mm < 2 ? '中雨' : '大雨';
};

// 沒下雨時：晴天 / 多雲 / 陰天
function skyWord(code, cloud) {
  if (code === 45 || code === 48) return '陰天';   // 霧
  if (code >= 3 || cloud >= 80) return '陰天';
  if (code === 2 || cloud >= 50) return '多雲';
  return '晴天';
}

const isSnow = word => word.indexOf('雪') >= 0;
const minText = min => min >= 60 ? (Math.round(min / 30) / 2).toString() + '小時' : Math.round(min) + '分';

function analyze(w) {
  const now = Date.now();
  const slots = w.m.map(s => ({ start: s.end - 15 * 60000, end: s.end, mm: s.mm, snow: s.snow }))
    .filter(s => s.end > now);
  const wet = s => s.mm >= RAIN_MIN;

  // 未來 24 小時 (每小時一格；包含「現在這一小時」)
  const day = w.h.filter(x => x.end > now).slice(0, 24).map(x => ({ start: x.end - 3600000, mm: x.mm, snow: x.snow, prob: x.prob, isDay: x.isDay }));
  const base = { day };
  const rank = { '': 0, '小雨': 1, '中雨': 2, '大雨': 3, '雨夾雪': 4, '小雪': 5, '中雪': 6, '大雪': 7 };

  // 從第 i 格開始連續下的那一段：最大雨勢 + 停的時間
  const block = i => {
    let word = '', end = null;
    for (let j = i; j < slots.length; j++) {
      if (!wet(slots[j])) { end = slots[j].start; break; }
      const w2 = level(slots[j].mm, slots[j].snow);
      if (rank[w2] > rank[word]) word = w2;
    }
    return { word, end };
  };

  // ===== 現在正在下：大字顯示 小雨 / 中雨 / 大雨 / 雪 =====
  const cur = slots[0];
  if (cur && wet(cur)) {
    const word = level(cur.mm, cur.snow);
    const b = block(0);
    return Object.assign(base, {
      kind: isSnow(word) ? 'snow' : 'rain',
      big: word,
      small: b.end ? hm(b.end) + ' 停' : '會一直下'
    });
  }

  // ===== 現在沒下：大字顯示 晴天 / 多雲 / 陰天 =====
  const sky = skyWord(w.code, w.cloud);
  const skyKind = sky === '晴天' ? 'sun' : 'cloud';

  // 8 小時內會下 (每 15 分鐘的預報)
  const fi = slots.findIndex(wet);
  if (fi >= 0) {
    const first = slots[fi];
    const b = block(fi);
    const min = Math.max(0, (first.start - now) / 60000);
    return Object.assign(base, {
      kind: skyKind, big: sky,
      small: (min < 10 ? '快要下' : hm(first.start) + ' 開始下') + b.word
    });
  }

  // 24 小時內可能下 (逐時預報)
  const hot = x => x.mm >= HOUR_RAIN || x.prob >= 60;
  const li = day.findIndex(hot);
  if (li >= 0) {
    const later = day[li];
    let lj = li;
    while (lj + 1 < day.length && hot(day[lj + 1])) lj++;
    const seg = day.slice(li, lj + 1);
    const kinds = seg.filter(x => x.mm >= HOUR_RAIN).map(x => kindOf(x.mm, x.snow));
    const hasSnow = kinds.includes('snow'), hasMix = kinds.includes('mix'), hasRain = kinds.includes('rain');
    const word = hasMix || (hasSnow && hasRain) ? '下雨夾雪' : hasSnow ? '下雪' : '下雨';
    return Object.assign(base, {
      kind: skyKind, big: sky,
      small: hm(later.start) + ' 開始' + word
    });
  }

  return Object.assign(base, { kind: skyKind, big: sky, small: '24 小時不會下雨' });
}

// ---------- 畫降雨長條 + 刻度 ----------
// 長條高度 = 降雨機率；深藍 = 真的會下雨，紫色 = 會下雪/雨夾雪，淺藍 = 只是有機率
// 底色：白天淡黃、晚上藍灰
// 每小時一條刻度線；每 LABEL_EVERY 小時在刻度下面寫時間數字 (第一格 = 現在的小時，用深色)
function drawDay(day, n, width, barH, fontSize) {
  const tickH = 4, bigTickH = 7;
  const labelH = fontSize + 4;
  const height = barH + bigTickH + labelH;
  const dc = new DrawContext();
  dc.size = new Size(width, height);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const gap = n > 12 ? 1.5 : 2.5;
  const bw = (width - gap * (n - 1)) / n;
  const labelW = fontSize * 2.2;

  dc.setFont(Font.boldSystemFont(fontSize));
  dc.setTextAlignedCenter();

  for (let i = 0; i < n; i++) {
    const x = i * (bw + gap);
    const cx = x + bw / 2;

    const d = day[i];

    // 底色軌道 (白天 / 晚上不同顏色)
    const track = new Path();
    track.addRoundedRect(new Rect(x, 0, bw, barH), 2, 2);
    const tc = !d || d.isDay == null ? C.track : d.isDay ? C.dayTrack : C.nightTrack;
    dc.addPath(track); dc.setFillColor(tc); dc.fillPath();

    if (!d) continue;

    // 降雨長條
    const real = d.mm >= HOUR_RAIN;
    const p = Math.max(real ? 35 : 0, d.prob);
    if (p >= 5) {
      const h = Math.max(3, barH * p / 100);
      const snowy = real && kindOf(d.mm, d.snow) !== 'rain';
      const bar = new Path();
      bar.addRoundedRect(new Rect(x, barH - h, bw, h), 2, 2);
      dc.addPath(bar); dc.setFillColor(snowy ? C.snow : real ? C.rain : C.rainLight); dc.fillPath();
    }

    // 刻度線 (要標字的那一格畫長一點)
    const labeled = i % LABEL_EVERY === 0;
    const tick = new Path();
    tick.move(new Point(cx, barH + 1));
    tick.addLine(new Point(cx, barH + (labeled ? bigTickH : tickH)));
    dc.addPath(tick); dc.setStrokeColor(labeled ? C.muted : C.tick); dc.setLineWidth(labeled ? 1.5 : 1); dc.strokePath();

    // 時間數字 (第一格靠左，和上面的大字對齊)
    if (labeled) {
      const text = String(new Date(d.start).getHours());
      let lx = cx - labelW / 2;
      if (i === 0) { lx = 0; dc.setTextAlignedLeft(); }
      lx = Math.max(0, Math.min(width - labelW, lx));   // 頭尾不要被切掉
      dc.setTextColor(i === 0 ? C.now : C.muted);
      dc.drawTextInRect(text, new Rect(lx, barH + bigTickH, labelW, labelH));
      dc.setTextAlignedCenter();
    }
  }

  // 現在這一格：橘色框，一眼就看得到
  const box = new Path();
  box.addRoundedRect(new Rect(1.25, 1.25, bw - 2.5, barH - 2.5), 3, 3);
  dc.addPath(box); dc.setStrokeColor(C.now); dc.setLineWidth(2.5); dc.strokePath();
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

const bigColor = r => ({ sun: C.gold, cloud: C.cloud, rain: C.rain, snow: C.snow })[r.kind] || C.gold;
const bgColor = r => r.kind === 'rain' ? C.rainBg : r.kind === 'snow' ? C.snowBg : C.bg;

function buildWidget(r, place) {
  const w = new ListWidget();
  w.backgroundColor = bgColor(r);
  w.url = TAP_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60000);
  // 在 Scriptable 裡按執行時沒有尺寸，就當成長方形 (預覽也是長方形)
  const family = config.widgetFamily || (config.runsInWidget ? 'small' : 'medium');
  const placeText = '📍' + place;

  if (family === 'small') {
    // ===== 正方形 =====
    w.setPadding(12, PAD, 10, PAD);
    const top = w.addStack();
    top.centerAlignContent();
    addText(top, r.big, 26, bigColor(r), 'heavy');
    top.addSpacer();
    addText(top, placeText, 12, C.muted, 'bold');
    w.addSpacer(2);
    addText(w, r.small, 15, C.ink, 'bold');
    w.addSpacer();
    const sw = widgetWidth('small') - PAD * 2;
    const img = w.addImage(drawDay(r.day, SMALL_HOURS, sw, 40, 11));
    img.imageSize = new Size(sw, 40 + 7 + 15);
    img.leftAlignImage();
    return w;
  }

  // ===== 中 / 大 =====
  // 第 1 行：晴天　22:00 開始下雨　　　　　📍金竹里
  // 第 2 行：24 小時降雨長條 (從左到右整排)
  const isLarge = family === 'large' || family === 'extraLarge';
  const chartW = widgetWidth('medium') - PAD * 2;   // 長條佔滿整個寬度
  const barH = isLarge ? 160 : 56;
  const fontSize = isLarge ? 14 : 12;
  w.setPadding(12, PAD, 8, PAD);

  const top = w.addStack();
  top.centerAlignContent();
  addText(top, r.big, isLarge ? 34 : 28, bigColor(r), 'heavy');
  top.addSpacer(10);
  const sm = addText(top, r.small, isLarge ? 20 : 16, C.ink, 'bold');
  sm.minimumScaleFactor = 0.6;
  top.addSpacer();
  addText(top, placeText, isLarge ? 16 : 14, C.muted, 'bold');

  w.addSpacer();
  const img = w.addImage(drawDay(r.day, WIDE_HOURS, chartW, barH, fontSize));
  img.imageSize = new Size(chartW, barH + 7 + fontSize + 4);
  img.leftAlignImage();
  return w;
}

// 依手機螢幕寬度，估計小工具的寬度 (點)
function widgetWidth(kind) {
  const sw = Device.screenSize().width;
  const sizes = sw >= 428 ? [170, 364] : sw >= 414 ? [169, 360] : sw >= 393 ? [158, 338] : sw >= 390 ? [158, 338] : sw >= 375 ? [155, 329] : [141, 292];
  return kind === 'small' ? sizes[0] : sizes[1];
}

function errorWidget(msg) {
  const w = new ListWidget();
  w.backgroundColor = C.bg;
  w.url = TAP_URL;
  w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60000);
  addText(w, '多久會下雨', 16, C.muted, 'bold');
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
      loc = await findPlace(param);
      place = param;
    } else if (pick) {
      loc = { latitude: pick.lat, longitude: pick.lon };
      place = pick.name;
    } else {
      loc = await getLocation();
      if (loc) place = (await getPlaceName(loc.latitude, loc.longitude)) || '目前位置';
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
    await widget.presentMedium();
  }
}
Script.complete();
