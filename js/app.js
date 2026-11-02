/* ===== 全局状态 & 工具 ===== */
let TRIPS = [], STOPS = [], LEGS = [], DIARIES = [], WISHES = [];
let VISITED_PROVINCES = [];  // 手动点亮省名数组
let VISITED_CITIES = [];     // 手动点亮城市 [{name, region, lat, lng}]
let map, layerGroup, _legGroup = null, _wishGroup = null, provinceLayer = null, _cityLayer = null, _outlineLayer = null;
let _mapReady = false;
let _highlightMode = false;
let _drillAdcode = null, _drillProvName = null, _cityGeo = null;
const _cityGeoCache = new Map();
let _editingDiaryId = null;
let _editingTripId = null, _editingStopId = null, _editingLegId = null, _editingWishId = null;
let _legDirty = false;   // Leg 编辑表单是否有改动（添加返程前先保存原段，避免丢改动）
let _legAutoArrive = ''; // 出发日期/时刻自动同步到到达端的最近一次值（用于识别到达端是否被手动改过）
let _legYearFilter = ''; // 交通段城市下拉的年份筛选（'' = 全部年份）
let _timelineOrders = {}; // tripId -> 手动拖动后的时间线条目顺序（本地 config 持久化）

/* 照片模块状态 */
let _photoStopId = null, _stopPhotos = [], _thumbUrls = [];
let _photoIndex = [];   // 轻量索引 [{id, stopId}]，用于弹窗计数
let _lbPhotoId = null, _lbUrl = null;
let _photoSelectMode = false;   // 照片抽屉：批量选择删除模式
let _photoSelected = new Set(); // 已勾选的照片 id

/* 封面气泡 & 轮播状态 */
let _stopMarkers = new Map();   // stopId -> Leaflet marker（用于原位改色）
let _coverUrls = new Map();     // photoId -> objectURL（封面缩略图缓存）
let _pcStopId = null, _pcPhotos = [], _pcUrls = [], _pcIdx = 0;

/* 主题状态（light / dark），持久化到 localStorage */
let _theme = 'light';
let _tileLight = null, _tileDark = null, _tilesReady = false, _darkFallbackDone = false;
const TILE_URLS = {
  light: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
  dark:  'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=6&x={x}&y={y}&z={z}',
};
function applyTheme(theme) {
  _theme = (theme === 'dark') ? 'dark' : 'light';
  try { localStorage.setItem('footprint-theme', _theme); } catch (e) { /* file:// 下个别浏览器禁用则忽略 */ }
  document.documentElement.setAttribute('data-theme', _theme);
  const btn = document.getElementById('btn-theme');
  if (btn) {
    const ico = btn.querySelector('.ico');
    if (ico) ico.textContent = _theme === 'dark' ? '🌙' : '☀️';
  }
  setTiles(_theme);
  if (_mapReady) renderProvinces();   // 省界/地市配色随主题刷新
}
function initTheme() {
  let t = 'light';
  try { t = localStorage.getItem('footprint-theme') || 'light'; } catch (e) { /* 忽略 */ }
  applyTheme(t === 'dark' ? 'dark' : 'light');
}

/* 瓦片层：初始化时浅/深两层一次性创建，切换主题只切可见性，绝不 new / 移除重建 */
function createTileLayers() {
  if (_tilesReady) return;
  const opts = { subdomains: '1234', maxZoom: 18, attribution: '© 高德地图 GS(2023)4197号' };   // 允许东西向环绕（像高德/百度一样左右滑到太平洋→美洲）
  _tileLight = L.tileLayer(TILE_URLS.light, opts);
  _tileDark = L.tileLayer(TILE_URLS.dark, opts);
  [_tileLight, _tileDark].forEach(layer => {
    layer.on('tileerror', (e) => {
      const tile = e.tile;
      if (tile && !tile.dataset.retried) {   // 单个瓦片加载失败自动重试一次
        tile.dataset.retried = '1';
        const url = tile.src;
        setTimeout(() => { tile.src = url + (url.includes('?') ? '&' : '?') + 'fpRetry=1'; }, 300);
      }
    });
  });
  // 保留暗色兜底：暗色层整体不可用时回退浅色瓦片 + 深色遮罩，不白屏
  _tileDark.on('tileerror', () => {
    if (_darkFallbackDone) return;
    _darkFallbackDone = true;
    console.warn('[footprint] 暗色瓦片加载失败，回退浅色瓦片并加深色遮罩兜底');
    if (map.hasLayer(_tileDark)) map.removeLayer(_tileDark);
    if (!map.hasLayer(_tileLight)) _tileLight.addTo(map);
    _tileLight.bringToBack();
    document.getElementById('map').classList.add('tile-dark-mask');
    toast('暗色瓦片不可用，已用深色遮罩兜底');
  });
  _tilesReady = true;
}

/* 按主题显示对应瓦片层（两层均为初始化时创建的常驻对象） */
function setTiles(mode) {
  if (!_mapReady) return;
  createTileLayers();
  const show = mode === 'dark' ? _tileDark : _tileLight;
  const hide = mode === 'dark' ? _tileLight : _tileDark;
  const mapEl = document.getElementById('map');
  mapEl.classList.toggle('tile-dark-mask', mode === 'dark' && _darkFallbackDone);
  if (map.hasLayer(hide)) map.removeLayer(hide);
  if (!map.hasLayer(show)) { show.addTo(map); show.bringToBack(); }
}

/* 省界/地市点亮配色随主题（浅色墨绿 / 深色暖橙调 + 亮绿描边） */
function mapPalette() {
  return _theme === 'dark'
    ? { visitedStroke: '#7fd6ab', visitedFill: '#2E7D63', visitedFillOp: 0.3,
        visitedHoverStroke: '#a9e8c6', visitedHoverFill: 0.4,
        plainStroke: '#8a9aa0', plainHoverStroke: '#c5d1d6',
        cityFill: '#1d2126', cityFillOp: 0.25 }
    : { visitedStroke: '#2E7D63', visitedFill: '#2E7D63', visitedFillOp: 0.18,
        visitedHoverStroke: '#0e3f27', visitedHoverFill: 0.4,
        plainStroke: '#7a8a82', plainHoverStroke: '#5c6b63',
        cityFill: '#f1f5f9', cityFillOp: 0.25 };
}

// 六种交通方式；walk 仅作旧数据兼容渲染，不出现在图例/表单
const MODE_STYLE = {
  plane:     { color: '#2F6FED', dash: null, icon: '✈️', label: '飞机' },      // 明亮蓝：远看与绿色高铁线区分
  highspeed: { color: '#00B36B', dash: null, icon: '🚄', label: '高铁/动车' }, // 鲜亮绿：与飞机蓝、省界墨绿都拉开
  train:     { color: '#8a5a2b', dash: null, icon: '🚞', label: '普速火车' },
  bus:       { color: '#C99A45', dash: null, icon: '🚌', label: '大巴' },
  boat:      { color: '#4a90a4', dash: null, icon: '⛵', label: '轮船' },
  car:       { color: '#B34532', dash: null, icon: '🚗', label: '自驾' },
};
// 图例点击隐藏/显示对应交通方式的连线（会话内有效，不落库）
const _hiddenModes = new Set();
const LEG_FALLBACK = {
  walk: { color: '#6b7280', dash: '1,6', icon: '🚶', label: '步行' },
};
function legStyle(mode) {
  return MODE_STYLE[mode] || LEG_FALLBACK[mode] || { color: '#6b7280', dash: null, icon: '📍', label: '交通' };
}

/* 圆点自定义颜色（8 色预设色板） */
const MARKER_COLORS = ['#2E7D63', '#C99A45', '#B34532', '#f0a35e', '#d4677f', '#3d5a6c', '#7a6aa8', '#8a8f8a'];
const DEFAULT_MARKER_COLOR = '#2E7D63';
const PHOTO_LIMIT = 30;   // 单个城市照片上限

/* 全国城市坐标表来自 data/cities.js（window.CITIES：{name, province, lat, lng}），选择器见 initCityPicker() */

function uid() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}
function fmt(v) { return v ? v : '—'; }
// Leg 时间可能是完整时刻（2024-05-02T08:00）也可能只有日期（2024-05-02）；展示时统一用空格分隔
function legTimeText(v) { return v ? esc(String(v).replace('T', ' ')) : ''; }
// 表单拆分：把已存的出发/到达时间拆成“日期 + 可选时刻”
function splitLegTime(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  return m ? [m[1], m[2] || ''] : ['', ''];
}
function joinLegTime(date, clock) {
  return date ? (clock ? date + 'T' + clock : date) : '';
}
// Leg 时间片段：仅展示存在的一侧（弹窗版：出发: a　到达: b），两端都空返回空串
function legTimePopup(leg) {
  const parts = [];
  if (leg.departAt) parts.push('出发: ' + legTimeText(leg.departAt));
  if (leg.arriveAt) parts.push('到达: ' + legTimeText(leg.arriveAt));
  return parts.join('　');
}
// Leg 时间片段（时间线/列表版：a 到达 b），两端都空返回空串
function legTimeLine(leg) {
  if (!leg.departAt && !leg.arriveAt) return '';
  if (leg.departAt && leg.arriveAt) return legTimeText(leg.departAt) + ' 到达 ' + legTimeText(leg.arriveAt);
  if (leg.departAt) return legTimeText(leg.departAt) + ' 出发';
  return '到达 ' + legTimeText(leg.arriveAt);
}
function money(v) { return (v !== '' && v != null && !isNaN(v)) ? ('¥' + Number(v).toLocaleString()) : '—'; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}
function normProv(s) { return (s || '').replace(/(省|市|自治区|特别行政区)$/, ''); }
function normCity(s) { return (s || '').replace(/(市|地区|自治州|盟|林区|旗)$/, ''); }

/* ===== 多次到访：同一行程里的同名城市各算一次独立到访 =====
   每次到访就是一条独立 Stop：各自的日期、同行者、心情、花费、备注和照片；
   交通段通过 stopId 指向“哪一次到访”。这里只负责生成可区分的编号/标签。 */
function cityVisitList(s) {
  if (!s) return [];
  const key = normCity(s.city || s.nameZh);
  return STOPS.filter(x => x.tripId === s.tripId && normCity(x.city || x.nameZh) === key)
    .sort((a, b) =>
      (a.arriveDate || a.leaveDate || '9999').localeCompare(b.arriveDate || b.leaveDate || '9999')
      || String(a.id).localeCompare(String(b.id)));
}
function stopVisitInfo(s) {
  const list = cityVisitList(s);
  const idx = list.findIndex(x => x.id === s.id);
  return { no: Math.max(1, idx + 1), total: list.length, list };
}
function stopDateText(s) {
  if (!s) return '';
  if (s.arriveDate && s.leaveDate && s.leaveDate !== s.arriveDate) return `${s.arriveDate}~${s.leaveDate}`;
  return s.arriveDate || s.leaveDate || '';
}
function stopVisitLabel(s) {
  if (!s) return '';
  const { no, total } = stopVisitInfo(s);
  const parts = [s.nameZh || ''];
  if (total > 1) parts.push(`第${no}次`);
  const d = stopDateText(s);
  if (d) parts.push(d);
  return parts.filter(Boolean).join(' · ');
}
function stopVisitBadge(s) {
  const { no, total } = stopVisitInfo(s);
  return total > 1 ? ` <span class="visit-badge">第${no}次</span>` : '';
}
function stopVisitShort(s) {
  if (!s) return '';
  const { no, total } = stopVisitInfo(s);
  return (s.nameZh || '') + (total > 1 ? `·第${no}次` : '');
}
// 去重后的城市数（多次到访只算一个城市）
function uniqueCityCount(list) {
  return new Set((list || STOPS).map(s => normCity(s.city || s.nameZh))).size;
}
// 到访年份：优先城市日期，缺日期时回退到所属行程的起止年份；返回 'YYYY' 或 ''
function stopYear(s) {
  const pick = v => (String(v || '').match(/^(\d{4})/) || [])[1] || '';
  let y = pick(s && (s.arriveDate || s.leaveDate));
  if (!y) {
    const t = s ? TRIPS.find(x => x.id === s.tripId) : null;
    y = pick(t && (t.dateStart || t.dateEnd));
  }
  return y;
}
function yearSort(a, b) {
  if (a === b) return 0;
  if (!a) return 1;   // 日期未知排最后
  if (!b) return -1;
  return Number(b) - Number(a);
}
// 交通段端点文字：stop 端点优先显示“城市·第N次·日期”，避免同名城市选错
function legEndpointLabel(leg, end) {
  const e = leg && leg[end];
  if (e && e.kind === 'stop' && e.stopId) {
    const s = stopById(e.stopId);
    if (s) return stopVisitLabel(s);
  }
  const r = legEndpoint(leg, end);
  return r ? r.name : '?';
}
// 播放状态栏空间有限：端点只显示“城市·第N次”，完整日期留给抵达停留状态
function legEndpointShortLabel(leg, end) {
  const e = leg && leg[end];
  if (e && e.kind === 'stop' && e.stopId) {
    const s = stopById(e.stopId);
    if (s) return stopVisitShort(s);
  }
  const r = legEndpoint(leg, end);
  return r ? r.name : '?';
}

/* ===== 点亮判定（手动集合 ∪ 已有 Stop） ===== */
function provinceHighlighted(provName) {
  const n = normProv(provName);
  if (VISITED_PROVINCES.some(p => normProv(p) === n)) return true;
  return STOPS.some(s => s.country === '中国' && normProv(s.region || '') === n);
}
function cityHighlighted(cityName, provName) {
  const n = normCity(cityName);
  if (VISITED_CITIES.some(c => normCity(c.name) === n)) return true;
  return STOPS.some(s => s.country === '中国'
    && normProv(s.region || '') === normProv(provName || '')
    && normCity(s.city || s.nameZh || '') === n);
}

/* ===== 数据加载 ===== */
// 常驻城市（默认广州），存 IndexedDB config 集合，刷新保留；不作为 Stop 存在
let HOME_CITY = { name: '广州', lat: 23.1291, lng: 113.2644 };
async function loadAll() {
  [TRIPS, STOPS, LEGS, DIARIES] = await Promise.all([DB.getTrips(), DB.getStops(), DB.getLegs(), DB.getDiaries()]);
  // 旧数据字段兜底：markerColor / coverPhotoId
  STOPS.forEach(s => {
    s.markerColor = s.markerColor || DEFAULT_MARKER_COLOR;
    s.coverPhotoId = s.coverPhotoId || '';
  });
  VISITED_PROVINCES = await DB.getVisitedProvinces();
  VISITED_CITIES = await DB.getVisitedCities();
  WISHES = await DB.getWishlist();
  // 时间线手动排序（本机配置，换设备不迁移；新条目仍按默认规则补入）
  _timelineOrders = {};
  await Promise.all(TRIPS.map(async t => {
    try {
      const rec = await DB.getConfig('timelineOrder:' + t.id);
      if (rec && Array.isArray(rec.value) && rec.value.length) _timelineOrders[t.id] = rec.value;
    } catch (e) { /* 忽略单条读取失败 */ }
  }));
  const hc = await DB.getConfig('homeCity');
  if (hc && hc.name) HOME_CITY = { name: hc.name, lat: Number(hc.lat), lng: Number(hc.lng) };
  return { trips: TRIPS.length, cities: uniqueCityCount(), stops: STOPS.length, legs: LEGS.length, diaries: DIARIES.length, wish: WISHES.length };
}
async function reload() {
  await loadAll();
  await loadPhotoIndex();
  await refreshCoverUrls();
  refreshSelects();
  renderMap();
  renderProvinces();
  renderTimeline();
  renderLists();
  renderDiaries();
  renderWishes();
  renderStats();   // 数据条数/备份提醒随数据变化刷新
}
function stopById(id) { return STOPS.find(s => s.id === id); }

/* ===== Leg 端点解析（支持常驻城市/站点/手动输入；旧结构 fromStopId/toStopId 兼容） ===== */
// 返回 {name, lat, lng}；lat/lng 可为 null（缺坐标，不画该端连线）；无法解析返回 null
function legEndpoint(leg, end) {
  const e = leg[end];
  if (e && e.kind) {
    if (e.kind === 'home') return { name: HOME_CITY.name, lat: HOME_CITY.lat, lng: HOME_CITY.lng };
    if (e.kind === 'stop') {
      const s = stopById(e.stopId);
      return s ? { name: s.nameZh, lat: s.lat, lng: s.lng } : null;
    }
    const n = String(e.name || '').trim();
    if (!n) return null;
    const lat = (e.lat == null || e.lat === '') ? null : Number(e.lat);
    const lng = (e.lng == null || e.lng === '') ? null : Number(e.lng);
    return { name: n, lat, lng };
  }
  const s = stopById(end === 'from' ? leg.fromStopId : leg.toStopId);   // 旧数据兼容
  return s ? { name: s.nameZh, lat: s.lat, lng: s.lng } : null;
}
function legCoords(p) {
  if (!p || p.lat == null || p.lng == null || isNaN(p.lat) || isNaN(p.lng)) return null;
  return [p.lat, p.lng];
}

/* ===== 地图 ===== */
function initMap() {
  if (_mapReady) return;
  map = L.map('map', {
    zoomControl: true, doubleClickZoom: false,
    maxBounds: [[-85, -540], [85, 540]],   // 只锁南北纬 ±85（防灰底）；东西向放开 3 个世界宽度，配合瓦片环绕实现左右无限滑
  }).setView([35, 105], 4);
  // 动态最小缩放：保证视野恰好装下一张完整世界地图（屏越大允许的 minZoom 越大）
  setTimeout(() => {
    if (!_mapReady || !map) return;
    const size = map.getSize();
    if (size.x && size.y) map.setMinZoom(Math.max(2, Math.ceil(Math.log2(Math.max(size.x / 256, size.y / 256)))));
  }, 0);
  // 初始化即创建浅/深两个瓦片层（对象常驻，切换主题绝不 new）
  createTileLayers();
  // 容器宽高可能晚于地图初始化就绪：DOM 就绪 + window load 各刷一次尺寸，确保瓦片铺满
  setTimeout(() => { if (_mapReady && map) map.invalidateSize(); }, 0);
  if (document.readyState === 'complete') {
    setTimeout(() => { if (_mapReady && map) map.invalidateSize(); }, 0);
  } else {
    window.addEventListener('load', () => { if (_mapReady && map) map.invalidateSize(); });
  }
  map.createPane('provincePane');
  map.getPane('provincePane').style.zIndex = 350;
  map.createPane('outlinePane');   // 省级外轮廓：压在地市边界之上、圆点之下
  map.getPane('outlinePane').style.zIndex = 360;
  layerGroup = L.layerGroup().addTo(map);   // 城市圆点/封面气泡
  _legGroup = L.layerGroup().addTo(map);    // 交通连线（独立图层组）
  _wishGroup = L.layerGroup().addTo(map);   // 心愿星标（独立图层组）
  // Leaflet 会阻止弹窗内点击冒泡到 document，需在 popupopen 时单独绑弹窗内按钮
  map.on('popupopen', (e) => {
    const el = e.popup.getElement();
    if (el) bindPopupActions(el);
  });
  // 封面气泡随缩放级别显隐（zoom >= 9 显示）；地市标签重叠避让随缩放重算
  // 播放期跳过：变焦动画期间这两个重算会每帧执行，是旧版卡顿的主要来源之一；收尾统一补算
  map.on('zoomend', () => {
    if (_play && _play.running) return;
    updateBubbleVisibility();
    resolveCityLabelOverlap();
  });
  updateBubbleVisibility();
  _mapReady = true;
  setTiles(_theme);   // 就绪后立即显示当前主题瓦片层（此前这里缺失，首次打开瓦片不加载的根因）
  renderLegend();
  // 图例点击：隐藏/显示对应交通方式的连线
  document.getElementById('map-legend').addEventListener('click', (e) => {
    const item = e.target.closest('[data-mode]');
    if (!item) return;
    const mode = item.dataset.mode;
    if (_hiddenModes.has(mode)) _hiddenModes.delete(mode); else _hiddenModes.add(mode);
    renderLegend();
    renderMap();
  });
  renderMap();
  ensureProvinceData().then(() => renderProvinces());
}

// 弧线控制点：南→北（出发纬度低于到达）弧线向左（西侧）弯，反之向右（东侧）弯；偏移随间距自适应
function curveCtrl(a, b) {
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const dx = b[1] - a[1], dy = b[0] - a[0];
  const len = Math.hypot(dx, dy) || 1;
  const lift = len * 0.18;
  const p1 = [mid[0] + (-dy / len) * lift, mid[1] + (dx / len) * lift];   // 左侧候选
  const p2 = [mid[0] + (dy / len) * lift, mid[1] + (-dx / len) * lift];   // 右侧候选
  const west = p1[1] <= p2[1] ? p1 : p2;   // 经度小者为西
  const east = p1[1] <= p2[1] ? p2 : p1;
  return (a[0] < b[0]) ? west : east;
}

// plane 两点弧线（贝塞尔近似）；ctrl 可传入已算好的控制点
function planeCurve(a, b, ctrl) {
  const c = ctrl || curveCtrl(a, b);
  const pts = [];
  const N = 36;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0];
    const y = (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1];
    pts.push([x, y]);
  }
  return pts;
}

// 陆路"轨道式"连线（高铁/火车）：沿行进方向左侧弓出，去程靠左、回程自动落在另一侧（双轨效果）
function isRailMode(mode) { return mode === 'highspeed' || mode === 'train'; }
// m 为同向偏移档位：1 = 第一条，2 = 同向第二条再往外错开
function trackCtrl(a, b, m) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const dist = Math.hypot(dx, dy) || 1;
  const gap = Math.max(0.03, Math.min(0.6, dist * 0.03));
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  return [mx + (dy / dist) * gap * m * 2, my - (dx / dist) * gap * m * 2];   // 行进方向左侧法向偏移
}

// 两点间罗盘方位角（度）：CSS rotate 的 0deg 指向正北，顺时针为正
function bearingDeg(from, to) {
  const dx = (to[1] - from[1]) * Math.cos(((from[0] + to[0]) / 2) * Math.PI / 180);
  const dy = to[0] - from[0];
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

// 连线中部方向箭头：直线放几何中点，弧线放 t=0.5 处（按切线定向）；指向 to 端，颜色随连线
function legArrow(a, b, ctrl, color) {
  let pos, angle;
  if (ctrl) {
    const t = 0.5, u = 1 - t;
    pos = [u * u * a[0] + 2 * u * t * ctrl[0] + t * t * b[0], u * u * a[1] + 2 * u * t * ctrl[1] + t * t * b[1]];
    const dLat = 2 * u * (ctrl[0] - a[0]) + 2 * t * (b[0] - ctrl[0]);
    const dLng = 2 * u * (ctrl[1] - a[1]) + 2 * t * (b[1] - ctrl[1]);
    angle = Math.atan2(dLng * Math.cos(pos[0] * Math.PI / 180), dLat) * 180 / Math.PI;
  } else {
    pos = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    angle = bearingDeg(a, b);
  }
  L.marker(pos, {
    icon: L.divIcon({
      className: 'fp-arrow-icon', iconSize: [6, 10], iconAnchor: [3, 5],
      html: `<div class="fp-arrow" style="transform:rotate(${angle.toFixed(1)}deg);border-bottom-color:${color}"></div>`,
    }),
    interactive: false, keyboard: false,
  }).addTo(_legGroup);
}

// 计算所有 Leg 的地图几何：与 renderMap 完全一致（去程/回程/同址多条错开）。
// 播放时直接复用这套路径点，保证动画线沿原有交通线走，而不是另画一条。
function computeLegGeometries() {
  // 往返/重叠错开：相同城市对的非飞机连线分组，按序平行偏移（去程左偏、回程右偏、同向依次错开）
  const groups = new Map();
  LEGS.forEach(leg => {
    if (leg.mode === 'plane' || _hiddenModes.has(leg.mode)) return;
    const pa = legEndpoint(leg, 'from'), pb = legEndpoint(leg, 'to');
    const A = legCoords(pa), B = legCoords(pb);
    if (!A || !B) return;
    const key = [A, B].map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).sort().join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ leg, A, B });
  });
  const offsets = new Map();
  const railOffsets = new Map();
  groups.forEach(list => {
    list.sort((x, y) => (x.leg.departAt || '').localeCompare(y.leg.departAt || '') || x.leg.id.localeCompare(y.leg.id));
    const n = list.length;
    // 轨道式（高铁/火车）：按各自行进方向左侧排档；往返自动分居两侧，同向多条依次外扩
    const dirRank = new Map();
    list.forEach(item => {
      const dk = (item.A[0] < item.B[0] || (item.A[0] === item.B[0] && item.A[1] <= item.B[1])) ? 0 : 1;
      const r = dirRank.get(dk) || 0;
      dirRank.set(dk, r + 1);
      railOffsets.set(item.leg.id, r + 1);
    });
    // 组内统一法向量：去程/回程分居两侧，同向多段依次错开
    const dx = list[0].B[0] - list[0].A[0], dy = list[0].B[1] - list[0].A[1];
    const dist = Math.hypot(dx, dy) || 1;
    const nx = -dy / dist, ny = dx / dist;
    const gap = Math.max(0.03, Math.min(0.6, dist * 0.03));
    list.forEach((item, i) => {
      const k = i - (n - 1) / 2;
      const mx = (item.A[0] + item.B[0]) / 2, my = (item.A[1] + item.B[1]) / 2;
      offsets.set(item.leg.id, { ctrl: [mx + nx * gap * k * 2, my + ny * gap * k * 2] });
    });
  });
  const out = new Map();
  LEGS.forEach(leg => {
    if (_hiddenModes.has(leg.mode)) return;
    const pa = legEndpoint(leg, 'from'), pb = legEndpoint(leg, 'to');
    const A = legCoords(pa), B = legCoords(pb);
    if (!A || !B) return;
    let pts, ctrl = null;
    if (leg.mode === 'plane') {
      ctrl = curveCtrl(A, B);
      pts = planeCurve(A, B, ctrl);
    } else if (isRailMode(leg.mode)) {
      ctrl = trackCtrl(A, B, railOffsets.get(leg.id) || 1);   // 去程靠左、回程靠右
      pts = planeCurve(A, B, ctrl);
    } else {
      const off = offsets.get(leg.id);
      if (off && (Math.abs(off.ctrl[0] - (A[0] + B[0]) / 2) > 1e-9 || Math.abs(off.ctrl[1] - (A[1] + B[1]) / 2) > 1e-9)) {
        ctrl = off.ctrl;
        pts = planeCurve(A, B, ctrl);
      } else {
        pts = [A, B];
      }
    }
    out.set(leg.id, { A, B, ctrl, pts });
  });
  return out;
}

function renderMap() {
  if (!_mapReady) return;
  // 清理播放中断/异常遗留的动画图层：避免地图上出现时间线和列表里没有的“多余连线”
  if (_playGroup && !(_play && _play.running)) {
    if (map.hasLayer(_playGroup)) map.removeLayer(_playGroup);
    _playGroup = null;
  }
  layerGroup.clearLayers();
  // Leg 连线独立 LayerGroup：省内下钻视图不绘制，返回全国再统一刷新
  if (_legGroup) {
    map.removeLayer(_legGroup);
    _legGroup.clearLayers();
    if (!_drillAdcode) {
      map.addLayer(_legGroup);
      const geom = computeLegGeometries();
      LEGS.forEach(leg => {
        const g = geom.get(leg.id);
        if (!g) return;
        const { A, B, ctrl, pts } = g;
        const st = legStyle(leg.mode);
        const tp = legTimePopup(leg);
        const trip = TRIPS.find(t => t.id === leg.tripId);
        const tripLine = trip ? `🧳 ${esc(trip.title)}` : '⚠️ 未归属行程（不在任何行程的时间线里）';
        L.polyline(pts, { color: st.color, weight: 2, opacity: 0.9 })
          .bindPopup(`<b>${st.icon} ${st.label}</b><br>${esc(legEndpointLabel(leg, 'from'))} → ${esc(legEndpointLabel(leg, 'to'))}${tp ? '<br>' + tp : ''}<br>花费: ${money(leg.cost)}<br>${tripLine}`
            + `<br><button class="link-btn" data-leg-del="${esc(leg.id)}">删除这段交通</button>`)
          .addTo(_legGroup);
        legArrow(A, B, ctrl, st.color);   // 线段中部方向箭头，指向 to 端
      });
    }
  }
  _stopMarkers = new Map();
  // 同一坐标的多次到访合并成一个标记：弹窗里逐次列出，避免完全重叠导致只点得到最后一次
  const markerGroups = new Map();
  STOPS.forEach(s => {
    const lat = Number(s.lat), lng = Number(s.lng);
    const key = (isFinite(lat) && isFinite(lng)) ? lat.toFixed(3) + ',' + lng.toFixed(3) : 'id:' + s.id;
    if (!markerGroups.has(key)) markerGroups.set(key, []);
    markerGroups.get(key).push(s);
  });
  markerGroups.forEach(group => {
    const visits = group.slice().sort((a, b) =>
      (a.arriveDate || a.leaveDate || '9999').localeCompare(b.arriveDate || b.leaveDate || '9999')
      || String(a.id).localeCompare(String(b.id)));
    const rep = visits[visits.length - 1];   // 最新一次到访代表颜色
    const coverRep = visits.slice().reverse().find(s => s.coverPhotoId && _coverUrls.get(s.coverPhotoId)) || null;
    const color = rep.markerColor || DEFAULT_MARKER_COLOR;
    const coverUrl = coverRep ? _coverUrls.get(coverRep.coverPhotoId) : null;
    const multi = visits.length > 1;
    const badge = multi ? `<div class="fp-visit-badge">${visits.length}次</div>` : '';
    let html, iconSize;
    if (coverUrl) {
      html = `<div class="fp-marker"><div class="fp-cover" title="${multi ? '点击查看到访记录与照片' : '点击查看照片'}"><img src="${coverUrl}" alt=""></div>`
        + `<div class="fp-dot" style="background:${color}"></div>${badge}</div>`;
      iconSize = [56, 60];
    } else {
      html = `<div class="fp-marker"><div class="fp-dot" style="background:${color}"></div>${badge}</div>`;
      iconSize = [56, 16];
    }
    const marker = L.marker([Number(rep.lat), Number(rep.lng)], {
      icon: L.divIcon({ className: 'fp-marker-icon', html, iconSize, iconAnchor: [Math.round(iconSize[0] / 2), iconSize[1] - 1] }),
      keyboard: false,
    });
    if (multi) {
      marker._visits = visits;
      marker.bindPopup(() => visitsPopupHtml(visits));
    } else if (coverUrl) {
      marker.on('click', () => openCarousel(coverRep.id));   // 有封面城市：点击封面/圆点 → 全屏轮播（封面第一张）
    } else {
      marker.bindPopup(() => stopPopupHtml(rep));       // 无封面城市：点击圆点 → 信息卡片
    }
    marker.addTo(layerGroup);
    visits.forEach(s => _stopMarkers.set(s.id, marker));
  });
  // 常驻城市：自动生成一个 🏠 标记点，像普通城市一样可点击（与已有城市点重合时不重复画）
  if (HOME_CITY && HOME_CITY.lat != null && HOME_CITY.lng != null) {
    const dup = STOPS.some(s =>
      (s.nameZh || '').trim() === (HOME_CITY.name || '').trim()
      || (Math.abs(Number(s.lat) - Number(HOME_CITY.lat)) < 0.05 && Math.abs(Number(s.lng) - Number(HOME_CITY.lng)) < 0.05));
    if (!dup) {
      const marker = L.marker([Number(HOME_CITY.lat), Number(HOME_CITY.lng)], {
        icon: L.divIcon({
          className: 'fp-marker-icon',
          html: `<div class="fp-marker"><div class="fp-dot fp-dot-home" title="常驻城市">🏠</div></div>`,
          iconSize: [56, 16], iconAnchor: [28, 15],
        }),
        keyboard: false,
      });
      marker.bindPopup(`<b>🏠 ${esc(HOME_CITY.name || '常驻城市')}</b><br>📍 常驻地（在「设置 → 常驻城市」中修改）`);
      marker.addTo(layerGroup);
    }
  }
}

// 弹窗内容函数化：每次打开都取最新的日记摘要、照片数与颜色选中态
// titleOverride 用于“多次到访”合并弹窗里的分节标题（第 N 次 · 日期）
function stopPopupHtml(s, titleOverride) {
  const linked = DIARIES.filter(d => d.stopId === s.id).slice(0, 3);
  const diaryHtml = linked.length
    ? '<br>📔 ' + linked.map(d => `${fmt(d.date)} ${esc(d.mood || '')} ${esc((d.note || '').slice(0, 20))}`).join('<br>📔 ')
    : '';
  const cur = s.markerColor || DEFAULT_MARKER_COLOR;
  const swatches = MARKER_COLORS.map(c =>
    `<button class="swatch${c === cur ? ' selected' : ''}" data-stopcolor="${c}" data-stop-id="${s.id}" style="background:${c}" title="${c}"></button>`).join('');
  // 信息行：字段为空就不显示该行（停留天数按到达/离开日期计算，缺日期不显示）
  const rows = [];
  if (s.arriveDate && s.leaveDate) {
    const days = Math.round((new Date(s.leaveDate) - new Date(s.arriveDate)) / 864e5) + 1;
    if (!isNaN(days) && days > 0) rows.push(`📍 停留 ${days} 天`);
  }
  if (s.weather) rows.push('🌤 天气: ' + esc(s.weather));
  if (s.mood) rows.push('😊 心情: ' + esc(s.mood));
  if (s.cost != null && s.cost !== '') rows.push('💰 花费: ' + money(s.cost));
  if (s.companions) rows.push('👥 同行: ' + esc(s.companions));
  const trip = TRIPS.find(t => t.id === s.tripId);
  if (trip && trip.title) rows.push('🧳 行程: ' + esc(trip.title));
  if (s.note) rows.push('📝 ' + esc(s.note));
  const title = titleOverride
    ? `<b>${esc(titleOverride)}</b>`
    : `<b>${esc(s.nameZh)}${s.nameEn ? ' / ' + esc(s.nameEn) : ''}</b>${stopVisitBadge(s)}`;
  const lines = [title];
  if (!titleOverride) lines.push(`${fmt(s.arriveDate)}${s.leaveDate ? ' ~ ' + fmt(s.leaveDate) : ''}`);
  if (rows.length) lines.push(rows.join('<br>'));
  return `${lines.join('<br>')}${diaryHtml}`
    + `<br><button class="link-btn" data-photos="${s.id}">📷 照片（${photoCount(s.id)}）</button>`
    + `<div class="swatch-row" style="margin-top:6px;">${swatches}</div>`;
}

// 同一坐标的多次到访：合并成一个标记，弹窗里逐次列出（各自照片/心情/同行者互不影响）
function visitsPopupHtml(list) {
  const visits = list.slice().sort((a, b) =>
    (a.arriveDate || a.leaveDate || '9999').localeCompare(b.arriveDate || b.leaveDate || '9999')
    || String(a.id).localeCompare(String(b.id)));
  const name = visits[0] ? visits[0].nameZh : '城市';
  return `<b>${esc(name)}</b> · ${visits.length} 次到访`
    + visits.map((s, i) => {
      const d = stopDateText(s);
      return `<div class="visit-block${i ? ' visit-block-sep' : ''}">`
        + stopPopupHtml(s, `第 ${i + 1} 次${d ? ' · ' + d : ''}`)
        + `</div>`;
    }).join('');
}
// 弹窗内按钮绑定（照片入口 + 圆点改色），popupopen 与 setPopupContent 后都要调用
function bindPopupActions(root) {
  root.querySelectorAll('[data-photos]').forEach(b =>
    b.addEventListener('click', () => openPhotoDrawer(b.dataset.photos)));
  root.querySelectorAll('[data-stopcolor]').forEach(b =>
    b.addEventListener('click', async () => {
      const st = STOPS.find(x => x.id === b.dataset.stopId);
      if (!st) return;
      st.markerColor = b.dataset.stopcolor;
      await DB.putStop(st);
      const m = _stopMarkers.get(st.id);
      if (m) {
        const el = m.getElement();
        if (el) { const dot = el.querySelector('.fp-dot'); if (dot) dot.style.background = st.markerColor; }
        m.setPopupContent(m._visits ? visitsPopupHtml(m._visits) : stopPopupHtml(st));
        const pe = m.getPopup() && m.getPopup().getElement();
        if (pe) bindPopupActions(pe);
      }
      toast('圆点颜色已更新');
    }));
  // 地图上的交通连线弹窗：显示所属行程并可删除（用于清理无主/多余的线）
  root.querySelectorAll('[data-leg-del]').forEach(b =>
    b.addEventListener('click', async () => {
      const id = b.dataset.legDel;
      const leg = LEGS.find(l => l.id === id);
      if (!leg) return;
      if (!confirm('确定删除这段交通？此操作不可撤销。')) return;
      try {
        if (_editingLegId === id) exitEditMode('leg');
        await DB.delLeg(id);
        if (map) map.closePopup();
        await reload();
        toast('交通段已删除');
      } catch (err) {
        console.error('[footprint] 删除交通段失败：', err);
        toast('删除失败：' + ((err && (err.message || err.code)) || err));
      }
    }));
}

function renderLegend() {
  const el = document.getElementById('map-legend');
  el.innerHTML = Object.keys(MODE_STYLE).map(k => {
    const s = MODE_STYLE[k];
    const d = s.dash ? `border-top-style:dashed;border-top-color:${s.color};` : `border-top-color:${s.color};`;
    return `<span class="item${_hiddenModes.has(k) ? ' off' : ''}" data-mode="${k}" title="点击隐藏/显示该交通方式的连线">`
      + `<span class="line" style="${d}"></span>${s.icon} ${s.label}</span>`;
  }).join('');
}

/* ===== 中国省界图层（全国 / 省内下钻） ===== */
let _provinceData = null;

async function ensureProvinceData() {
  if (_provinceData) return _provinceData;
  if (window.CHINA_GEOJSON) {
    _provinceData = window.CHINA_GEOJSON;
  } else {
    try {
      // no-referrer：DataV 对带 github.io Referer 的请求返回 403 HTML，必须去掉 Referer 才能拿到 GeoJSON
      const res = await fetch('https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json', { referrerPolicy: 'no-referrer' });
      _provinceData = await res.json();
    } catch (e) { console.warn('[footprint] 省界 GeoJSON 加载失败（不影响其余功能）', e); }
  }
  return _provinceData;
}

function renderProvinces() {
  if (!_mapReady) return;
  if (_drillAdcode && _cityGeo) renderCityLayer();
  else renderProvincesNational();
}

/* ===== 悬停底部浮层与地市常显标签 ===== */
function showHoverBar(text) {
  const el = document.getElementById('map-hover-bar');
  if (!el) return;
  const t = String(text == null ? '' : text).trim();
  if (!t) { hideHoverBar(); return; }
  el.textContent = t;
  el.hidden = false;
}
function hideHoverBar() {
  const el = document.getElementById('map-hover-bar');
  if (el) el.hidden = true;
}
// 相邻地市标签避让：两两检测像素级重叠，被遮挡者隐藏（保留先渲染者）
function resolveCityLabelOverlap() {
  const els = [...document.querySelectorAll('.city-label')];
  els.forEach(el => { el.style.visibility = ''; });
  const rects = els.map(el => ({ el, r: el.getBoundingClientRect() }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rects[i].el.style.visibility === 'hidden' || rects[j].el.style.visibility === 'hidden') continue;
      const a = rects[i].r, b = rects[j].r;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2) rects[j].el.style.visibility = 'hidden';
    }
  }
}

function renderProvincesNational() {
  if (!_provinceData) return;
  if (provinceLayer) { map.removeLayer(provinceLayer); provinceLayer = null; }
  const p = mapPalette();
  provinceLayer = L.geoJSON(_provinceData, {
    pane: 'provincePane',
    style: (f) => {
      const name = (f.properties && f.properties.name) || '';
      // 省界描边统一：weight 2.5 / #1b5e3f / opacity .95；仅填充区分点亮状态
      return provinceHighlighted(name)
        ? { color: '#1b5e3f', weight: 2.5, opacity: 0.95, fillColor: p.visitedFill, fillOpacity: p.visitedFillOp }
        : { color: '#1b5e3f', weight: 2.5, opacity: 0.95, fillColor: '#ffffff', fillOpacity: 0.0 };
    },
    onEachFeature: (feature, layer) => {
      const name = (feature.properties && feature.properties.name) || '';
      layer.bindPopup(`<b>${esc(name)}</b><br>状态：${provinceHighlighted(name) ? '🟢 已点亮' : '⚪ 未点亮'}<br><span class="sub">双击进入省内地图</span>`);
      layer.on({
        click: (e) => { if (_highlightMode) { toggleProvince(name); e.target.closePopup(); } },
        mouseover: (e) => {
          const t = e.target;
          const on = provinceHighlighted((feature.properties && feature.properties.name) || '');
          t.setStyle(on
            ? { weight: 3, color: p.visitedHoverStroke, fillOpacity: p.visitedHoverFill }
            : { weight: 2.5, color: p.plainHoverStroke, fillOpacity: 0.08 });
          t.bringToFront();
          showHoverBar(name);   // 底部浮层显示省名
        },
        mouseout: (e) => { provinceLayer.resetStyle(e.target); hideHoverBar(); },
        dblclick: (e) => { drillToProvince(feature.properties.adcode, name, e.target.getBounds()); },
      });
    },
  }).addTo(map);
}

function renderCityLayer() {
  if (!_cityGeo) return;
  if (_cityLayer) { map.removeLayer(_cityLayer); _cityLayer = null; }
  const p = mapPalette();
  _cityLayer = L.geoJSON(_cityGeo, {
    pane: 'provincePane',
    style: (f) => {
      const name = (f.properties && f.properties.name) || '';
      // 地市内部边界统一：细浅灰线 weight 1.2 / #9aa0a6 / opacity .8；仅填充区分点亮状态
      return cityHighlighted(name, _drillProvName)
        ? { color: '#9aa0a6', weight: 1.2, opacity: 0.8, fillColor: p.visitedFill, fillOpacity: p.visitedFillOp }
        : { color: '#9aa0a6', weight: 1.2, opacity: 0.8, fillColor: p.cityFill, fillOpacity: p.cityFillOp };
    },
    onEachFeature: (feature, layer) => {
      const name = (feature.properties && feature.properties.name) || '';
      layer.bindPopup(`<b>${esc(name)}</b><br>${esc(_drillProvName || '')}<br>状态：${cityHighlighted(name, _drillProvName) ? '🟢 已点亮' : '⚪ 未点亮'}`);
      // 地市名称常显标签：绑在要素图层上，返回全国移除图层时自动清除
      if (String(name || '').trim()) {
        layer.bindTooltip(String(name).trim(), {
          permanent: true, direction: 'top', offset: [0, -6],
          className: 'city-label',
        });
      }
      layer.on({
        click: (e) => { if (_highlightMode) { toggleCity(feature); e.target.closePopup(); } },
        mouseover: (e) => {
          const t = e.target;
          const on = cityHighlighted((feature.properties && feature.properties.name) || '', _drillProvName);
          t.setStyle({ weight: 2.5, color: on ? p.visitedHoverStroke : p.plainHoverStroke, fillOpacity: on ? p.visitedHoverFill : p.cityFillOp });
          t.bringToFront();
          showHoverBar(name);   // 底部浮层显示地市名
        },
        mouseout: (e) => { if (_cityLayer) _cityLayer.resetStyle(e.target); hideHoverBar(); },
      });
    },
  }).addTo(map);
  requestAnimationFrame(resolveCityLabelOverlap);   // 标签 DOM 就绪后做一次重叠避让
}

async function drillToProvince(adcode, provName, bounds) {
  if (!adcode) { toast('该省暂无下级边界数据'); return; }
  try {
    let data = _cityGeoCache.get(adcode);
    if (!data) {
      const res = await fetch(`https://geo.datav.aliyun.com/areas_v3/bound/${adcode}_full.json`, { referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
      if (!data || !Array.isArray(data.features) || !data.features.length) throw new Error('EMPTY_DATA');
      _cityGeoCache.set(adcode, data);   // 成功才缓存；404/空数据不缓存，可重试
    }
    _drillAdcode = adcode; _drillProvName = provName; _cityGeo = data;
    hideHoverBar();
    if (provinceLayer) { map.removeLayer(provinceLayer); provinceLayer = null; }
    if (_legGroup) map.removeLayer(_legGroup);   // 省内视图隐藏全部交通连线
    if (_wishGroup) map.removeLayer(_wishGroup); // 省内视图隐藏心愿星标
    renderCityLayer();
    // 省级外轮廓加粗压顶：weight 3 / #1b5e3f / 不透明，与地市细线明显区分
    if (_outlineLayer) { map.removeLayer(_outlineLayer); _outlineLayer = null; }
    let outlineFeature = null;
    if (_provinceData) {
      outlineFeature = _provinceData.features.find(f => String((f.properties || {}).adcode) === String(adcode))
        || _provinceData.features.find(f => normProv((f.properties || {}).name || '') === normProv(provName));
    }
    if (outlineFeature) {
      _outlineLayer = L.geoJSON(outlineFeature, {
        pane: 'outlinePane', interactive: false,
        style: { color: '#1b5e3f', weight: 3, opacity: 1, fill: false },
      }).addTo(map);
    }
    if (bounds) map.fitBounds(bounds, { padding: [20, 20] });
    document.getElementById('btn-back-china').hidden = false;
  } catch (err) {
    // 容错：请求失败 / 404 / 空数据 → 提示并保持全国视图；warn 非红色 error，不抛未捕获异常
    console.warn('[footprint] 省份下钻未加载（adcode: ' + adcode + '）：', err && err.message);
    toast('该省暂无下级边界数据');
  }
}

function backToChina() {
  _drillAdcode = null; _drillProvName = null; _cityGeo = null;
  hideHoverBar();
  if (_cityLayer) { map.removeLayer(_cityLayer); _cityLayer = null; }   // 地市常显标签随图层一并清除
  if (_outlineLayer) { map.removeLayer(_outlineLayer); _outlineLayer = null; }   // 清除省级外轮廓
  renderProvincesNational();
  renderMap();   // 重新加回 Leg 连线图层组（含省内期间新增/编辑的连线）
  if (_wishGroup) { map.addLayer(_wishGroup); renderWishMarkers(); }   // 恢复心愿星标
  map.setView([35, 105], 4);
  document.getElementById('btn-back-china').hidden = true;
}

async function toggleProvince(name) {
  const idx = VISITED_PROVINCES.findIndex(p => normProv(p) === normProv(name));
  if (idx >= 0) {
    await DB.delVisitedProvince(VISITED_PROVINCES[idx]);
    VISITED_PROVINCES.splice(idx, 1);
    toast('已取消点亮：' + name);
  } else {
    await DB.putVisitedProvince(name);
    VISITED_PROVINCES.push(name);
    toast('已点亮：' + name);
  }
  renderProvinces();
}

async function toggleCity(feature) {
  const p = feature.properties || {};
  const name = p.name || '';
  if (!name) return;
  const idx = VISITED_CITIES.findIndex(c => normCity(c.name) === normCity(name));
  if (idx >= 0) {
    await DB.delVisitedCity(VISITED_CITIES[idx].name);
    VISITED_CITIES.splice(idx, 1);
    toast('已取消点亮：' + name);
  } else {
    const cen = p.centroid || p.center || [];
    const rec = { name, region: _drillProvName || '', lat: cen[1] != null ? cen[1] : null, lng: cen[0] != null ? cen[0] : null };
    await DB.putVisitedCity(rec);
    VISITED_CITIES.push(rec);
    toast('已点亮：' + name);
  }
  renderProvinces();
}

/* ===== 时间线 ===== */
// 城市条目：只有「有交通段抵达」的城市才显示，并排在抵达它的交通段前面。
// 这条规则同时覆盖手动排序：默认顺序由交通段顺序推导，拖动后以保存的顺序为准。
function timelineStopItem(s) {
  return { key: 's:' + s.id, html:
    `<div class="tl-icon">📍</div><div class="tl-body"><b>${esc(s.nameZh)}</b>${stopVisitBadge(s)}`
    + `<div class="sub">${fmt(s.arriveDate)}${s.leaveDate ? ' ~ ' + fmt(s.leaveDate) : ''}｜心情 ${fmt(s.mood)}｜${money(s.cost)}</div>`
    + (s.note ? `<div class="sub">${esc(s.note)}</div>` : '') + `</div>` };
}
function timelineLegItem(l) {
  const st = legStyle(l.mode);
  const meta = [legTimeLine(l), l.cost == null ? '' : money(l.cost)].filter(Boolean).join('｜');
  return { key: 'l:' + l.id, html:
    `<div class="tl-icon">${st.icon}</div><div class="tl-body"><b>${st.label}</b>：${esc(legEndpointLabel(l, 'from'))} → ${esc(legEndpointLabel(l, 'to'))}`
    + `<div class="sub">${meta}</div>`
    + (l.note ? `<div class="sub">${esc(l.note)}</div>` : '') + `</div>` };
}
function timelineTripItems(trip) {
  const stops = STOPS.filter(s => s.tripId === trip.id);
  const legs = LEGS.filter(l => l.tripId === trip.id)
    .sort((a, b) => (a.departAt || a.arriveAt || '9999').localeCompare(b.departAt || b.arriveAt || '9999') || String(a.id).localeCompare(String(b.id)));
  // 每条交通段只认一个抵达城市；城市取最早抵达它的那一段作为“锚点”。
  const anchorLeg = new Map();   // legId -> stop
  const anchored = new Set();    // 已有抵达段的 stopId
  for (const leg of legs) {
    const to = legPlayEndpoint(leg, 'to');
    if (!to) continue;
    const hit = stops.find(s => endpointHitsStop(to, s));
    if (hit && !anchored.has(hit.id)) { anchored.add(hit.id); anchorLeg.set(leg.id, hit); }
  }
  const items = [];
  for (const leg of legs) {
    const city = anchorLeg.get(leg.id);
    if (city) items.push(timelineStopItem(city));   // 城市标注在抵达段之前
    items.push(timelineLegItem(leg));
  }
  return items;
}
function renderTimeline() {
  const el = document.getElementById('timeline');
  if (!TRIPS.length) { el.innerHTML = '<p class="empty">暂无行程，去「录入」添加吧。</p>'; return; }
  const trips = [...TRIPS].sort((a, b) => (b.dateStart || '').localeCompare(a.dateStart || ''));
  el.innerHTML = trips.map(trip => {
    const items = timelineTripItems(trip);
    // 手动拖动顺序优先；之后新增的条目按默认顺序补在末尾，不会打乱已排好的部分。
    let ordered = items;
    const saved = _timelineOrders[trip.id];
    if (Array.isArray(saved) && saved.length) {
      const byKey = new Map(items.map(i => [i.key, i]));
      const seen = new Set();
      ordered = [];
      saved.forEach(k => { const it = byKey.get(k); if (it && !seen.has(k)) { seen.add(k); ordered.push(it); } });
      items.forEach(it => { if (!seen.has(it.key)) ordered.push(it); });
    }
    const body = ordered.length
      ? ordered.map(i => `<div class="tl-item" draggable="true" data-key="${i.key}" title="拖动可调整顺序">${i.html}</div>`).join('')
      : '<p class="empty">该行程暂无交通段；城市会显示在抵达它的交通段前面。</p>';
    const tripStops = STOPS.filter(s => s.tripId === trip.id);
    const uniqCities = uniqueCityCount(tripStops);
    const cityText = tripStops.length > uniqCities ? `${uniqCities} 城市 / ${tripStops.length} 次到访` : `${uniqCities} 城市`;
    const meta = `${fmt(trip.dateStart)}${trip.dateEnd ? ' ~ ' + fmt(trip.dateEnd) : ''}｜${cityText} / ${LEGS.filter(l=>l.tripId===trip.id).length} 交通段`;
    return `<div class="trip-group" data-trip-id="${esc(trip.id)}"><div class="trip-title">${esc(trip.title)}</div>`
      + `<div class="trip-meta">${meta}</div>${body}</div>`;
  }).join('');
}

/* ---- 时间线拖动排序（桌面端 HTML5 拖放，顺序存本机 config） ---- */
let _tlDrag = null;
function clearTimelineDropMarks() {
  document.querySelectorAll('#timeline .tl-item.drop-before, #timeline .tl-item.drop-after')
    .forEach(el => el.classList.remove('drop-before', 'drop-after'));
}
function bindTimelineDrag() {
  const el = document.getElementById('timeline');
  if (!el || el._dragBound) return;
  el._dragBound = true;
  el.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.tl-item');
    const group = item && item.closest('.trip-group');
    if (!item || !group) return;
    _tlDrag = { item, group, tripId: group.dataset.tripId };
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', item.dataset.key || ''); } catch (err) { /* 忽略 */ }
  });
  el.addEventListener('dragover', (e) => {
    if (!_tlDrag) return;
    const target = e.target.closest('.tl-item');
    if (!target || target === _tlDrag.item || target.parentElement !== _tlDrag.group) { clearTimelineDropMarks(); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    clearTimelineDropMarks();
    target.classList.add(after ? 'drop-after' : 'drop-before');
    _tlDrag.target = target;
    _tlDrag.after = after;
  });
  el.addEventListener('drop', async (e) => {
    if (!_tlDrag) return;
    e.preventDefault();
    const { item, group, tripId, target, after } = _tlDrag;
    if (target && target !== item && target.parentElement === group) {
      if (after) target.after(item); else target.before(item);
    }
    item.classList.remove('dragging');
    clearTimelineDropMarks();
    _tlDrag = null;
    const keys = [...group.querySelectorAll(':scope > .tl-item')].map(x => x.dataset.key).filter(Boolean);
    if (!keys.length) return;
    _timelineOrders[tripId] = keys;
    try {
      await DB.putConfig({ key: 'timelineOrder:' + tripId, value: keys });
      toast('时间线顺序已保存');
    } catch (err) {
      console.warn('[footprint] 时间线顺序保存失败：', err);
      toast('顺序保存失败，刷新后会恢复');
    }
  });
  el.addEventListener('dragend', () => {
    if (_tlDrag && _tlDrag.item) _tlDrag.item.classList.remove('dragging');
    clearTimelineDropMarks();
    _tlDrag = null;
  });
}

/* ===== 录入下拉 & 数据列表 ===== */
function refreshSelects() {
  const tripOptions = TRIPS.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
  const stopOptions = STOPS.map(s => `<option value="${s.id}">${esc(stopVisitLabel(s))}（${esc(s.city || s.region || '?')}）</option>`).join('');

  const tripReq = tripOptions || '<option value="" disabled>请先添加行程</option>';
  // 重新灌选项时保留当前选中行程：编辑既有交通段/城市时，后台 reload 不能把表单打回第一个行程；
  // 原行程/城市已删除时也保留原 id，避免编辑时被静默改到别的行程。
  document.querySelectorAll('#form-stop select[name="tripId"], #form-leg select[name="tripId"]')
    .forEach(s => {
      const prev = s.value;
      s.innerHTML = tripReq;
      if (prev && s.querySelector(`option[value="${prev}"]`)) s.value = prev;
      else if (prev) {
        const o = document.createElement('option');
        o.value = prev;
        o.textContent = '（原行程已删除）';
        s.appendChild(o);
        s.value = prev;
      }
    });

  // Leg 起止城市下拉：按到访年份分组/筛选 + 保留当前选择
  refreshLegYearFilter();
  refreshLegCitySelects();

  const dTrip = document.querySelector('#form-diary select[name="tripId"]');
  if (dTrip) dTrip.innerHTML = '<option value="">不关联行程</option>' + tripOptions;
  const dStop = document.querySelector('#form-diary select[name="stopId"]');
  if (dStop) dStop.innerHTML = '<option value="">不关联城市</option>' + stopOptions;

  updateLegManualVisibility();
  updateStopVisitHint();
  // 城市预设改为可搜索选择器（initCityPicker），不再用下拉注入
}

// Leg 起止城市选项：常驻城市置顶 → 按到访年份分组（新→旧，未知最后）→ 手动输入
function legCityOptions() {
  const year = _legYearFilter;   // '' = 全部，'__unknown__' = 日期未知，其余 = YYYY
  const pool = STOPS.filter(s => {
    if (!year) return true;
    if (year === '__unknown__') return !stopYear(s);
    return stopYear(s) === year;
  });
  const byYear = new Map();
  pool.forEach(s => {
    const y = stopYear(s) || '';
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(s);
  });
  const groups = [...byYear.entries()]
    .sort((a, b) => yearSort(a[0], b[0]))
    .map(([y, list]) => {
      list.sort((a, b) =>
        (a.arriveDate || a.leaveDate || '9999').localeCompare(b.arriveDate || b.leaveDate || '9999')
        || String(a.id).localeCompare(String(b.id)));
      return `<optgroup label="${y ? y + ' 年' : '日期未知'}">`
        + list.map(s => `<option value="${s.id}">${esc(stopVisitLabel(s))}</option>`).join('')
        + `</optgroup>`;
    }).join('');
  return `<optgroup label="🏠 常驻城市"><option value="home">🏠 ${esc(HOME_CITY.name)}（常驻）</option></optgroup>`
    + (groups || `<optgroup label="📍 已访城市"><option value="" disabled>${year ? year + ' 年暂无城市，可换年份或手动输入' : '暂无城市，可手动输入'}</option></optgroup>`)
    + `<option value="__manual">✍️ 手动输入城市…</option>`;
}

// 年份筛选下拉：全部年份 + 各年（含到访次数），年份变化时重建交通段城市下拉
function refreshLegYearFilter() {
  const sel = document.getElementById('leg-year-filter');
  if (!sel) return;
  const counts = new Map();
  STOPS.forEach(s => {
    const y = stopYear(s) || '';
    counts.set(y, (counts.get(y) || 0) + 1);
  });
  const years = [...counts.keys()].sort(yearSort);
  if (_legYearFilter === '__unknown__') { if (!counts.has('')) _legYearFilter = ''; }
  else if (_legYearFilter && !counts.has(_legYearFilter)) _legYearFilter = '';
  sel.innerHTML = `<option value="">全部年份（${STOPS.length}）</option>`
    + years.map(y => `<option value="${y || '__unknown__'}">${y ? y + ' 年' : '日期未知'}（${counts.get(y)}）</option>`).join('');
  sel.value = _legYearFilter;
}

// 重建交通段起止城市下拉；被年份筛选排除的已选城市放到“当前选择”里保留，不清空
function refreshLegCitySelects() {
  const f = document.getElementById('form-leg');
  if (!f) return;
  const edLeg = _editingLegId ? LEGS.find(l => l.id === _editingLegId) : null;
  const opts = legCityOptions();
  [['fromStopId', 'from'], ['toStopId', 'to']].forEach(([name, end]) => {
    const s = f[name];
    if (!s) return;
    const prev = s.value;
    s.innerHTML = opts;
    if (prev && s.querySelector(`option[value="${prev}"]`)) { s.value = prev; return; }
    if (!prev || prev === 'home' || prev === '__manual') return;
    const stop = stopById(prev);
    const og = document.createElement('optgroup');
    og.label = '当前选择';
    const o = document.createElement('option');
    o.value = prev;
    if (stop) {
      o.textContent = stopVisitLabel(stop);
    } else {
      // 编辑的段引用了已删除的城市：保留原 stopId，别回退成别的城市/空白手动输入
      const raw = edLeg && edLeg[end];
      const nm = (raw && raw.name) || (edLeg && edLeg[end + 'Name']) || '';
      o.dataset.name = nm;
      o.textContent = nm ? `（城市已删除：${nm}）` : '（城市已删除）';
    }
    og.appendChild(o);
    s.appendChild(og);
    s.value = prev;
  });
  updateLegManualVisibility();
}

// 手动输入区显隐：选中"手动输入"时显示对应端的名称/经纬度填写框
function updateLegManualVisibility() {
  const f = document.getElementById('form-leg');
  if (!f) return;
  const mf = document.getElementById('leg-manual-from');
  const mt = document.getElementById('leg-manual-to');
  if (mf) mf.hidden = f.fromStopId.value !== '__manual';
  if (mt) mt.hidden = f.toStopId.value !== '__manual';
}
// 从表单读取一个端点（kind: home/stop/custom）；custom 坐标可空（缺坐标不画线）
function legFormEndpoint(f, end) {
  const v = f[end + 'StopId'].value;
  if (v === 'home') return { kind: 'home', name: HOME_CITY.name };
  if (v === '__manual') {
    const name = f[end + 'Name'].value.trim();
    if (!name) return null;
    const lat = f[end + 'Lat'].value, lng = f[end + 'Lng'].value;
    return { kind: 'custom', name, lat: lat === '' ? null : Number(lat), lng: lng === '' ? null : Number(lng) };
  }
  if (!v) return null;
  const opt = f[end + 'StopId'].selectedOptions && f[end + 'StopId'].selectedOptions[0];
  return { kind: 'stop', stopId: v, name: (stopById(v) || {}).nameZh || (opt && opt.dataset.name) || v };
}
function resetLegForm() {
  _editingLegId = null;
  _legDirty = false;
  _legAutoArrive = '';
  const f = document.getElementById('form-leg');
  f.reset();
  updateLegManualVisibility();
  syncReturnBtn();
}
// "添加返程"按钮：进入编辑态即可直接点击（不必先改字段）
function syncReturnBtn() {
  const btn = document.getElementById('btn-add-return');
  if (!btn) return;
  btn.hidden = !_editingLegId;
  btn.disabled = !_editingLegId;
}

/* ===== 已有数据：按行程折叠（城市/到访 + 交通段收在行程下面） ===== */
const TRIP_EXPAND_PREFIX = 'footprint-trip-expanded:';
function isTripExpanded(id) {
  try {
    const v = localStorage.getItem(TRIP_EXPAND_PREFIX + id);
    if (v === null) return id === '__orphan__';   // 未归属数据默认展开，避免“地图上有线但列表里找不到”
    return v === '1';
  } catch (e) { return false; }
}
function setTripExpanded(id, expanded) {
  try { localStorage.setItem(TRIP_EXPAND_PREFIX + id, expanded ? '1' : '0'); }
  catch (e) { /* 忽略本地存储失败 */ }
}
function setAllTripGroups(expanded) {
  TRIPS.forEach(t => setTripExpanded(t.id, expanded));
  setTripExpanded('__orphan__', expanded);
  renderLists();
}
function listStopRow(s) {
  return `<div class="tg-item">`
    + `<span class="txt"><b>📍 ${esc(stopVisitLabel(s))}</b>`
    + `<div class="sub">${fmt(s.region || s.city)}｜${s.lat}, ${s.lng}｜📷 ${photoCount(s.id)}</div>`
    + `<div class="sub">${fmt(s.arriveDate)}${s.leaveDate ? ' ~ ' + fmt(s.leaveDate) : ''}｜${money(s.cost)}${s.mood ? '｜心情 ' + esc(s.mood) : ''}${s.companions ? '｜同行 ' + esc(s.companions) : ''}</div>`
    + (s.note ? `<div class="sub">${esc(s.note)}</div>` : '')
    + `</span><span class="tg-ops">`
    + `<button class="small ghost" data-photos="${s.id}">照片</button>`
    + `<button class="small ghost" data-revisit="${s.id}">＋再次到访</button>`
    + `<button class="small ghost" data-edit="stop" data-id="${s.id}">编辑</button>`
    + `<button class="small" data-del="stop" data-id="${s.id}">删除</button>`
    + `</span></div>`;
}
function listLegRow(l) {
  const st = legStyle(l.mode);
  const meta = [legTimeLine(l), l.cost == null ? '' : money(l.cost)].filter(Boolean).join('｜') || '—';
  return `<div class="tg-item">`
    + `<span class="txt"><b>${st.icon} ${st.label}</b>：${esc(legEndpointLabel(l, 'from'))} → ${esc(legEndpointLabel(l, 'to'))}`
    + `<div class="sub">${meta}</div>`
    + (l.note ? `<div class="sub">${esc(l.note)}</div>` : '')
    + `</span><span class="tg-ops">`
    + `<button class="small ghost" data-edit="leg" data-id="${l.id}">编辑</button>`
    + `<button class="small" data-del="leg" data-id="${l.id}">删除</button>`
    + `</span></div>`;
}
function tripGroupHtml(trip, stops, legs) {
  const id = trip ? trip.id : '__orphan__';
  const expanded = isTripExpanded(id);
  const uniq = uniqueCityCount(stops);
  const cityText = stops.length > uniq ? `${uniq} 城市 / ${stops.length} 次到访` : `${uniq} 城市`;
  const counts = `${cityText} · ${legs.length} 交通段`;
  const title = trip ? `🧳 ${esc(trip.title)}` : '🗂 未归属行程 / 数据';
  const meta = trip
    ? `${fmt(trip.dateStart)}${trip.dateEnd ? ' ~ ' + fmt(trip.dateEnd) : ''}｜${counts}`
    : counts;
  const actions = trip
    ? `<span class="tg-actions"><button class="small ghost" data-edit="trip" data-id="${trip.id}">编辑</button>`
      + `<button class="small" data-del="trip" data-id="${trip.id}">删除</button></span>`
    : (legs.length
      ? `<span class="tg-actions"><button class="small ghost" data-clean-orphan-legs="1">🧹 清理无主交通段</button></span>`
      : '');
  const sortedStops = stops.slice().sort((a, b) =>
    (a.arriveDate || a.leaveDate || '9999').localeCompare(b.arriveDate || b.leaveDate || '9999')
    || String(a.id).localeCompare(String(b.id)));
  const bodyParts = [];
  if (sortedStops.length) {
    bodyParts.push(`<div class="tg-section-title">城市 / 到访（${sortedStops.length}）</div>`);
    bodyParts.push(sortedStops.map(listStopRow).join(''));
  }
  if (legs.length) {
    bodyParts.push(`<div class="tg-section-title">交通段（${legs.length}）</div>`);
    bodyParts.push(legs.map(listLegRow).join(''));
  }
  const body = bodyParts.length
    ? bodyParts.join('')
    : '<p class="empty">该行程还没有城市或交通段。</p>';
  return `<div class="trip-group-card">`
    + `<div class="trip-group-head${expanded ? ' expanded' : ''}" data-trip-toggle="${esc(id)}">`
    + `<span class="tg-chevron">${expanded ? '▾' : '▸'}</span>`
    + `<div class="tg-head-main">`
    + `<div class="tg-title-row"><span class="tg-title">${title}</span>${actions}</div>`
    + `<div class="tg-meta">${meta}</div>`
    + `</div></div>`
    + `<div class="trip-group-body"${expanded ? '' : ' hidden'}>${body}</div>`
    + `</div>`;
}
function renderLists() {
  const el = document.getElementById('list-groups');
  if (!el) return;
  const tripIds = new Set(TRIPS.map(t => t.id));
  const trips = [...TRIPS].sort((a, b) =>
    (b.dateEnd || b.dateStart || '').localeCompare(a.dateEnd || a.dateStart || '')
    || String(a.title || '').localeCompare(String(b.title || '')));
  const groups = trips.map(t => {
    const stops = STOPS.filter(s => s.tripId === t.id);
    const legs = orderedTripLegs(t.id);   // 与时间线/播放保持同一顺序
    return tripGroupHtml(t, stops, legs);
  });
  const orphanStops = STOPS.filter(s => !s.tripId || !tripIds.has(s.tripId))
    .sort((a, b) => (a.arriveDate || '9999').localeCompare(b.arriveDate || '9999'));
  const orphanLegs = LEGS.filter(l => !l.tripId || !tripIds.has(l.tripId))
    .sort((a, b) => (a.departAt || '9999').localeCompare(b.departAt || '9999'));
  if (orphanStops.length || orphanLegs.length) groups.push(tripGroupHtml(null, orphanStops, orphanLegs));
  el.innerHTML = groups.length ? groups.join('') : '<p class="empty">暂无行程，先去上方新增吧。</p>';
}
function bindListGroups() {
  const el = document.getElementById('data-lists');
  if (!el || el._groupBound) return;
  el._groupBound = true;
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-expand-all]')) { setAllTripGroups(true); return; }
    if (e.target.closest('[data-collapse-all]')) { setAllTripGroups(false); return; }
    const head = e.target.closest('[data-trip-toggle]');
    if (!head || e.target.closest('button') || e.target.closest('.tg-actions')) return;
    const id = head.dataset.tripToggle;
    const group = head.closest('.trip-group-card');
    const body = group && group.querySelector('.trip-group-body');
    if (!body) return;
    const expand = body.hidden;
    body.hidden = !expand;
    head.classList.toggle('expanded', expand);
    const chev = head.querySelector('.tg-chevron');
    if (chev) chev.textContent = expand ? '▾' : '▸';
    setTripExpanded(id, expand);
  });
}

/* ===== 心情日记 ===== */
function renderDiaries() {
  const el = document.getElementById('diary-list');
  if (!el) return;
  if (!DIARIES.length) { el.innerHTML = '<p class="empty">暂无日记，写一条今天的碎碎念吧。</p>'; return; }
  const sorted = [...DIARIES].sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  el.innerHTML = sorted.map(d => {
    const trip = d.tripId ? (TRIPS.find(t => t.id === d.tripId) || {}).title : '';
    const stop = d.stopId ? stopById(d.stopId) : null;
    const link = [trip ? '🧳 ' + esc(trip) : '', stop ? '📍 ' + esc(stopVisitLabel(stop)) : ''].filter(Boolean).join('｜');
    const note = d.note || '';
    const snippet = esc(note.slice(0, 60)) + (note.length > 60 ? '…' : '');
    return `<div class="data-block diary-item">`
      + `<div class="diary-head"><span class="diary-mood">${esc(d.mood || '')}</span><b>${fmt(d.date)}</b>`
      + `<span><button class="small ghost" data-diary-edit="${d.id}">编辑</button> `
      + `<button class="small" data-diary-del="${d.id}">删除</button></span></div>`
      + `<div class="sub">天气：${fmt(d.weather)}${link ? '｜' + link : ''}</div>`
      + `<div class="diary-note">${snippet || '<span class="sub">（无内容）</span>'}</div>`
      + `</div>`;
  }).join('');
}

function fillDiaryForm(d) {
  const f = document.getElementById('form-diary');
  f.date.value = d.date || '';
  f.querySelectorAll('input[name="mood"]').forEach(r => { r.checked = (r.value === d.mood); });
  f.weather.value = d.weather || '';
  f.note.value = d.note || '';
  f.tripId.value = d.tripId || '';
  f.stopId.value = d.stopId || '';
  _editingDiaryId = d.id;
  document.getElementById('btn-diary-cancel').hidden = false;
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function resetDiaryForm() {
  const f = document.getElementById('form-diary');
  f.reset();
  _editingDiaryId = null;
  document.getElementById('btn-diary-cancel').hidden = true;
}

/* ===== 已有数据编辑（Trip / 城市 / Leg） ===== */
const SAVE_LABELS = { trip: '保存行程', stop: '保存城市', leg: '保存交通段', wish: '保存心愿' };
function setEditState(kind, name) {
  const banner = document.getElementById('edit-banner-' + kind);
  const nameEl = document.getElementById('edit-name-' + kind);
  const saveBtn = document.getElementById('btn-save-' + kind);
  if (nameEl) nameEl.textContent = name || '';
  if (banner) banner.hidden = !name;
  if (saveBtn) saveBtn.textContent = name ? '保存修改' : SAVE_LABELS[kind];
}
// 取消编辑/保存完成：清空表单回到新增状态
function exitEditMode(kind) {
  if (kind === 'trip') {
    _editingTripId = null;
    document.getElementById('form-trip').reset();
  } else if (kind === 'stop') {
    _editingStopId = null;
    document.getElementById('form-stop').reset();
    setStopColorSelection(DEFAULT_MARKER_COLOR);
    clearCityPicker();
    updateStopVisitHint();
  } else if (kind === 'leg') {
    resetLegForm();
  } else if (kind === 'wish') {
    _editingWishId = null;
    document.getElementById('form-wish').reset();
    clearWishCityPicker();
  }
  setEditState(kind, '');
}
function startEditTrip(id) {
  const t = TRIPS.find(x => x.id === id); if (!t) return;
  _editingTripId = id;
  const f = document.getElementById('form-trip');
  f.title.value = t.title || '';
  f.dateStart.value = t.dateStart || '';
  f.dateEnd.value = t.dateEnd || '';
  f.dateEnd.min = t.dateStart || '';
  f.note.value = t.note || '';
  setEditState('trip', t.title);
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function startEditStop(id) {
  const s = STOPS.find(x => x.id === id); if (!s) return;
  _editingStopId = id;
  const f = document.getElementById('form-stop');
  f.tripId.value = s.tripId || '';
  const inp = document.getElementById('city-preset-input');
  if (inp) inp.value = '';
  f.nameZh.value = s.nameZh || '';
  f.nameEn.value = s.nameEn || '';
  f.country.value = s.country || '';
  f.region.value = s.region || '';
  f.city.value = s.city || '';
  f.lat.value = s.lat; f.lng.value = s.lng;
  f.arriveDate.value = s.arriveDate || '';
  f.leaveDate.value = s.leaveDate || '';
  f.weather.value = s.weather || '';
  f.mood.value = s.mood || '';
  f.cost.value = (s.cost == null ? '' : s.cost);
  f.companions.value = s.companions || '';
  f.note.value = s.note || '';
  setStopColorSelection(s.markerColor || DEFAULT_MARKER_COLOR);
  setEditState('stop', stopVisitLabel(s));
  updateStopVisitHint();
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// 再次到访：带入城市基本信息，日期/同行人/心情/花费/备注留空，保存后是一条新的独立到访
function startRevisit(stopId) {
  const s = STOPS.find(x => x.id === stopId); if (!s) return;
  exitEditMode('stop');   // 清空表单并退出编辑态
  const f = document.getElementById('form-stop');
  if (s.tripId && f.tripId.querySelector(`option[value="${s.tripId}"]`)) f.tripId.value = s.tripId;
  f.nameZh.value = s.nameZh || '';
  f.nameEn.value = s.nameEn || '';
  f.country.value = s.country || '';
  f.region.value = s.region || '';
  f.city.value = s.city || '';
  f.lat.value = s.lat;
  f.lng.value = s.lng;
  setStopColorSelection(s.markerColor || DEFAULT_MARKER_COLOR);
  openDrawer('entry');
  updateStopVisitHint();
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(`已带入「${s.nameZh}」的基本信息；保存后会新增一次独立到访`);
}
function startEditLeg(id) {
  const l = LEGS.find(x => x.id === id); if (!l) return;
  _editingLegId = id;
  const f = document.getElementById('form-leg');
  const tripId = l.tripId || '';
  if (!tripId) {
    if (!f.tripId.querySelector('option[value=""]')) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '（未归属行程）';
      f.tripId.appendChild(o);
    }
  } else if (!f.tripId.querySelector(`option[value="${tripId}"]`)) {
    // 原行程已删除：保留原 tripId，编辑保存时不会被改到第一个行程
    const o = document.createElement('option');
    o.value = tripId;
    o.textContent = '（原行程已删除）';
    f.tripId.appendChild(o);
  }
  f.tripId.value = tripId;
  const opts = legCityOptions();   // 编辑回填：先灌选项再按端点类型选值
  f.fromStopId.innerHTML = opts;
  f.toStopId.innerHTML = opts;
  ['from', 'to'].forEach(end => {
    const sel = f[end + 'StopId'];
    const e = l[end];
    sel.value = '';
    f[end + 'Name'].value = '';
    f[end + 'Lat'].value = '';
    f[end + 'Lng'].value = '';
    if (e && e.kind === 'home') {
      sel.value = 'home';
    } else if (e && e.kind === 'custom') {
      sel.value = '__manual';
      f[end + 'Name'].value = e.name || '';
      f[end + 'Lat'].value = (e.lat == null ? '' : e.lat);
      f[end + 'Lng'].value = (e.lng == null ? '' : e.lng);
    } else {
      const sid = (e && e.kind === 'stop') ? e.stopId : l[end + 'StopId'];   // 旧结构兼容
      if (sid && sel.querySelector(`option[value="${sid}"]`)) {
        sel.value = sid;
      } else if (sid) {
        // 站点已被删除：保留原 stopId，显示为“已删除城市”，不要静默换成别的城市
        const nm = (e && e.name) || l[end + 'Name'] || '';
        const o = document.createElement('option');
        o.value = sid;
        o.dataset.name = nm;
        o.textContent = nm ? `（城市已删除：${nm}）` : '（城市已删除）';
        sel.appendChild(o);
        sel.value = sid;
      } else {
        sel.value = '__manual';   // 旧数据没有站点 id：手动补填
      }
    }
  });
  updateLegManualVisibility();
  f.mode.value = l.mode || 'plane';
  const [depDate, depClock] = splitLegTime(l.departAt);
  const [arrDate, arrClock] = splitLegTime(l.arriveAt);
  f.departDate.value = depDate;
  f.departClock.value = depClock;
  f.arriveDate.value = arrDate;
  f.arriveClock.value = arrClock;
  // 编辑已有段：若到达端原与出发端相同，改出发端时保持两者联动
  _legAutoArrive = (l.departAt && l.arriveAt && l.arriveAt === l.departAt) ? l.arriveAt : '';
  f.cost.value = (l.cost == null ? '' : l.cost);
  f.note.value = l.note || '';
  setEditState('leg', legEndpointLabel(l, 'from') + ' → ' + legEndpointLabel(l, 'to'));
  _legDirty = false;
  syncReturnBtn();   // 编辑态显示返程按钮（可直接点击）
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ===== 心愿清单 Wishlist ===== */
// 中文模糊匹配：连续子串 或 关键字按序子序列
function fuzzyHit(text, kw) {
  if (!kw) return true;
  const t = String(text).toLowerCase();
  if (t.includes(kw)) return true;
  let i = 0;
  for (const ch of kw) { i = t.indexOf(ch, i); if (i < 0) return false; i++; }
  return true;
}
function wishProgressPct(w) {
  if (!w.budget || w.budget <= 0) return w.saved > 0 ? 100 : 0;
  return Math.min(100, Math.round(w.saved / w.budget * 100));
}
function wishBarHtml(w) {
  if (!w.budget || w.budget <= 0) return '';
  return `<div class="wish-bar"><div class="wish-fill" style="width:${wishProgressPct(w)}%"></div></div>`;
}
// 未完成按 order 升序在前，完成沉底
function wishSorted() {
  return [...WISHES].sort((a, b) =>
    (a.done === b.done) ? ((a.order || 0) - (b.order || 0)) : (a.done ? 1 : -1));
}
function renderWishSummary() {
  const el = document.getElementById('wish-summary');
  if (!el) return;
  const want = WISHES.filter(w => !w.done).length;
  const budget = WISHES.reduce((s, w) => s + (Number(w.budget) || 0), 0);
  const saved = WISHES.reduce((s, w) => s + (Number(w.saved) || 0), 0);
  const pct = budget > 0 ? Math.min(100, Math.round(saved / budget * 100)) : 0;
  el.innerHTML = `想去 <b>${want}</b> 个 · 总预算 <b>¥${budget.toLocaleString()}</b> · 已攒 <b>¥${saved.toLocaleString()}</b>`
    + `<div class="wish-bar wish-bar-lg"><div class="wish-fill" style="width:${pct}%"></div></div>`;
}
function renderWishList() {
  const el = document.getElementById('list-wishes');
  if (!el) return;
  if (!WISHES.length) { el.innerHTML = '<p class="empty">还没有心愿，添加一个想去的地方吧。</p>'; return; }
  el.innerHTML = wishSorted().map(w => {
    const tags = [];
    if (w.region || w.city) tags.push(esc([w.region, w.city].filter(Boolean).join(' / ')));
    if (w.targetDate) tags.push('🗓 ' + esc(w.targetDate));
    const hasCoord = !(w.lat == null || w.lat === '' || w.lng == null || w.lng === '');
    if (!hasCoord) tags.push('📍 地图未标记（编辑补选城市坐标）');
    const pct = wishProgressPct(w);
    return `<div class="data-block wish-row${w.done ? ' wish-done' : ''}">`
      + `<input type="checkbox" class="wish-check" data-wish-check="${w.id}"${w.done ? ' checked' : ''} title="标记完成">`
      + `<span class="txt wish-txt"><b>${esc(w.nameZh)}</b>`
      + (tags.length ? `<div class="sub">${tags.join('｜')}</div>` : '')
      + (w.note ? `<div class="sub">${esc(w.note)}</div>` : '')
      + `</span>`
      + `<span class="wish-money">¥${(Number(w.saved) || 0).toLocaleString()} / ¥${(Number(w.budget) || 0).toLocaleString()}${wishBarHtml(w)}</span>`
      + `<span class="wish-ops">`
      + `<button class="small ghost" data-wish-move="${w.id}" data-dir="-1" title="上移">↑</button>`
      + `<button class="small ghost" data-wish-move="${w.id}" data-dir="1" title="下移">↓</button>`
      + `<button class="small ghost" data-wish-edit="${w.id}">编辑</button>`
      + `<button class="small" data-wish-del="${w.id}">删除</button></span></div>`;
  }).join('');
}
// 心愿星标：空心星形（琥珀描边，完成变灰），独立图层组
function wishStarIcon(w) {
  const stroke = w.done ? '#9aa0a6' : '#C99A45';
  return L.divIcon({
    className: 'wish-star-icon',
    html: `<svg width="26" height="26" viewBox="0 0 24 24"><path d="M12 2.5l2.9 6.2 6.8.6-5.1 4.5 1.5 6.7-6.1-3.6-6.1 3.6 1.5-6.7-5.1-4.5 6.8-.6z" fill="rgba(255,255,255,0)" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/></svg>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
}
function wishPopupHtml(w) {
  const rows = [];
  if (w.region || w.city) rows.push(esc([w.region, w.city].filter(Boolean).join(' / ')));
  if (w.targetDate) rows.push('🗓 计划: ' + esc(w.targetDate));
  if (w.budget) rows.push('💰 预算: ¥' + Number(w.budget).toLocaleString());
  if (w.saved) rows.push('🏦 已攒: ¥' + Number(w.saved).toLocaleString());
  if (w.note) rows.push('📝 ' + esc(w.note));
  rows.push(w.done ? '✅ 已完成' : '⭐ 想去');
  return `<b>${esc(w.nameZh)}</b><br>${rows.join('<br>')}${wishBarHtml(w)}`;
}
function renderWishMarkers() {
  if (!_wishGroup) return;
  _wishGroup.clearLayers();
  // 按坐标分组：同地点多条心愿横向散开，避免星星完全重叠看似只标了一处
  const groups = new Map();
  WISHES.forEach(w => {
    if (w.lat == null || w.lng == null || w.lat === '' || w.lng === '') return;
    const lat = Number(w.lat), lng = Number(w.lng);
    if (isNaN(lat) || isNaN(lng)) return;
    const key = lat.toFixed(3) + ',' + lng.toFixed(3);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ w, lat, lng });
  });
  groups.forEach(list => {
    const n = list.length;
    list.forEach((it, i) => {
      const off = n > 1 ? (i - (n - 1) / 2) * 2.4 : 0;   // 同点多条时经度散开（度）
      L.marker([it.lat, it.lng + off], { icon: wishStarIcon(it.w) })
        .bindPopup(() => wishPopupHtml(it.w))
        .addTo(_wishGroup);
    });
  });
}
function renderWishes() {
  renderWishSummary();
  renderWishList();
  renderWishMarkers();
}
// 上移/下移：交换相邻两条未完成心愿的 order
async function moveWish(id, dir) {
  const vis = wishSorted().filter(w => !w.done);
  const idx = vis.findIndex(w => w.id === id);
  const j = idx + dir;
  if (idx < 0 || j < 0 || j >= vis.length) return;
  const a = vis[idx], b = vis[j];
  const t = (a.order || 0);
  a.order = (b.order || 0);
  b.order = (t === a.order) ? a.order + 1 : t;   // 防止交换后相等
  await DB.putWish(a); await DB.putWish(b);
  WISHES = await DB.getWishlist();
  renderWishes();
}
// 心愿城市预设（可搜索，回填省/市/经纬度，允许不填坐标）
function clearWishCityPicker() {
  const inp = document.getElementById('wish-city-input');
  const list = document.getElementById('wish-city-list');
  if (inp) inp.value = '';
  if (list) list.hidden = true;
}
function initWishCityPicker() {
  const input = document.getElementById('wish-city-input');
  const list = document.getElementById('wish-city-list');
  if (!input || !list || !window.CITIES) return;
  const byProv = new Map();
  window.CITIES.forEach(c => {
    if (!byProv.has(c.province)) byProv.set(c.province, []);
    byProv.get(c.province).push(c);
  });
  function renderW(keyword) {
    const kw = (keyword || '').trim().toLowerCase();
    let html = '';
    let count = 0;
    byProv.forEach((arr, prov) => {
      const hits = arr.filter(c => !kw || fuzzyHit(c.name, kw) || fuzzyHit(prov, kw));
      if (!hits.length) return;
      count += hits.length;
      html += `<div class="cp-group">${esc(prov)}</div>` + hits.map(c =>
        `<div class="cp-item" data-wname="${esc(c.name)}" data-wprov="${esc(c.province)}" data-wlat="${c.lat}" data-wlng="${c.lng}">`
        + `<span>${esc(c.name)}</span><span class="cp-coords">${c.lat.toFixed(2)}, ${c.lng.toFixed(2)}</span></div>`).join('');
    });
    if (!count && kw) html += '<div class="cp-empty">没有匹配的城市，可手动填写经纬度或留空</div>';
    list.innerHTML = html;
    list.hidden = false;
  }
  input.addEventListener('focus', () => renderW(input.value));
  input.addEventListener('input', () => renderW(input.value));
  list.addEventListener('click', (e) => {
    const item = e.target.closest('[data-wname]');
    if (!item) return;
    const f = document.getElementById('form-wish');
    const name = item.dataset.wname;
    f.city.value = name.replace(/市$/, '');
    f.region.value = item.dataset.wprov;
    f.lat.value = item.dataset.wlat;
    f.lng.value = item.dataset.wlng;
    if (!f.nameZh.value.trim()) f.nameZh.value = f.city.value;
    input.value = name;
    list.hidden = true;
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#wish-city-input') && !e.target.closest('#wish-city-list')) list.hidden = true;
  });
}
function bindWish() {
  initWishCityPicker();
  document.getElementById('form-wish').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const nameZh = f.nameZh.value.trim();
    if (!nameZh) { toast('请填写城市/地区名称'); return; }
    const budget = f.budget.value === '' ? null : Number(f.budget.value);
    const saved = f.saved.value === '' ? 0 : Number(f.saved.value);
    if (budget != null && (isNaN(budget) || budget < 0)) { toast('预估预算必须是非负数字'); return; }
    if (isNaN(saved) || saved < 0) { toast('已攒金额必须是非负数字'); return; }
    const wasEditing = !!_editingWishId;
    const old = wasEditing ? WISHES.find(w => w.id === _editingWishId) : null;
    const num = (v) => (v === '' ? null : Number(v));
    const rec = {
      id: _editingWishId || uid(),
      nameZh,
      country: '中国', region: f.region.value.trim(), city: f.city.value.trim(),
      lat: num(f.lat.value), lng: num(f.lng.value),
      note: f.note.value.trim(), budget, saved,
      targetDate: f.targetDate.value || '',
      order: old ? old.order : (Math.max(0, ...WISHES.map(w => w.order || 0)) + 1),
      done: old ? !!old.done : false,
      createdAt: old ? old.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await DB.putWish(rec);
    if (wasEditing) exitEditMode('wish'); else { f.reset(); clearWishCityPicker(); }
    await reload();
    toast(wasEditing ? '心愿已更新' : '心愿已保存');
  });
  document.getElementById('btn-edit-cancel-wish').addEventListener('click', () => exitEditMode('wish'));
  document.getElementById('list-wishes').addEventListener('click', async (e) => {
    const moveBtn = e.target.closest('[data-wish-move]');
    const editBtn = e.target.closest('[data-wish-edit]');
    const delBtn = e.target.closest('[data-wish-del]');
    if (moveBtn) { await moveWish(moveBtn.dataset.wishMove, Number(moveBtn.dataset.dir)); }
    else if (editBtn) {
      const w = WISHES.find(x => x.id === editBtn.dataset.wishEdit);
      if (!w) return;
      _editingWishId = w.id;
      const f = document.getElementById('form-wish');
      f.nameZh.value = w.nameZh || '';
      f.region.value = w.region || '';
      f.city.value = w.city || '';
      f.lat.value = (w.lat == null ? '' : w.lat);
      f.lng.value = (w.lng == null ? '' : w.lng);
      f.note.value = w.note || '';
      f.budget.value = (w.budget == null ? '' : w.budget);
      f.saved.value = (w.saved == null ? 0 : w.saved);
      f.targetDate.value = w.targetDate || '';
      clearWishCityPicker();
      setEditState('wish', w.nameZh);
      f.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (delBtn) {
      const id = delBtn.dataset.wishDel;
      if (!confirm('删除这条心愿？此操作不可撤销。')) return;
      await DB.delWish(id);
      if (_editingWishId === id) exitEditMode('wish');
      await reload();
      toast('心愿已删除');
    }
  });
  document.getElementById('list-wishes').addEventListener('change', async (e) => {
    const cb = e.target.closest('[data-wish-check]');
    if (!cb) return;
    const w = WISHES.find(x => x.id === cb.dataset.wishCheck);
    if (!w) return;
    w.done = cb.checked;
    w.updatedAt = new Date().toISOString();
    await DB.putWish(w);
    WISHES = await DB.getWishlist();
    renderWishes();
  });
}

/* ===== 轨迹播放（参考 mult.dev：全局时间轴 + 段内固定缩放 + 停留期变焦 + 低开销瓦片预取） =====
   性能要点：
   1) 行进段只平移不缩放，变焦放在城市停留期用 Leaflet 自带动画完成 → 大幅减少 zoomend / 瓦片重载；
   2) 播放中跳过标签避让与气泡显隐重算，收尾统一恢复；
   3) 预取只取目标级别、低优先级、限量并发，避免和可视瓦片抢带宽；
   4) 隐藏业务城市圆点/省界外轮廓，只保留播放图层。 */
let _playGroup = null, _play = null;
const DWELL_MS = 1000, END_MS = 1800, INTRO_MS = 1200, HOME_MS = 700, NO_MAP_MS = 1500;
const MIN_SEG_MS = 1800, MAX_SEG_MS = 8000;
const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function isHomeCoord(p) {
  return !!p && Math.abs(Number(p[0]) - HOME_CITY.lat) < 0.05 && Math.abs(Number(p[1]) - HOME_CITY.lng) < 0.05;
}
function isHomeCity(city) {
  if (!city) return false;
  if ((city.nameZh || '').trim() === (HOME_CITY.name || '').trim()) return true;
  return isHomeCoord([city.lat, city.lng]);
}
// 播放专用规范化端点：保留 stopId，名称/坐标复用静态 legEndpoint
function legPlayEndpoint(leg, end) {
  const raw = leg[end] || {};
  const resolved = legEndpoint(leg, end);
  if (!resolved) return null;
  return {
    kind: raw.kind,
    stopId: raw.stopId || null,
    name: resolved.name,
    lat: resolved.lat == null ? null : Number(resolved.lat),
    lng: resolved.lng == null ? null : Number(resolved.lng),
  };
}
// 端点是否命中某个行程城市：stopId 直配 → 名称归一化 → 坐标容差；任一端解析不出直接 false
function endpointHitsStop(r, stop) {
  if (!r || !stop) return false;
  if (r.stopId) return r.stopId === stop.id;   // stopId 直配最优先，禁止按名字跨行程猜
  const rn = normCity(String(r.name || '').trim());
  const sn = normCity(String(stop.nameZh || '').trim());
  if (rn && sn && rn === sn) return true;
  if (r.lat != null && r.lng != null && stop.lat != null && stop.lng != null) {
    return Math.abs(Number(r.lat) - Number(stop.lat)) < 0.05 && Math.abs(Number(r.lng) - Number(stop.lng)) < 0.05;
  }
  return false;
}
// 路径参数取点：t∈[0,1] → 坐标（段内线性插值，t 本身经 easeInOutCubic 缓动）
function pathPoint(pts, t) {
  const fi = t * (pts.length - 1), i0 = Math.floor(fi), frac = fi - i0;
  if (i0 >= pts.length - 1) return pts[pts.length - 1];
  return [pts[i0][0] + (pts[i0 + 1][0] - pts[i0][0]) * frac, pts[i0][1] + (pts[i0 + 1][1] - pts[i0][1]) * frac];
}
function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// 段时长随距离自适应：远距离给足时间，画面不会被瓦片加载甩开
function segDuration(a, b, mode) {
  const km = haversineKm(a, b);
  const factor = mode === 'plane' ? 1.2 : 1.8;
  return Math.round(Math.max(MIN_SEG_MS, Math.min(MAX_SEG_MS, 1500 + km * factor)));
}
// 缩放按城市间距自适应：区域视野（9 为主），瓦片量更低、更像 mult 的旅行路线视角
function playZoomFor(prev, cur) {
  if (!prev) return 9;
  const d = Math.hypot(cur.lat - prev.lat, cur.lng - prev.lng);
  if (d < 0.8) return 10;
  if (d < 3) return 9;
  if (d < 8) return 8;
  return 7;
}
function buildPath(A, B, mode) {
  if (mode === 'plane') {
    const ctrl = curveCtrl(A, B);
    return { pts: planeCurve(A, B, ctrl), ctrl };
  }
  if (isRailMode(mode)) {
    const ctrl = trackCtrl(A, B, 1);   // 轨道式：与地图连线一致（行进方向左偏）
    return { pts: planeCurve(A, B, ctrl), ctrl };
  }
  const pts = [], N = 24;               // 直线线性插值
  for (let k = 0; k <= N; k++) pts.push([A[0] + (B[0] - A[0]) * k / N, A[1] + (B[1] - A[1]) * k / N]);
  return { pts, ctrl: null };
}
// 取指定 Leg 的地图几何；若播放方向与 Leg 记录方向相反，把路径点倒过来，保证仍沿同一条线走
function orientedGeom(geom, leg, A, B) {
  const g = geom.get(leg.id);
  if (!g) return null;
  const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  if (same(g.A, A)) return g;
  if (same(g.B, A)) return { A: g.B, B: g.A, ctrl: g.ctrl, pts: g.pts.slice().reverse() };
  return g;
}
// 播放顺序以时间线为准：优先使用拖动保存的顺序；没手动排过的段按时间线默认顺序补在后面。
// 时间线上的城市条目只影响显示，不参与播放；播放单位始终是交通段。
function orderedTripLegs(tripId) {
  const legs = LEGS.filter(l => l.tripId === tripId);
  const byKey = new Map(legs.map(l => ['l:' + l.id, l]));
  const ordered = [], seen = new Set();
  const saved = _timelineOrders[tripId];
  if (Array.isArray(saved)) {
    saved.forEach(k => {
      if (typeof k !== 'string' || k.indexOf('l:') !== 0) return;
      const leg = byKey.get(k);
      if (leg && !seen.has(leg.id)) { seen.add(leg.id); ordered.push(leg); }
    });
  }
  timelineTripItems({ id: tripId }).forEach(item => {
    if (item.key.indexOf('l:') !== 0) return;
    const leg = byKey.get(item.key);
    if (leg && !seen.has(leg.id)) { seen.add(leg.id); ordered.push(leg); }
  });
  return ordered;
}
// 播放计划：严格按时间线上的排列（不看时间）逐段播放。
// 每一段交通段都会播放一次：重复城市、往返、甚至起止相同的段也照播，不补合成段。
// 有坐标的段沿地图连线动画；缺坐标的段只显示状态、镜头不动，但仍然占一次播放。
function buildPlayPlan(tripId) {
  const myLegs = orderedTripLegs(tripId);
  const geom = computeLegGeometries();   // 与地图连线共用同一套路径点/轨道偏移
  const seq = [], segs = [];
  const hasCoord = p => !!(p && p.lat != null && p.lng != null && isFinite(Number(p.lat)) && isFinite(Number(p.lng)));
  let lastPt = null;   // 上一个有坐标的抵达点，用于计算下一段的缩放
  myLegs.forEach((leg) => {
    const f = legPlayEndpoint(leg, 'from'), t = legPlayEndpoint(leg, 'to');
    const st = legStyle(leg.mode);
    const i = segs.length;
    const fromName = legEndpointShortLabel(leg, 'from') || '出发地';
    const toName = legEndpointShortLabel(leg, 'to') || '目的地';
    const A = hasCoord(f) ? [Number(f.lat), Number(f.lng)] : null;
    const B = hasCoord(t) ? [Number(t.lat), Number(t.lng)] : null;

    // 抵达点：行程内城市优先（带到达日期）；回常驻地标注“常驻地”；否则用端点名称
    const isHomeDest = !!(t && t.kind === 'home');
    const destStop = (isHomeDest || !t) ? null : STOPS.find(s => s.tripId === tripId && endpointHitsStop(t, s));
    const destName = isHomeDest ? ((HOME_CITY.name || '常驻地') + '（常驻地）')
      : (destStop ? stopVisitLabel(destStop) : toName);
    const destShort = isHomeDest ? ((HOME_CITY.name || '常驻地') + '（常驻地）')
      : (destStop ? stopVisitShort(destStop) : toName);
    const destPt = (destStop && hasCoord({ lat: destStop.lat, lng: destStop.lng }))
      ? [Number(destStop.lat), Number(destStop.lng)]
      : B;

    let pts = [], ctrl = null, segA = A, segB = B;
    const noMap = !(A && B);   // 起止缺任一端坐标：无法画线，但这一段仍然要播放
    if (!noMap) {
      const same = Math.abs(A[0] - B[0]) < 1e-6 && Math.abs(A[1] - B[1]) < 1e-6;
      if (same) {
        pts = [A, B];   // 起止相同：原地播放，不生成曲线（避免零向量算控制点）
      } else {
        const g = orientedGeom(geom, leg, A, B);
        if (g) { segA = g.A; segB = g.B; pts = g.pts; ctrl = g.ctrl; }
        else ({ pts, ctrl } = buildPath(A, B, leg.mode));
      }
    }
    const destObj = destPt ? { lat: destPt[0], lng: destPt[1] } : null;
    segs.push({
      hasLeg: true, legId: leg.id, noMap, pts, ctrl, mode: leg.mode,
      color: st.color, icon: st.icon, label: st.label,
      from: noMap ? null : segA, to: noMap ? null : segB,
      fromName, toName: destShort,
      ms: noMap ? NO_MAP_MS : segDuration(segA, segB, leg.mode),
      zoom: destObj ? playZoomFor(lastPt, destObj) : null,
    });
    seq.push({
      nameZh: destName,   // 城市到访标签已含“第 N 次 + 日期”，不再重复显示 arriveDate
      lat: destPt ? destPt[0] : null,
      lng: destPt ? destPt[1] : null,
      arriveDate: '',
      noCoords: !destPt,
    });
    if (destPt) lastPt = destObj;
    console.log('[footprint][play-diag] plan seg', i, {
      legId: leg.id, mode: leg.mode, from: fromName, to: destName,
      A: segA, B: segB, noMap, hasLeg: true,
    });
  });
  return { seq, segs };
}
// 全局时间轴：开场 → 每段「线生长+光点」→ 抵达点停留 → 收尾拉回行程视野
function buildTimeline(seq, segs) {
  const phases = []; let t = 0;
  phases.push({ type: 'intro', i: 0, start: 0, end: t += INTRO_MS });
  if (!seq.length) { phases.push({ type: 'end', start: t, end: t += END_MS }); return { phases, total: t }; }
  if (segs[0]) {
    if (isHomeCoord(segs[0].from) && !isHomeCity(seq[0])) phases.push({ type: 'home', depart: true, start: t, end: t += HOME_MS });
    phases.push({ type: 'seg', i: 0, start: t, end: t += segs[0].ms });
  }
  phases.push({ type: 'city', i: 0, start: t, end: t += DWELL_MS });
  for (let i = 1; i < seq.length; i++) {
    phases.push({ type: 'seg', i, start: t, end: t += segs[i].ms });
    phases.push({ type: 'city', i, start: t, end: t += DWELL_MS });
  }
  phases.push({ type: 'end', start: t, end: t += END_MS });
  return { phases, total: t };
}

/* ---- 瓦片预取：只补“镜头马上要到的地方”，低优先级 + 限量并发，避免抢可视瓦片带宽 ---- */
const _prefetched = new Set();
const _prefetchQueue = [];
let _prefetchActive = 0;
const PREFETCH_CONCURRENCY = 4;
const PREFETCH_QUEUE_MAX = 80;
function prefetchAllowed() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return true;
  if (c.saveData) return false;
  return !/^(slow-2g|2g)$/.test(c.effectiveType || '');
}
function pumpPrefetch() {
  while (_prefetchActive < PREFETCH_CONCURRENCY && _prefetchQueue.length) {
    const [z, x, y] = _prefetchQueue.shift();
    _prefetchActive++;
    const img = new Image();
    img.decoding = 'async';
    try { img.fetchPriority = 'low'; } catch (e) {}
    img.setAttribute('fetchpriority', 'low');
    img.onload = img.onerror = () => { _prefetchActive--; pumpPrefetch(); };
    const tpl = TILE_URLS[_theme] || TILE_URLS.light;
    img.src = tpl.replace('{s}', String((Math.abs(x + y) % 4) + 1)).replace('{x}', x).replace('{y}', y).replace('{z}', z);
  }
}
function prefetchTile(z, x, y) {
  if (!prefetchAllowed()) return 0;
  const max = Math.pow(2, z);
  if (x < 0 || x >= max || y < 0 || y >= max) return 0;
  const key = z + '/' + x + '/' + y;
  if (_prefetched.has(key) || _prefetchQueue.length >= PREFETCH_QUEUE_MAX) return 0;
  _prefetched.add(key);
  _prefetchQueue.push([z, x, y]);
  pumpPrefetch();
  return 1;
}
function tileXY(lat, lng, zoom) {
  const scale = Math.pow(2, zoom);
  const latRad = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
  const x = Math.floor((lng + 180) / 360 * scale);
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * scale);
  return [x, y];
}
function prefetchArea(lat, lng, zoom, radius = 1) {
  const [x, y] = tileXY(lat, lng, zoom);
  for (let dx = -radius; dx <= radius; dx++)
    for (let dy = -radius; dy <= radius; dy++) prefetchTile(zoom, x + dx, y + dy);
}
function prefetchTilesAlong(pts, zoom, maxSamples = 10) {
  if (!pts || !pts.length || zoom == null) return;
  const step = Math.max(1, Math.floor(pts.length / maxSamples));
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    const [x, y] = tileXY(p[0], p[1], zoom);
    prefetchTile(zoom, x, y);
  }
  const last = pts[pts.length - 1];
  prefetchArea(last[0], last[1], zoom, 1);   // 终点两侧补边角
}
function prefetchTilesBounds(bounds, zoom, maxTiles = 20) {
  if (!bounds || zoom == null) return;
  const nw = bounds.getNorthWest(), se = bounds.getSouthEast();
  const [x0, y0] = tileXY(nw.lat, nw.lng, zoom);
  const [x1, y1] = tileXY(se.lat, se.lng, zoom);
  let n = 0;
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1) && n < maxTiles; x++) {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1) && n < maxTiles; y++) {
      n += prefetchTile(zoom, x, y);
      if (n >= maxTiles) break;
    }
  }
}

/* ---- 镜头 / 状态 ---- */
// 行进段内固定缩放，只平移；setView 每帧一次，但不再改变缩放 → 瓦片不会反复重载
function playCamera(latlng, zoom) {
  map.setView(latlng, zoom == null ? _play.zoom : zoom, { animate: false });
  if (zoom != null) _play.zoom = zoom;
}
function setPlayStatus(text) {
  const el = document.getElementById('play-status');
  if (el) el.textContent = text || '';
}
// Leaflet 的瓦片层默认在每次 moveend（setView 每帧都会触发）里 _update；播放期改为 5 次/秒，
// 平移时地图像素位移很快，180ms 一次足够补上新进入视口的瓦片，但能把逐帧开销降一个数量级。
function throttleTileUpdates() {
  const st = _play;
  // 关键：Leaflet 注册的监听是 move → layer._onMove（节流版 _onMoveEnd）、moveend → layer._onMoveEnd。
  // 之前按 layer._update 移除，既移不掉原监听，恢复时又额外绑了一个签名不匹配的 _update：
  // _update 会把事件对象当成 center 传入，重播时直接抛错，导致第二次播放卡死。
  st.tileLayers = [_tileLight, _tileDark].filter(Boolean).map(layer => {
    if (layer._onMove) map.off('move', layer._onMove, layer);
    if (layer._onMoveEnd) map.off('moveend', layer._onMoveEnd, layer);
    return { layer };
  });
  st.tileAt = 0;
}
function restoreTileUpdates() {
  const st = _play;
  if (!st || !st.tileLayers) return;
  st.tileLayers.forEach(({ layer }) => {
    if (layer._onMove) map.on('move', layer._onMove, layer);
    if (layer._onMoveEnd) map.on('moveend', layer._onMoveEnd, layer);
    try { layer._update(); } catch (e) { /* 忽略 */ }
  });
  st.tileLayers = null;
}
function tickTileUpdates(now) {
  const st = _play;
  if (!st || !st.tileLayers) return;
  if (now - (st.tileAt || 0) < 180) return;
  st.tileAt = now;
  st.tileLayers.forEach(({ layer }) => {
    if (map.hasLayer(layer)) {
      try { layer._update(); } catch (e) { /* 忽略 */ }
    }
  });
}
function updatePlayFill() {
  const st = _play;
  const now = performance.now();
  if (st.fillAt && now - st.fillAt < 120) return;
  st.fillAt = now;
  const el = document.getElementById('play-fill');
  if (el) el.style.width = (st.total ? Math.min(100, st.t / st.total * 100) : 0).toFixed(2) + '%';
}
// 城市到达后旧光点淡出并移除，避免每段留下一个光点叠在城市圆点上
function fadePlayRunner() {
  const r = _play && _play.runner;
  if (!r) return;
  _play.runner = null;
  const el = r.getElement();
  const d = el && el.querySelector('.play-runner');
  if (d) d.classList.add('play-fade');
  setTimeout(() => { if (_playGroup && r) _playGroup.removeLayer(r); }, 650);
}
// 进入相位的一次性动作：建图层、切缩放、预取、状态文案
function enterPlayPhase(phase) {
  const st = _play;
  if (phase.type === 'city') {
    if (st.segLine && st.seg) {                       // 上一段收尾：线条补满 + 中点箭头淡入
      st.segLine.setLatLngs(st.seg.pts);
      if (st.seg.hasLeg) addPlayArrow(st.seg);
    }
    st.segLine = null; st.seg = null;
    fadePlayRunner();
    const city = st.seq[phase.i];
    const hasCity = city && city.lat != null && city.lng != null
      && isFinite(Number(city.lat)) && isFinite(Number(city.lng));
    if (hasCity) showPlayMarker(city);
    updatePlayProgress(phase.i + 1, st.seq.length);
    setPlayStatus(`📍 ${city.nameZh}${city.arriveDate ? ' · ' + city.arriveDate : ''}`);
    const nx = st.segs[phase.i + 1];
    if (hasCity && nx && !nx.noMap && nx.zoom != null) {
      // 变焦放在停留期：镜头不动，只缩放，给下一段留出瓦片加载时间
      if (Math.abs(nx.zoom - map.getZoom()) > 0.01) {
        map.setView([city.lat, city.lng], nx.zoom, { animate: true });
      }
      st.zoom = nx.zoom;
      prefetchTilesAlong(nx.pts, nx.zoom, 10);
      if (nx.to) prefetchArea(nx.to[0], nx.to[1], nx.zoom, 1);
    } else {
      // 上一段缺坐标、镜头没有跟过去时，抵达点若有坐标就平移过去，保证城市标记可见
      if (hasCity && st.segs[phase.i] && st.segs[phase.i].noMap) {
        if (map.stop) map.stop();
        map.setView([Number(city.lat), Number(city.lng)], map.getZoom(), { animate: true });
      }
      st.zoom = map.getZoom();
    }
  } else if (phase.type === 'seg') {
    const seg = st.segs[phase.i];
    st.seg = seg;
    st.arrowShown = false;
    if (seg.noMap) {   // 缺坐标的交通段：照常占一个相位并显示状态，但不移动镜头、不画线
      st.segLine = null; st.runner = null;
      st.zoom = map.getZoom();
      setPlayStatus(`${seg.icon} ${seg.fromName} → ${seg.toName}（缺坐标）`);
      return;
    }
    st.zoom = seg.zoom;
    if (map.stop) map.stop();
    map.setView(seg.from, st.zoom, { animate: false });   // 段首对齐，段内不再改缩放
    prefetchTilesAlong(seg.pts, st.zoom, 12);
    prefetchArea(seg.to[0], seg.to[1], st.zoom, 1);
    st.segLine = (seg.pts && seg.pts.length > 1)
      ? L.polyline([seg.pts[0]], {
          color: seg.color, weight: 3, opacity: 0.95,
          lineCap: 'round', lineJoin: 'round',
          interactive: false,
        }).addTo(_playGroup)
      : null;
    st.runner = L.marker(seg.pts[0], {
      icon: L.divIcon({
        className: 'play-runner-icon', iconSize: [16, 16], iconAnchor: [8, 8],
        html: `<div class="play-runner" style="background:${seg.color}"></div>`,
      }),
      interactive: false,
    }).addTo(_playGroup);
    setPlayStatus(`${seg.icon} ${seg.fromName} → ${seg.toName}`);
  } else if (phase.type === 'intro') {
    st.zoom = st.introZoom;
    if (map.stop) map.stop();
    // 开场用 Leaflet flyTo：一次调用完成平滑的“拉远-飞行-拉近”，不再逐帧改缩放
    map.flyTo([st.introTo.lat, st.introTo.lng], st.introZoom, {
      duration: Math.max(0.35, (INTRO_MS - 120) / 1000 / st.speed),   // 留一点余量，避免被相位结束截断
      easeLinearity: 0.25,
    });
    prefetchArea(st.introTo.lat, st.introTo.lng, st.introZoom, 1);
    if (st.segs[0] && !st.segs[0].noMap) {
      prefetchTilesAlong(st.segs[0].pts, st.segs[0].zoom, 10);
      prefetchArea(st.segs[0].to[0], st.segs[0].to[1], st.segs[0].zoom, 1);
      if (isHomeCoord(st.segs[0].from) && !isHomeCity(st.seq[0])) showHomeMarker();   // 常驻地出发标记
    }
    setPlayStatus('准备出发…');
  } else if (phase.type === 'home') {
    showHomeMarker();
    if (phase.arrive) {
      if (st.segLine && st.seg) {                     // 返程段收尾：补满线条 + 箭头
        st.segLine.setLatLngs(st.seg.pts);
        if (st.seg.hasLeg) addPlayArrow(st.seg);
        st.segLine = null; st.seg = null;
      }
      fadePlayRunner();
      setPlayStatus(`🏠 ${HOME_CITY.name}（常驻地）`);
    } else {
      setPlayStatus(`🏠 ${HOME_CITY.name}（常驻地）出发`);
    }
  } else if (phase.type === 'end') {
    if (st.segLine && st.seg) {                       // 最后一段补满 + 箭头
      st.segLine.setLatLngs(st.seg.pts);
      if (st.seg.hasLeg) addPlayArrow(st.seg);
      st.segLine = null; st.seg = null;
    }
    fadePlayRunner();
    // 收尾视野覆盖所有交通段的起止点（缺坐标的段不参与取景）
    const endPts = [];
    st.seq.forEach(c => {
      if (c && c.lat != null && c.lng != null && isFinite(Number(c.lat)) && isFinite(Number(c.lng))) {
        endPts.push([Number(c.lat), Number(c.lng)]);
      }
    });
    st.segs.forEach(s => {
      if (!s || s.noMap) return;
      if (s.from) endPts.push(s.from);
      if (s.to) endPts.push(s.to);
    });
    if (!endPts.length) endPts.push([HOME_CITY.lat, HOME_CITY.lng]);
    const endBounds = L.latLngBounds(endPts);
    const maxZ = st.seq.length > 1 ? 9 : 11;
    const z = Math.min(maxZ, map.getBoundsZoom(endBounds, false, L.point(60, 60)));
    st.zoom = z;
    st.endCenter = endBounds.getCenter();
    st.endTarget = z;
    if (map.stop) map.stop();
    map.flyTo(st.endCenter, z, {
      duration: Math.max(0.5, (END_MS - 150) / 1000 / st.speed),   // 留余量，确保收尾视野完整
      easeLinearity: 0.25,
    });
    prefetchTilesBounds(endBounds, z, 20);
    setPlayStatus('行程回顾');
  }
}
// 播放主循环：全局时间戳驱动，暂停冻结时间累积，退出后 rAF 不再续订
function playLoop(now) {
  const st = _play;
  if (!st || !st.running) return;                       // 退出后不留后台空转
  if (st.paused) { st.raf = 0; return; }                // 暂停后可能在途的一帧：不再续订
  try {
    const dt = Math.min(100, now - st.last); st.last = now;
    st.t += dt * st.speed;                                // 倍率作用于全局时长
    const phase = st.phases.find(p => st.t < p.end) || st.phases[st.phases.length - 1];
    const key = phase.type + ':' + phase.i;
    if (st.phaseKey !== key) {                            // 进入新相位：一次性触发
      st.phaseKey = key;
      enterPlayPhase(phase);
    }
    const span = phase.end - phase.start;
    const tp = Math.min(1, Math.max(0, (st.t - phase.start) / span));
    const te = easeInOutCubic(tp);
    if (phase.type === 'seg') tickTileUpdates(now);       // 瓦片更新限流（5 次/秒）
    if (phase.type === 'seg' && st.seg && !st.seg.noMap) { // 路径生长 + 光点 + 相机平移（缩放固定）
      const seg = st.seg, pts = seg.pts;
      const head = pathPoint(pts, te);
      if (st.segLine) {
        const fi = te * (pts.length - 1), i0 = Math.floor(fi);
        st.segLine.setLatLngs(pts.slice(0, i0 + 1).concat([head]));   // 线条像画出来一样连续生长
      }
      if (st.runner) st.runner.setLatLng(head);                       // 光点连续移动不瞬移
      // 镜头略微前瞻，让行进方向上的线更早进入视野，而不是死钉在光点上
      // 3% 足够看出线条走向，又不会把刚出发的常驻地/起点挤出屏幕
      const lookT = te + 0.03 * (1 - te);
      playCamera(pathPoint(pts, lookT), st.zoom);
      if (te >= 1 && !st.arrowShown) { st.arrowShown = true; addPlayArrow(seg); }   // 生长完成后箭头淡入
    }
    updatePlayFill();
    if (st.t >= st.total) { st.naturalEnd = true; finishPlay(); return; }
    st.raf = requestAnimationFrame(playLoop);
  } catch (err) {
    // 任何绘制异常都不能把动画图层留在图上（否则会出现数据里没有的多余连线）
    console.error('[footprint] 播放中断：', err);
    finishPlay();
  }
}
// 段生长完成：中点方向箭头淡入（颜色随交通方式）
function addPlayArrow(seg) {
  if (!seg.hasLeg || !_playGroup) return;
  const pts = seg.pts, m = Math.floor(pts.length / 2);
  const a = pts[Math.max(0, m - 1)], b = pts[Math.min(pts.length - 1, m + 1)];
  const ang = Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180 / Math.PI;
  L.marker(pts[m], {
    interactive: false,
    icon: L.divIcon({
      className: 'fp-arrow-icon', iconSize: [6, 10], iconAnchor: [3, 5],
      html: `<div class="fp-arrow play-arrow-in" style="transform:rotate(${ang.toFixed(1)}deg);border-bottom-color:${seg.color}"></div>`,
    }),
  }).addTo(_playGroup);
}
// 城市到达标记：0.3s 缩放淡入 + 名称/到达日期标签；已播放城市保留不清除
function showPlayMarker(city) {
  const label = city.nameZh + (city.arriveDate ? ' · ' + city.arriveDate : '');
  L.marker([city.lat, city.lng], {
    icon: L.divIcon({
      className: 'play-marker-icon', iconSize: [20, 20], iconAnchor: [10, 10],
      html: `<div class="play-dot"></div><div class="play-label">${esc(label)}</div>`,
    }),
    interactive: false,
  }).addTo(_playGroup);
}
function showHomeMarker() {
  const st = _play;
  if (!st || st.homeMarked || !isFinite(HOME_CITY.lat) || !isFinite(HOME_CITY.lng)) return;
  st.homeMarked = true;
  showPlayMarker({ nameZh: (HOME_CITY.name || '常驻地') + '（常驻地）', lat: HOME_CITY.lat, lng: HOME_CITY.lng, arriveDate: '' });
}
// 播放期锁地图交互；退出时按进入前状态精确恢复（doubleClickZoom 初始是关闭的）
let _mapLockSaved = null;
function setMapLock(lock) {
  if (!map) return;
  const keys = ['dragging', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom', 'keyboard', 'touchZoom'];
  if (lock) {
    if (!_mapLockSaved) _mapLockSaved = {};
    keys.forEach(k => { if (map[k] && map[k].enabled) _mapLockSaved[k] = map[k].enabled(); });
    keys.forEach(k => { if (map[k] && map[k].disable) map[k].disable(); });
  } else {
    const saved = _mapLockSaved || {};
    keys.forEach(k => {
      if (!map[k]) return;
      if (saved[k] === false) { if (map[k].disable) map[k].disable(); }
      else { if (map[k].enable) map[k].enable(); }
    });
    _mapLockSaved = null;
  }
}
function updatePlayProgress(idx, total) {
  const el = document.getElementById('play-progress');
  if (el) el.textContent = `第 ${idx} / 共 ${total} 段`;
}
function setPlayBar(show) {
  document.getElementById('play-bar').hidden = !show;
}
function fillPlayDrawer() {
  const sel = document.getElementById('play-trip');
  const empty = document.getElementById('play-empty');
  const btn = document.getElementById('btn-start-play');
  sel.innerHTML = TRIPS.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
  empty.hidden = TRIPS.length > 0;
  btn.disabled = TRIPS.length === 0;
  updatePlayStats();
}
function updatePlayStats() {
  const tripId = document.getElementById('play-trip').value;
  const tripStops = STOPS.filter(s => s.tripId === tripId);
  const n = tripStops.length;
  const uniq = uniqueCityCount(tripStops);
  const m = LEGS.filter(l => l.tripId === tripId).length;
  const cityText = n > uniq ? `${uniq} 个城市 / ${n} 次到访` : `${n} 个城市`;
  document.getElementById('play-stats').textContent = `该行程：${cityText} · ${m} 段交通（逐段播放 ${m} 次）`;
}
// 播放期隐藏业务图层，减少 DOM/绘制；收尾再恢复
function hideLayersForPlay() {
  const st = _play;
  st.hidden = [];
  [layerGroup, _outlineLayer, _cityLayer].forEach(layer => {
    if (layer && map.hasLayer(layer)) { map.removeLayer(layer); st.hidden.push(layer); }
  });
}
// 启动播放：一次性预读全部数据进内存，播放期间零查询、零图层重建
function startPlay(tripId) {
  if (_play && _play.running) exitPlay();
  if (!map || !_mapReady) { toast('地图尚未就绪，请稍候再试'); return; }
  // 有几段交通就播放几次：按当前行程的交通段逐条播放，重复城市/缺坐标的段也各占一次
  const { seq, segs } = buildPlayPlan(tripId);
  if (!seq.length) { toast('该行程暂无交通段，先去「录入」添加吧'); return; }
  // 开场位置：第一段有坐标的交通段起点；全都没坐标时就飞往常驻地
  const firstPlaced = segs.find(s => s && !s.noMap);
  const firstPlacedCity = seq.find(c => c && c.lat != null && c.lng != null && isFinite(Number(c.lat)) && isFinite(Number(c.lng)));
  const introTo = firstPlaced ? { lat: firstPlaced.from[0], lng: firstPlaced.from[1] }
    : (firstPlacedCity ? { lat: Number(firstPlacedCity.lat), lng: Number(firstPlacedCity.lng) }
      : { lat: HOME_CITY.lat, lng: HOME_CITY.lng });
  const introZoom = firstPlaced && firstPlaced.zoom != null ? firstPlaced.zoom : playZoomFor(null, introTo);
  if (_drillAdcode) backToChina();
  closeAllDrawers();
  if (map.stop) map.stop();
  setMapLock(true);
  if (_legGroup) map.removeLayer(_legGroup);   // 播放期间隐藏业务连线，用动画线代替
  if (_wishGroup) map.removeLayer(_wishGroup); // 播放视图专注轨迹
  _playGroup = L.layerGroup().addTo(map);
  const speed = parseFloat(document.getElementById('play-speed').value) || 1;
  const { phases, total } = buildTimeline(seq, segs);
  map.options.zoomSnap = 0;                              // 播放期支持连续缩放，收尾恢复
  _prefetched.clear(); _prefetchQueue.length = 0;
  _play = {
    running: true, paused: false, speed, tripId, seq, segs, phases, total,
    introTo, introZoom,
    t: 0, zoom: map.getZoom(), phaseKey: '', last: performance.now(), raf: 0, fillAt: 0,
    tileZoomUpdate: [_tileLight, _tileDark].map(l => l ? l.options.updateWhenZooming : null),
  };
  hideLayersForPlay();
  throttleTileUpdates();
  // 播放期变焦只在停留/开场/收尾发生；关掉“变焦过程中逐级加载瓦片”，到目标级别后一次加载，
  // 避免 flyTo 从 z4→z10 时把 z5/z6/.../z9 的瓦片全部拉一遍。
  [_tileLight, _tileDark].forEach(l => { if (l) l.options.updateWhenZooming = false; });
  document.getElementById('play-pause').textContent = '⏸ 暂停';
  const fill = document.getElementById('play-fill');
  if (fill) fill.style.width = '0%';
  updatePlayProgress(0, seq.length);
  setPlayStatus('准备出发…');
  setPlayBar(true);
  _play.raf = requestAnimationFrame(playLoop);
}
// 收尾：清除播放图层组与光点，恢复地图交互与业务图层；rAF 全部取消
function finishPlay() {
  const st = _play;
  if (st) st.running = false;   // 先标记停止，后续异常也不会留下可播放状态
  if (st && st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
  if (map && map.stop) map.stop();
  if (_playGroup) {   // 先清动画图层，避免收尾异常时地图残留多余连线
    if (map && map.hasLayer(_playGroup)) map.removeLayer(_playGroup);
    _playGroup = null;
  }
  // 自然结束时确保落在完整行程视野（flyTo 偶有最后一帧未走完）
  if (st && st.naturalEnd && st.endCenter && st.endTarget != null) {
    try { map.setView(st.endCenter, st.endTarget, { animate: false }); } catch (e) { /* 忽略 */ }
  }
  restoreTileUpdates();
  if (st && st.hidden) {
    st.hidden.forEach(layer => { if (layer && !map.hasLayer(layer)) map.addLayer(layer); });
    st.hidden = null;
  }
  if (st && st.tileZoomUpdate) {
    [_tileLight, _tileDark].forEach((l, i) => { if (l) l.options.updateWhenZooming = st.tileZoomUpdate[i] == null ? true : st.tileZoomUpdate[i]; });
    st.tileZoomUpdate = null;
  }
  if (_legGroup && !map.hasLayer(_legGroup)) map.addLayer(_legGroup);   // 恢复业务连线 = 完整轨迹
  if (_wishGroup && !map.hasLayer(_wishGroup)) map.addLayer(_wishGroup);
  map.options.zoomSnap = 1;
  setMapLock(false);
  setPlayBar(false);
  const fill = document.getElementById('play-fill');
  if (fill) fill.style.width = '0%';
  setPlayStatus('');
  // 播放期跳过了标签避让/气泡显隐，结束后补一次
  updateBubbleVisibility();
  resolveCityLabelOverlap();
}
function exitPlay() {
  finishPlay();
}
function bindPlay() {
  document.getElementById('play-trip').addEventListener('change', updatePlayStats);
  document.getElementById('btn-start-play').addEventListener('click', () => startPlay(document.getElementById('play-trip').value));
  document.getElementById('play-pause').addEventListener('click', () => {
    if (!_play || !_play.running) return;
    _play.paused = !_play.paused;
    document.getElementById('play-pause').textContent = _play.paused ? '▶ 继续' : '⏸ 暂停';
    if (_play.paused) {                                     // 暂停：取消 rAF，镜头/光点/线条全部冻结
      if (_play.raf) cancelAnimationFrame(_play.raf);
      _play.raf = 0;
    } else {                                                // 继续：基于时间差恢复，不堆叠定时器
      _play.last = performance.now();
      _play.raf = requestAnimationFrame(playLoop);
    }
  });
  document.getElementById('play-replay').addEventListener('click', () => {
    const tripId = document.getElementById('play-trip').value || (_play && _play.tripId);
    if (tripId) startPlay(tripId);
  });
  document.getElementById('play-speed').addEventListener('change', (e) => {
    if (_play) _play.speed = parseFloat(e.target.value) || 1;
  });
  document.getElementById('play-exit').addEventListener('click', exitPlay);
}

/* ===== 工具栏 & 抽屉 ===== */
const DRAWER_NAMES = ['entry', 'timeline', 'diary', 'photos', 'settings', 'wishlist', 'play'];
// 全局唯一打开状态：任意时刻至多一个抽屉打开，_openDrawer 记录其名字（null = 全部关闭）
let _openDrawer = null;
// 统一关闭函数：只收起指定抽屉（移除 .open，无残留容器），照片抽屉连带关灯箱并清空容器
function closeDrawer(name) {
  const d = document.getElementById('drawer-' + name);
  if (d) d.classList.remove('open');
  const tb = document.querySelector('.tool-btn.active[data-drawer="' + name + '"]');
  if (tb) tb.classList.remove('active');
  if (name === 'photos') {
    closeLightbox();
    // 清空照片容器，避免残留旧城市内容/空容器；释放缩略图 blob URL
    _thumbUrls.forEach(u => URL.revokeObjectURL(u)); _thumbUrls = [];
    const grid = document.getElementById('photo-grid');
    const emptyEl = document.getElementById('photo-empty');
    if (grid) grid.innerHTML = '';
    if (emptyEl) emptyEl.hidden = true;
    _photoStopId = null;
    _photoSelectMode = false;
    _photoSelected.clear();
    updatePhotoSelectBar();
  }
  if (_openDrawer === name) _openDrawer = null;
}
function closeAllDrawers() {
  DRAWER_NAMES.forEach(closeDrawer);
  _openDrawer = null;
}
// 统一打开函数：先关全部再开自己，保证互斥
function openDrawer(name) {
  closeAllDrawers();
  const d = document.getElementById('drawer-' + name);
  if (!d) return;
  d.classList.add('open');
  const tb = document.querySelector('.tool-btn[data-drawer="' + name + '"]');
  if (tb) tb.classList.add('active');
  _openDrawer = name;
  if (name === 'play') fillPlayDrawer();
}
function bindDrawers() {
  document.querySelectorAll('.tool-btn[data-drawer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.drawer;
      const drawer = document.getElementById('drawer-' + name);
      if (!drawer) return;
      if (_openDrawer === name) closeDrawer(name);  // 再点同一按钮 = 收起
      else openDrawer(name);                        // 打开前先 closeAllDrawers，保证互斥
    });
  });
  // 每个抽屉的 × 显式直绑：统一走 closeAllDrawers()（互斥下等价于只关自己）
  document.querySelectorAll('.drawer-head .drawer-close').forEach(btn => {
    btn.addEventListener('click', () => {
      const drawer = btn.closest('.drawer');
      if (drawer && drawer.id.indexOf('drawer-') === 0) closeAllDrawers();
    });
  });
  // 地图空白点击关闭：点击目标在 #map 内，且不在抽屉/工具栏/圆点连线/弹窗/控件/图例/返回按钮上
  document.addEventListener('click', (e) => {
    if (!_openDrawer) return;
    const t = e.target;
    if (!t.closest || !t.closest('#map')) return;
    if (t.closest('.drawer') || t.closest('#toolbar') || t.closest('.map-legend') ||
        t.closest('.back-btn') || t.closest('.leaflet-interactive') ||
        t.closest('.leaflet-popup') || t.closest('.leaflet-control') ||
        t.closest('.leaflet-tooltip')) return;
    closeAllDrawers();
  });
  // 兜底委托（重复执行 closeDrawer 幂等，无副作用）
  document.addEventListener('click', (e) => {
    const closeBtn = e.target.closest('.drawer-close');
    if (!closeBtn) return;
    const drawer = closeBtn.closest('.drawer');
    if (drawer && drawer.id.indexOf('drawer-') === 0) closeDrawer(drawer.id.slice(7));
    else if (closeBtn.id === 'lb-close') closeLightbox();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (_play && _play.running) exitPlay();   // 播放中 Esc 退出播放
      closeAllDrawers(); closeLightbox(); closeCarousel();
    }
  });
  document.getElementById('btn-highlight').addEventListener('click', (e) => {
    _highlightMode = !_highlightMode;
    e.currentTarget.classList.toggle('active', _highlightMode);
    toast(_highlightMode ? '点亮模式：开启，点击省份/城市切换点亮' : '点亮模式：关闭，点击仅查看详情');
  });
  document.getElementById('btn-theme').addEventListener('click', () => {
    applyTheme(_theme === 'dark' ? 'light' : 'dark');
    toast(_theme === 'dark' ? '已切换到深色主题' : '已切换到浅色主题');
  });
  document.getElementById('btn-back-china').addEventListener('click', backToChina);
}

/* ===== 键盘平移（WASD + 方向键，按住持续移动） ===== */
const KEY_PAN = { w:[0,-1], a:[-1,0], s:[0,1], d:[1,0], arrowup:[0,-1], arrowleft:[-1,0], arrowdown:[0,1], arrowright:[1,0] };
const _pressed = new Set();
let _panTimer = null;
function panTick() {
  if (!_mapReady) return;
  let dx = 0, dy = 0;
  _pressed.forEach(k => { const v = KEY_PAN[k]; dx += v[0]; dy += v[1]; });
  if (dx || dy) map.panBy([dx * 10, dy * 10], { animate: false });
}
function stopPanning() {
  _pressed.clear();
  if (_panTimer) { clearInterval(_panTimer); _panTimer = null; }
}
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('input,textarea,select')) return;
    const k = (e.key || '').toLowerCase();
    if (!(k in KEY_PAN)) return;
    e.preventDefault();
    _pressed.add(k);
    if (!_panTimer) _panTimer = setInterval(panTick, 50);
  });
  document.addEventListener('keyup', (e) => {
    _pressed.delete((e.key || '').toLowerCase());
    if (!_pressed.size) stopPanning();
  });
  window.addEventListener('blur', stopPanning);
}

/* ===== 城市搜索选择器：数据来自 window.CITIES（DataV 中心点） ===== */
function clearCityPicker() {
  const inp = document.getElementById('city-preset-input');
  const list = document.getElementById('city-preset-list');
  if (inp) inp.value = '';
  if (list) list.hidden = true;
}
// 新增城市时提示：同名城市已有到访 → 保存会新增一次独立到访（日期/同行人/心情/照片各自独立）
function updateStopVisitHint() {
  const f = document.getElementById('form-stop');
  const el = document.getElementById('stop-visit-hint');
  if (!f || !el) return;
  if (_editingStopId) { el.hidden = true; return; }
  const tripId = f.tripId.value;
  const key = normCity(f.city.value || f.nameZh.value);
  if (!tripId || !key) { el.hidden = true; return; }
  const existing = STOPS.filter(s => s.tripId === tripId && normCity(s.city || s.nameZh) === key);
  if (!existing.length) { el.hidden = true; return; }
  const name = f.nameZh.value.trim() || f.city.value.trim();
  el.hidden = false;
  el.textContent = `该行程已有 ${existing.length} 次「${name}」到访记录；保存会新增一次独立到访，日期、同行人、心情、花费、备注和照片都单独保存。`;
}
function initCityPicker() {
  const input = document.getElementById('city-preset-input');
  const list = document.getElementById('city-preset-list');
  if (!input || !list) return;
  const cities = (Array.isArray(window.CITIES) ? window.CITIES : [])
    .filter(c => c && c.name && c.province && isFinite(c.lat) && isFinite(c.lng));  // 坐标缺失项不进下拉
  const byProv = new Map();
  cities.forEach(c => {
    if (!byProv.has(c.province)) byProv.set(c.province, []);
    byProv.get(c.province).push(c);
  });

  // 中文模糊匹配改为全局 fuzzyHit（心愿城市预设共用）

  function render(keyword) {
    const kw = (keyword || '').trim().toLowerCase();
    let html = '<div class="cp-item cp-manual" data-manual="1">✍️ 手动填写（不自动回填，直接在下方输入）</div>';
    let count = 0;
    byProv.forEach((arr, prov) => {
      const hits = arr.filter(c => !kw || fuzzyHit(c.name, kw) || fuzzyHit(prov, kw));
      if (!hits.length) return;
      count += hits.length;
      html += `<div class="cp-group">${esc(prov)}</div>` + hits.map(c =>
        `<div class="cp-item" data-name="${esc(c.name)}" data-prov="${esc(c.province)}" data-lat="${c.lat}" data-lng="${c.lng}">`
        + `<span>${esc(c.name)}</span><span class="cp-coords">${c.lat.toFixed(2)}, ${c.lng.toFixed(2)}</span></div>`).join('');
    });
    if (!count && kw) html += '<div class="cp-empty">没有匹配的城市，可关闭本列表手动填写经纬度</div>';
    list.innerHTML = html;
    list.hidden = false;
  }

  function pick(c) {
    const f = document.getElementById('form-stop');
    const short = c.name.replace(/市$/, '');   // 贵阳市 → 贵阳；自治州/盟等保留全名
    f.country.value = '中国';
    f.region.value = c.province;
    f.city.value = short;
    f.lat.value = c.lat;
    f.lng.value = c.lng;
    f.nameZh.value = short;
    f.nameEn.value = '';
    input.value = c.name;
    list.hidden = true;
    updateStopVisitHint();
  }

  input.addEventListener('focus', () => render(input.value));
  input.addEventListener('input', () => render(input.value));
  list.addEventListener('click', (e) => {
    if (e.target.closest('[data-manual]')) { list.hidden = true; return; }
    const item = e.target.closest('[data-name]');
    if (!item) return;
    pick({ name: item.dataset.name, province: item.dataset.prov, lat: parseFloat(item.dataset.lat), lng: parseFloat(item.dataset.lng) });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.city-picker')) list.hidden = true;
  });
}

/* ===== 表单提交 ===== */
function bindForms() {
  // 圆点颜色色板（表单）
  const pal = document.getElementById('stop-color-palette');
  if (pal) {
    pal.innerHTML = MARKER_COLORS.map(c =>
      `<button type="button" class="swatch" data-formcolor="${c}" style="background:${c}" title="${c}"></button>`).join('');
    pal.addEventListener('click', (e) => {
      const b = e.target.closest('[data-formcolor]');
      if (b) setStopColorSelection(b.dataset.formcolor);
    });
    setStopColorSelection(DEFAULT_MARKER_COLOR);
  }

  document.getElementById('form-trip').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const wasEditing = !!_editingTripId;
    const trip = { id: _editingTripId || uid(), title: f.title.value.trim(), dateStart: f.dateStart.value, dateEnd: f.dateEnd.value, note: f.note.value.trim() };
    if (!trip.title) return;
    await DB.putTrip(trip);
    setTripExpanded(trip.id, true);   // 保存后自动展开该行程，方便继续添加
    if (wasEditing) exitEditMode('trip'); else f.reset();
    await reload(); toast(wasEditing ? '行程已更新' : '行程已保存');
  });

  // 行程日期联动：开始日期变化 → 结束日期默认同一天且 min 限制
  const tripForm = document.getElementById('form-trip');
  tripForm.dateStart.addEventListener('change', () => {
    if (tripForm.dateStart.value) {
      tripForm.dateEnd.min = tripForm.dateStart.value;
      tripForm.dateEnd.value = tripForm.dateStart.value;
    } else {
      tripForm.dateEnd.min = '';
    }
  });

  // 切换所属行程时清空城市相关残留（不允许上一个城市残留）
  const stopForm = document.getElementById('form-stop');
  stopForm.tripId.addEventListener('change', () => {
    stopForm.nameZh.value = '';
    stopForm.nameEn.value = '';
    stopForm.region.value = '';
    stopForm.city.value = '';
    stopForm.lat.value = '';
    stopForm.lng.value = '';
    const inp = document.getElementById('city-preset-input');
    if (inp) inp.value = '';
    updateStopVisitHint();
  });
  ['input', 'change'].forEach(ev => {
    stopForm.nameZh.addEventListener(ev, updateStopVisitHint);
    stopForm.city.addEventListener(ev, updateStopVisitHint);
  });

  // 城市日期联动：到达日期变化 → 离开日期默认同一天且 min 限制（仍可手动改）
  stopForm.arriveDate.addEventListener('change', () => {
    if (stopForm.arriveDate.value) {
      stopForm.leaveDate.min = stopForm.arriveDate.value;
      stopForm.leaveDate.value = stopForm.arriveDate.value;
    } else {
      stopForm.leaveDate.min = '';
    }
  });

  // Leg 起止下拉：选"手动输入"时展开对应端的名称/坐标填写框
  const legForm = document.getElementById('form-leg');
  legForm.fromStopId.addEventListener('change', updateLegManualVisibility);
  legForm.toStopId.addEventListener('change', updateLegManualVisibility);
  const legYearSel = document.getElementById('leg-year-filter');
  if (legYearSel) legYearSel.addEventListener('change', (e) => {
    _legYearFilter = e.target.value;
    refreshLegCitySelects();
  });
  // 编辑态任一字段改动 → 记录 dirty，添加返程时先保存原段
  legForm.addEventListener('input', () => { if (_editingLegId) { _legDirty = true; syncReturnBtn(); } });
  legForm.addEventListener('change', () => { if (_editingLegId) { _legDirty = true; syncReturnBtn(); } });
  // 出发日期/时刻变化时自动同步到达端：到达端为空或仍是上次自动同步值时才覆盖；手动改过的到达端不吞
  const syncLegArrive = () => {
    const arr = joinLegTime(legForm.arriveDate.value, legForm.arriveClock.value);
    if (!arr || arr === _legAutoArrive) {
      legForm.arriveDate.value = legForm.departDate.value;
      legForm.arriveClock.value = legForm.departClock.value;
      _legAutoArrive = joinLegTime(legForm.arriveDate.value, legForm.arriveClock.value);
    }
  };
  ['input', 'change'].forEach(ev => {
    legForm.departDate.addEventListener(ev, syncLegArrive);
    legForm.departClock.addEventListener(ev, syncLegArrive);
  });
  // 添加返程：反向生成一条新 Leg（原段不动），并直接切到新返程段编辑时间。
  // 若原段有未保存的改动，先按表单值保存原段，避免切换后丢失。
  document.getElementById('btn-add-return').addEventListener('click', async () => {
    if (!_editingLegId) return;
    const f = document.getElementById('form-leg');
    const editId = _editingLegId;
    const tripId = f.tripId.value;
    if (!tripId) { toast('请先选择行程'); return; }
    const fromEp = legFormEndpoint(f, 'from');
    const toEp = legFormEndpoint(f, 'to');
    if (!fromEp || !toEp) { toast('请先完善起止城市'); return; }
    if (fromEp.name.trim() === toEp.name.trim()) { toast('出发与到达城市不能相同'); return; }
    try {
      if (_legDirty) {
        await DB.putLeg({
          id: editId, tripId, from: fromEp, to: toEp, mode: f.mode.value,
          departAt: joinLegTime(f.departDate.value, f.departClock.value),
          arriveAt: joinLegTime(f.arriveDate.value, f.arriveClock.value),
          cost: f.cost.value === '' ? null : Number(f.cost.value), note: f.note.value.trim(),
        });
      }
      const returnId = uid();
      await DB.putLeg({
        id: returnId, tripId,
        from: toEp, to: fromEp,   // 反向：新出发 = 当前到达
        mode: f.mode.value,
        departAt: '', arriveAt: '', cost: null, note: '',
      });
      setTripExpanded(tripId, true);
      await reload();
      startEditLeg(returnId);     // 直接打开新返程段，填好时间保存即可
      const df = document.getElementById('form-leg');
      if (df && df.departDate) df.departDate.focus();
      toast('已生成返程段，填好时间后点「保存交通段」');
    } catch (err) {
      console.error('[footprint] 添加返程失败：', err);
      toast('添加返程失败：' + ((err && (err.message || err.code)) || err));
    }
  });
  // 手动输入城市名时，若与已有城市/常驻城市同名则自动回填坐标（可再手动覆盖）
  [['from', 'Name', 'Lat', 'Lng'], ['to', 'Name', 'Lat', 'Lng']].forEach(([end, n, la, ln]) => {
    legForm[end + n].addEventListener('input', () => {
      const val = legForm[end + n].value.trim();
      let hit = null;
      if (val && val === HOME_CITY.name) hit = HOME_CITY;
      else { const s = STOPS.find(x => x.nameZh === val || x.city === val); if (s) hit = { lat: s.lat, lng: s.lng }; }
      if (hit) { legForm[end + la].value = hit.lat; legForm[end + ln].value = hit.lng; }
    });
  });

  initCityPicker();

  document.getElementById('form-stop').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const lat = parseFloat(f.lat.value), lng = parseFloat(f.lng.value);
    if (isNaN(lat) || isNaN(lng)) { toast('经纬度必须是数字'); return; }
    const wasEditing = !!_editingStopId;
    const oldStop = wasEditing ? STOPS.find(s => s.id === _editingStopId) : null;
    const stop = {
      id: _editingStopId || uid(), tripId: f.tripId.value, nameZh: f.nameZh.value.trim(), nameEn: f.nameEn.value.trim(),
      country: f.country.value.trim(), region: f.region.value.trim(), city: f.city.value.trim(),
      lat, lng, arriveDate: f.arriveDate.value, leaveDate: f.leaveDate.value,
      weather: f.weather.value.trim(), mood: f.mood.value.trim(),
      companions: f.companions.value.trim(), cost: f.cost.value === '' ? null : Number(f.cost.value),
      note: f.note.value.trim(),
      markerColor: f.markerColor.value || DEFAULT_MARKER_COLOR,
      coverPhotoId: oldStop ? (oldStop.coverPhotoId || '') : '',   // 编辑时保留封面照片
    };
    if (!stop.tripId || !TRIPS.some(t => t.id === stop.tripId) || !stop.nameZh) { toast('请选择有效行程并填写名称'); return; }
    // 同名城市再次到访：保存成一条新的独立记录（日期/同行人/心情/照片互不影响）
    const visitCount = wasEditing ? 0 : STOPS.filter(x =>
      x.tripId === stop.tripId && normCity(x.city || x.nameZh) === normCity(stop.city || stop.nameZh)).length;
    // 编辑时同步点亮集合：改名/改国家清旧记录，同名时同步坐标与省份
    if (oldStop) {
      const oldKey = normCity(oldStop.city) || normCity(oldStop.nameZh);
      const newKey = normCity(stop.city) || normCity(stop.nameZh);
      const oldRec = VISITED_CITIES.find(c => normCity(c.name) === oldKey);
      if (oldRec && (oldKey !== newKey || stop.country !== '中国')) {
        await DB.delVisitedCity(oldRec.name);
        VISITED_CITIES = VISITED_CITIES.filter(c => c !== oldRec);
      } else if (stop.country === '中国' && oldRec) {
        const rec = { name: stop.city || stop.nameZh, region: stop.region || '', lat: stop.lat, lng: stop.lng };
        await DB.putVisitedCity(rec);
        VISITED_CITIES = VISITED_CITIES.map(c => (c === oldRec ? rec : c));
      }
    }
    await DB.putStop(stop);
    if (stop.tripId) setTripExpanded(stop.tripId, true);   // 保存后自动展开所属行程
    // 自动写入点亮集合（省 + 城市）
    if (stop.country === '中国') {
      if (stop.region) {
        const pn = normProv(stop.region);
        if (!VISITED_PROVINCES.some(p => normProv(p) === pn)) {
          await DB.putVisitedProvince(stop.region);
          VISITED_PROVINCES.push(stop.region);
        }
      }
      const cityName = normCity(stop.city) || normCity(stop.nameZh);
      if (cityName && !VISITED_CITIES.some(c => normCity(c.name) === cityName)) {
        const rec = { name: stop.city || stop.nameZh, region: stop.region || '', lat: stop.lat, lng: stop.lng };
        await DB.putVisitedCity(rec);
        VISITED_CITIES.push(rec);
      }
    }
    if (wasEditing) exitEditMode('stop');
    else { f.reset(); setStopColorSelection(DEFAULT_MARKER_COLOR); clearCityPicker(); }
    await reload();
    toast(wasEditing ? '城市已更新'
      : (visitCount ? `已新增一次到访：${stop.nameZh}（该行程共 ${visitCount + 1} 次，照片/心情独立）` : '城市已保存'));
    if (!wasEditing) await autoChainLeg(stop);   // 行程内按到达日期自动串联相邻城市
  });

// 自动串联：新增城市后，对行程内按到达日期排序的相邻城市对补缺生成 Leg（首尾不连、已有连线不重复）
async function autoChainLeg(stop) {
  const list = STOPS.filter(s => s.tripId === stop.tripId)
    .sort((a, b) => (a.arriveDate || '9999').localeCompare(b.arriveDate || '9999'));
  let added = 0, first = null, second = null;
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1], cur = list[i];
    // 同一城市再次到访（同名或同坐标）：不自动生成“西安 → 西安”这种同城段
    const sameName = normCity(prev.city || prev.nameZh) === normCity(cur.city || cur.nameZh);
    const sameSpot = Math.abs(Number(prev.lat) - Number(cur.lat)) < 0.01
      && Math.abs(Number(prev.lng) - Number(cur.lng)) < 0.01;
    if (sameName || sameSpot) continue;
    const linked = LEGS.some(l => {
      const f = (l.from && l.from.kind === 'stop') ? l.from.stopId : l.fromStopId;
      const t = (l.to && l.to.kind === 'stop') ? l.to.stopId : l.toStopId;
      return (f === prev.id && t === cur.id) || (f === cur.id && t === prev.id);
    });
    if (linked) continue;
    await DB.putLeg({
      id: uid(), tripId: stop.tripId,
      from: { kind: 'stop', stopId: prev.id, name: prev.nameZh },
      to: { kind: 'stop', stopId: cur.id, name: cur.nameZh },
      mode: 'train', departAt: '', arriveAt: '', cost: null,
      note: '自动串联（请选择交通方式）',
    });
    if (!first) { first = prev.nameZh; second = cur.nameZh; }
    added++;
  }
  if (added) {
    await reload();
    toast(`已自动串联 ${first} → ${second}` + (added > 1 ? ` 等 ${added} 段，请在列表中编辑交通方式` : '，请在列表中编辑交通方式'));
  }
}

  document.getElementById('form-leg').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const fe = legFormEndpoint(f, 'from');
    const te = legFormEndpoint(f, 'to');
    if (!fe || !te) { toast('请选择行程与起止城市'); return; }
    if (fe.name.trim() === te.name.trim()) { toast('出发与到达城市不能相同'); return; }
    const wasEditing = !!_editingLegId;
    const leg = {
      id: _editingLegId || uid(), tripId: f.tripId.value,
      from: fe, to: te,
      mode: f.mode.value,
      departAt: joinLegTime(f.departDate.value, f.departClock.value),
      arriveAt: joinLegTime(f.arriveDate.value, f.arriveClock.value),
      cost: f.cost.value === '' ? null : Number(f.cost.value), note: f.note.value.trim(),
    };
    if (!leg.tripId) { toast('请选择行程'); return; }
    await DB.putLeg(leg);
    if (leg.tripId) setTripExpanded(leg.tripId, true);   // 保存后自动展开所属行程
    if (wasEditing) exitEditMode('leg'); else resetLegForm();
    await reload(); toast(wasEditing ? '交通段已更新' : '交通段已保存');
  });

  // 已有数据：再次到访 / 编辑按钮（事件委托）
  document.getElementById('data-lists').addEventListener('click', (e) => {
    const rbtn = e.target.closest('[data-revisit]');
    if (rbtn) { startRevisit(rbtn.dataset.revisit); return; }
    const ebtn = e.target.closest('[data-edit]');
    if (!ebtn) return;
    const kind = ebtn.dataset.edit, id = ebtn.dataset.id;
    if (kind === 'trip') startEditTrip(id);
    else if (kind === 'stop') startEditStop(id);
    else if (kind === 'leg') startEditLeg(id);
  });

  // 删除城市前先清理它的照片：本机照片 + 云端 photos 记录/Storage 文件
  async function deleteStopPhotos(stopId) {
    const photos = await DB.getPhotosByStop(stopId);
    const ids = [];
    for (const p of photos) {
      await DB.delPhoto(p.id);
      if (window.unmirrorPhoto) await window.unmirrorPhoto(p.id);
      ids.push(p.id);
    }
    return ids;
  }
  // 清掉其它城市上指向已删照片的封面引用（被删城市本身不再处理）
  async function clearDanglingCovers(photoIds, deletedStopIds) {
    if (!photoIds.length) return;
    const gone = new Set(photoIds);
    const deleted = deletedStopIds || new Set();
    const affected = STOPS.filter(s => !deleted.has(s.id) && s.coverPhotoId && gone.has(s.coverPhotoId));
    for (const s of affected) {
      s.coverPhotoId = '';
      await DB.putStop(s);
    }
  }

  // 已有数据删除（事件委托）
  document.getElementById('data-lists').addEventListener('click', async (e) => {
    if (e.target.closest('[data-clean-orphan-legs]')) { cleanOrphanLegs(); return; }
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    const kind = btn.dataset.del, id = btn.dataset.id;
    if (!confirm('确定删除？此操作不可撤销。')) return;
    // 若正在编辑被删记录，先退出编辑态
    if (kind === 'trip' && _editingTripId === id) exitEditMode('trip');
    if (kind === 'stop' && _editingStopId === id) exitEditMode('stop');
    if (kind === 'leg' && _editingLegId === id) exitEditMode('leg');
    try {
      if (kind === 'trip') {
        const sIds = STOPS.filter(s => s.tripId === id).map(s => s.id);
        const sSet = new Set(sIds);
        // 先删子表（交通段→照片/城市）再删行程：避免外键阻止删除，也避免中途失败留下悬空城市/交通段
        const lIds = new Set(LEGS.filter(l => l.tripId === id).map(l => l.id));
        LEGS.forEach(l => {   // 其它行程里引用了这些城市的段也要清掉
          if (sIds.some(sid => legRefsStop(l, sid))) lIds.add(l.id);
        });
        for (const lid of lIds) await DB.delLeg(lid);
        const photoIds = [];
        for (const sid of sIds) {
          photoIds.push(...(await deleteStopPhotos(sid)));
          await DB.delStop(sid);
        }
        await DB.delTrip(id);
        await clearDanglingCovers(photoIds, sSet);
      } else if (kind === 'stop') {
        // 先删引用该城市的交通段，再删城市；避免中途失败后“城市没了、交通段还在”
        const lIds = LEGS.filter(l => legRefsStop(l, id)).map(l => l.id);
        for (const lid of lIds) await DB.delLeg(lid);
        await DB.delStop(id);
        const photoIds = await deleteStopPhotos(id);
        await clearDanglingCovers(photoIds, new Set([id]));
      } else if (kind === 'leg') {
        await DB.delLeg(id);
      }
      await reload();
      toast('已删除');
    } catch (err) {
      console.error('[footprint] 删除失败：', err);
      toast('删除失败：' + ((err && (err.message || err.code)) || err));
      try { await reload(); } catch (e2) { /* 重新载入以显示真实状态 */ }
    }
  });

  // 心情日记
  document.getElementById('form-diary').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!f.date.value) { toast('请选择日期'); return; }
    const moodRadio = f.querySelector('input[name="mood"]:checked');
    const existing = _editingDiaryId ? DIARIES.find(d => d.id === _editingDiaryId) : null;
    const wasEditing = !!_editingDiaryId;
    const rec = {
      id: _editingDiaryId || uid(),
      date: f.date.value,
      mood: moodRadio ? moodRadio.value : '',
      weather: f.weather.value.trim(),
      note: f.note.value,
      tripId: f.tripId.value || '',
      stopId: f.stopId.value || '',
      createdAt: existing ? existing.createdAt : new Date().toISOString(),
    };
    await DB.putDiary(rec);
    resetDiaryForm();
    await reload();
    toast(wasEditing ? '日记已更新' : '日记已保存');
  });
  document.getElementById('btn-diary-cancel').addEventListener('click', resetDiaryForm);
  // 四个表单的"清空"按钮：重置为空白新增状态并退出编辑，不清已保存数据
  document.querySelectorAll('[data-form-clear]').forEach(b => {
    b.addEventListener('click', () => {
      const k = b.dataset.formClear;
      if (k === 'diary') resetDiaryForm();
      else exitEditMode(k);
      toast('表单已清空');
    });
  });
  // Leg 出发/到达互换：交换下拉选择与手动输入字段（含坐标），保存时仍校验不能相同
  document.getElementById('btn-swap-leg').addEventListener('click', () => {
    const f = document.getElementById('form-leg');
    const sv = f.fromStopId.value; f.fromStopId.value = f.toStopId.value; f.toStopId.value = sv;
    ['Name', 'Lat', 'Lng'].forEach(sfx => {
      const a = f['from' + sfx].value;
      f['from' + sfx].value = f['to' + sfx].value;
      f['to' + sfx].value = a;
    });
    updateLegManualVisibility();
  });
  // Trip/城市/Leg 的"取消编辑"
  [['trip', 'btn-edit-cancel-trip'], ['stop', 'btn-edit-cancel-stop'], ['leg', 'btn-edit-cancel-leg']]
    .forEach(([kind, bid]) => {
      const b = document.getElementById(bid);
      if (b) b.addEventListener('click', () => exitEditMode(kind));
    });
  document.getElementById('diary-list').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-diary-edit]');
    const delBtn = e.target.closest('[data-diary-del]');
    if (editBtn) {
      const d = DIARIES.find(x => x.id === editBtn.dataset.diaryEdit);
      if (d) fillDiaryForm(d);
    } else if (delBtn) {
      const id = delBtn.dataset.diaryDel;
      if (!confirm('删除这条日记？')) return;
      await DB.delDiary(id);
      if (_editingDiaryId === id) resetDiaryForm();
      await reload(); toast('日记已删除');
    }
  });
}

/* ===== 城市照片模块 ===== */
function photoCount(stopId) { return _photoIndex.filter(p => p.stopId === stopId).length; }
async function loadPhotoIndex() { _photoIndex = await DB.getPhotoIndex(); }

// canvas 压缩：长边 1600px，JPEG 0.8，输出 Blob
// 用 Object URL 而非 DataURL，省去 base64 编解码，批量压缩更快更省内存
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(url);
    const img = new Image();
    img.onload = () => {
      try {
        const MAX = 1600;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(b => {
          cleanup();
          b ? resolve(b) : reject(new Error('canvas 导出失败'));
        }, 'image/jpeg', 0.8);
      } catch (err) { cleanup(); reject(err); }
    };
    img.onerror = () => { cleanup(); reject(new Error('无法解码图片')); };
    img.src = url;
  });
}

function openPhotoDrawer(stopId) {
  const stop = stopById(stopId);
  if (!stop) { toast('城市不存在'); return; }
  openDrawer('photos');            // 统一状态管理：先 closeAllDrawers 再开自己
  _photoStopId = stopId;
  _photoSelectMode = false;
  _photoSelected.clear();
  document.getElementById('photo-drawer-title').textContent = '📷 ' + stopVisitLabel(stop);
  renderPhotoGrid();
}

async function renderPhotoGrid() {
  const grid = document.getElementById('photo-grid');
  const emptyEl = document.getElementById('photo-empty');
  if (!grid || !_photoStopId) return;
  _thumbUrls.forEach(u => URL.revokeObjectURL(u)); _thumbUrls = [];
  _stopPhotos = await DB.getPhotosByStop(_photoStopId);
  _stopPhotos.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  // 已删除的照片不再保留勾选
  const alive = new Set(_stopPhotos.map(p => p.id));
  [..._photoSelected].forEach(id => { if (!alive.has(id)) _photoSelected.delete(id); });
  emptyEl.hidden = _stopPhotos.length > 0;
  const cnt = document.getElementById('photo-count');
  if (cnt) cnt.textContent = `${_stopPhotos.length}/${PHOTO_LIMIT}`;
  grid.innerHTML = _stopPhotos.map(p => {
    const url = URL.createObjectURL(p.blob); _thumbUrls.push(url);
    const sel = _photoSelected.has(p.id);
    return `<figure class="photo-cell${_photoSelectMode ? ' selectable' : ''}${sel ? ' selected' : ''}" data-photo-cell="${esc(p.id)}">`
      + `<img class="photo-thumb" src="${url}" data-photo-view="${esc(p.id)}" alt="${esc(p.caption || '照片')}">`
      + (_photoSelectMode ? `<span class="photo-check">${sel ? '✓' : ''}</span>` : '')
      + `</figure>`;
  }).join('');
  updatePhotoSelectBar();
}

/* ---- 照片批量选择删除 ---- */
function updatePhotoSelectBar() {
  const bar = document.getElementById('photo-select-bar');
  const toggle = document.getElementById('photo-select-toggle');
  if (bar) bar.hidden = !_photoSelectMode;
  if (toggle) {
    toggle.textContent = _photoSelectMode ? '✖ 退出选择' : '☑️ 选择删除';
    toggle.classList.toggle('active', _photoSelectMode);
  }
  const cnt = document.getElementById('photo-select-count');
  if (cnt) cnt.textContent = `已选 ${_photoSelected.size} 张`;
  const del = document.getElementById('photo-delete-selected');
  if (del) {
    del.disabled = _photoSelected.size === 0;
    del.textContent = _photoSelected.size ? `删除选中（${_photoSelected.size}）` : '删除选中';
  }
  const all = document.getElementById('photo-select-all');
  if (all) all.textContent = (_stopPhotos.length && _photoSelected.size === _stopPhotos.length) ? '取消全选' : '全选';
}
function setPhotoSelectMode(on) {
  _photoSelectMode = !!on;
  if (!_photoSelectMode) _photoSelected.clear();
  updatePhotoSelectBar();
  renderPhotoGrid();
}
function togglePhotoSelection(id) {
  if (_photoSelected.has(id)) _photoSelected.delete(id);
  else _photoSelected.add(id);
  updatePhotoSelectBar();
  const cell = [...document.querySelectorAll('#photo-grid [data-photo-cell]')]
    .find(el => el.dataset.photoCell === id);
  if (cell) {
    cell.classList.toggle('selected', _photoSelected.has(id));
    const check = cell.querySelector('.photo-check');
    if (check) check.textContent = _photoSelected.has(id) ? '✓' : '';
  }
}
function toggleSelectAllPhotos() {
  if (_stopPhotos.length && _photoSelected.size === _stopPhotos.length) _photoSelected.clear();
  else _stopPhotos.forEach(p => _photoSelected.add(p.id));
  updatePhotoSelectBar();
  renderPhotoGrid();
}
// 删除若干张照片：本机 + 云端文件/元数据；若被删的是封面则一并清掉引用
async function deletePhotosByIds(ids) {
  const set = new Set(ids);
  const list = _stopPhotos.filter(p => set.has(p.id));
  for (const p of list) {
    await DB.delPhoto(p.id);
    if (window.unmirrorPhoto) await window.unmirrorPhoto(p.id);
    const coverStop = STOPS.find(s => s.coverPhotoId === p.id);
    if (coverStop) { coverStop.coverPhotoId = ''; await DB.putStop(coverStop); }
  }
  _stopPhotos = _stopPhotos.filter(p => !set.has(p.id));
  [..._photoSelected].forEach(id => { if (set.has(id)) _photoSelected.delete(id); });
  await loadPhotoIndex();
  await refreshCoverUrls();
  renderMap();
  return list.length;
}

function openLightbox(photoId) {
  const p = _stopPhotos.find(x => x.id === photoId);
  if (!p) return;
  _lbPhotoId = photoId;
  if (_lbUrl) { URL.revokeObjectURL(_lbUrl); _lbUrl = null; }
  _lbUrl = URL.createObjectURL(p.blob);
  document.getElementById('lb-img').src = _lbUrl;
  document.getElementById('lb-shootDate').value = p.shootDate || new Date().toISOString().slice(0, 10);
  document.getElementById('lb-author').value = p.author || '';
  document.getElementById('lb-caption').value = p.caption || '';
  updateCoverButtons();
  document.getElementById('photo-lightbox').classList.add('open');
}
function closeLightbox() {
  document.getElementById('photo-lightbox').classList.remove('open');
  if (_lbUrl) { URL.revokeObjectURL(_lbUrl); _lbUrl = null; }
  _lbPhotoId = null;
}

/* ===== 封面气泡辅助 ===== */
function updateBubbleVisibility() {
  if (!_mapReady) return;
  document.getElementById('map').classList.toggle('bubbles-on', map.getZoom() >= 9);
}
async function refreshCoverUrls() {
  const needed = new Set(STOPS.map(s => s.coverPhotoId).filter(Boolean));
  for (const [id, url] of _coverUrls) {
    if (!needed.has(id)) { URL.revokeObjectURL(url); _coverUrls.delete(id); }
  }
  for (const id of needed) {
    if (_coverUrls.has(id)) continue;
    try {
      const p = await DB.getPhoto(id);
      if (p && p.blob) _coverUrls.set(id, URL.createObjectURL(p.blob));
      else _coverUrls.delete(id);
    } catch (e) { console.warn('[footprint] 封面照片读取失败：', id, e); }
  }
}

/* ===== Stop 表单色板 ===== */
function setStopColorSelection(color) {
  const f = document.getElementById('form-stop');
  if (!f) return;
  f.markerColor.value = color;
  document.querySelectorAll('#stop-color-palette .swatch').forEach(x =>
    x.classList.toggle('selected', x.dataset.formcolor === color));
}

/* ===== 封面按钮状态 ===== */
function updateCoverButtons() {
  const setBtn = document.getElementById('lb-setcover');
  const unsetBtn = document.getElementById('lb-unsetcover');
  if (!setBtn) return;
  const p = _stopPhotos.find(x => x.id === _lbPhotoId);
  const st = _photoStopId ? STOPS.find(x => x.id === _photoStopId) : null;
  const isCover = !!(p && st && st.coverPhotoId === p.id);
  setBtn.hidden = isCover;
  unsetBtn.hidden = !isCover;
}

/* ===== 照片轮播（双击封面气泡打开） ===== */
async function openCarousel(stopId) {
  const stop = stopById(stopId);
  if (!stop) return;
  const photos = await DB.getPhotosByStop(stopId);
  if (!photos.length) { toast('该城市还没有照片'); return; }
  photos.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  if (_pcUrls.length) _pcUrls.forEach(u => URL.revokeObjectURL(u));
  _pcStopId = stopId; _pcPhotos = photos;
  _pcIdx = Math.max(0, photos.findIndex(p => p.id === stop.coverPhotoId));   // 封面照片作为第一张
  _pcUrls = photos.map(p => URL.createObjectURL(p.blob));
  renderCarousel(0);
  document.getElementById('pc-title').textContent =
    stopVisitLabel(stop) + (photos[_pcIdx].shootDate ? ' · ' + photos[_pcIdx].shootDate : '');
  document.getElementById('photo-carousel').classList.add('open');
  if (map) map.closePopup();
}
function renderCarousel(dir) {
  const p = _pcPhotos[_pcIdx];
  if (!p) return;
  const img = document.getElementById('pc-img');
  img.src = _pcUrls[_pcIdx];
  if (dir) {
    img.classList.remove('pc-slide-left', 'pc-slide-right');
    void img.offsetWidth;
    img.classList.add(dir > 0 ? 'pc-slide-left' : 'pc-slide-right');
  }
  document.getElementById('pc-caption').innerHTML =
    `📅 ${fmt(p.shootDate)}｜📷 ${fmt(p.author)}<br>${esc(p.caption || '')}`;
  document.getElementById('pc-thumbs').innerHTML = _pcPhotos.map((ph, i) =>
    `<img class="pc-thumb${i === _pcIdx ? ' current' : ''}" src="${_pcUrls[i]}" data-pc-idx="${i}" alt="">`).join('');
}
function closeCarousel() {
  document.getElementById('photo-carousel').classList.remove('open');
  _pcUrls.forEach(u => URL.revokeObjectURL(u));
  _pcUrls = []; _pcPhotos = []; _pcStopId = null; _pcIdx = 0;
}
function pcGo(delta) {
  if (!_pcPhotos.length) return;
  _pcIdx = (_pcIdx + delta + _pcPhotos.length) % _pcPhotos.length;
  renderCarousel(delta);
}

let _photoUploading = false;

// 批量添加照片：多选 / 拖拽都走这里，最多 3 张并发压缩入库
async function addPhotoFiles(fileList) {
  if (!_photoStopId) return;
  const all = [...(fileList || [])];
  if (!all.length) return;
  if (_photoUploading) { toast('正在添加照片，请稍候'); return; }
  const images = all.filter(f => f.type && f.type.startsWith('image/'));
  if (!images.length) { toast('未选择图片文件'); return; }
  // 单城市照片上限 30 张：已达上限不追加，超出部分截断并提示
  const jobStopId = _photoStopId;
  const used = photoCount(jobStopId);
  const remain = PHOTO_LIMIT - used;
  if (remain <= 0) { toast('该城市照片已达上限'); return; }
  const willUpload = images.slice(0, remain);
  const overCut = images.length - willUpload.length;
  const total = willUpload.length;

  _photoUploading = true;
  const inputEl = document.getElementById('photo-input');
  const progressEl = document.getElementById('photo-progress');
  const fileBtn = inputEl && inputEl.closest('.file-btn');
  if (inputEl) inputEl.disabled = true;
  if (fileBtn) fileBtn.classList.add('disabled');

  let ok = 0, fail = 0, done = 0;
  const updateProgress = () => {
    if (progressEl) progressEl.textContent = done < total ? `正在添加 ${done}/${total}…` : '';
  };
  updateProgress();

  const CONCURRENCY = 3;
  const baseTs = Date.now();
  let cursor = 0;
  async function worker() {
    while (cursor < willUpload.length) {
      const idx = cursor++;
      const f = willUpload[idx];
      try {
        const blob = await compressImage(f);
        const rec = {
          id: uid(), stopId: jobStopId, blob,
          caption: '', shootDate: new Date().toISOString().slice(0, 10), author: '',
          // 并发完成顺序不可控，按加入批次时的选择顺序写入，保证相册顺序与所选一致
          createdAt: new Date(baseTs + idx).toISOString(),
        };
        await DB.putPhoto(rec);
        if (window._sbUser) window.mirrorPhoto(rec, blob);   // 登录时镜像到云端（含文件）
        ok++;
      } catch (err) {
        console.error('[footprint] 照片压缩/入库失败：', f.name, err);
        fail++;
      }
      done++;
      updateProgress();
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  } finally {
    _photoUploading = false;
    if (inputEl) inputEl.disabled = false;
    if (fileBtn) fileBtn.classList.remove('disabled');
    if (progressEl) progressEl.textContent = '';
  }

  await loadPhotoIndex();
  await refreshCoverUrls();
  if (_photoStopId === jobStopId) await renderPhotoGrid();
  renderMap();  // 避免弹窗计数过期，并同步封面气泡
  toast(`已添加 ${ok} 张照片` + (fail ? `，${fail} 张失败` : '') +
    (overCut ? `，超出上限的 ${overCut} 张未接收` : ''));
}

function bindPhotos() {
  // 多选上传
  document.getElementById('photo-input').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    addPhotoFiles(files);
  });

  // 拖拽多张照片到照片面板即可追加
  const photoBody = document.querySelector('#drawer-photos .drawer-body');
  const photoGrid = document.getElementById('photo-grid');
  if (photoBody) {
    const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
    photoBody.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); photoGrid.classList.add('drop-active');
    });
    photoBody.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
    });
    photoBody.addEventListener('dragleave', (e) => {
      if (photoBody.contains(e.relatedTarget)) return;
      photoGrid.classList.remove('drop-active');
    });
    photoBody.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); photoGrid.classList.remove('drop-active');
      addPhotoFiles(e.dataTransfer.files);
    });
  }

  // 列表里的"管理照片"入口（弹窗内入口由 popupopen 单独绑定）
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-photos]');
    if (btn) openPhotoDrawer(btn.dataset.photos);
  });

  // 缩略图 → 大图；批量选择模式下改为勾选/取消
  document.getElementById('photo-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('[data-photo-cell]');
    if (!cell) return;
    if (_photoSelectMode) { togglePhotoSelection(cell.dataset.photoCell); return; }
    const img = e.target.closest('[data-photo-view]');
    if (img) openLightbox(img.dataset.photoView);
  });

  // 批量选择删除
  const selToggle = document.getElementById('photo-select-toggle');
  if (selToggle) selToggle.addEventListener('click', () => setPhotoSelectMode(!_photoSelectMode));
  const selAll = document.getElementById('photo-select-all');
  if (selAll) selAll.addEventListener('click', toggleSelectAllPhotos);
  const selCancel = document.getElementById('photo-select-cancel');
  if (selCancel) selCancel.addEventListener('click', () => setPhotoSelectMode(false));
  const selDel = document.getElementById('photo-delete-selected');
  if (selDel) selDel.addEventListener('click', async () => {
    const n = _photoSelected.size;
    if (!n) return;
    if (!confirm(`确定删除选中的 ${n} 张照片？删除后不可恢复。`)) return;
    const count = await deletePhotosByIds([..._photoSelected]);
    if (!_stopPhotos.length) _photoSelectMode = false;
    await renderPhotoGrid();
    toast(`已删除 ${count} 张照片`);
  });

  // 灯箱关闭：✕ 由上方 .drawer-close 委托统一处理，这里只处理点遮罩关闭
  document.getElementById('photo-lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'photo-lightbox') closeLightbox();
  });

  // 保存注释
  document.getElementById('lb-save').addEventListener('click', async () => {
    const p = _stopPhotos.find(x => x.id === _lbPhotoId);
    if (!p) return;
    p.shootDate = document.getElementById('lb-shootDate').value;
    p.author = document.getElementById('lb-author').value.trim();
    p.caption = document.getElementById('lb-caption').value;
    await DB.putPhoto(p);
    if (window._sbUser) window.mirrorPhoto(p, null);   // 仅更新云端元数据
    closeLightbox();
    toast('注释已保存');
  });

  // 设为封面 / 取消封面
  document.getElementById('lb-setcover').addEventListener('click', async () => {
    const p = _stopPhotos.find(x => x.id === _lbPhotoId);
    const st = _photoStopId ? STOPS.find(x => x.id === _photoStopId) : null;
    if (!p || !st) return;
    st.coverPhotoId = p.id;
    await DB.putStop(st);
    await refreshCoverUrls();
    renderMap();
    updateCoverButtons();
    toast('已设为城市封面');
  });
  document.getElementById('lb-unsetcover').addEventListener('click', async () => {
    const st = _photoStopId ? STOPS.find(x => x.id === _photoStopId) : null;
    if (!st) return;
    st.coverPhotoId = '';
    await DB.putStop(st);
    await refreshCoverUrls();
    renderMap();
    updateCoverButtons();
    toast('已取消封面');
  });

  // 删除照片（二次确认；若为封面则一并清除）
  document.getElementById('lb-delete').addEventListener('click', async () => {
    const p = _stopPhotos.find(x => x.id === _lbPhotoId);
    if (!p) return;
    if (!confirm('确定删除这张照片？删除后不可恢复。')) return;
    closeLightbox();
    await deletePhotosByIds([p.id]);
    await renderPhotoGrid();
    toast('照片已删除');
  });

  // 照片轮播（双击封面气泡打开）
  document.getElementById('pc-close').addEventListener('click', closeCarousel);
  document.getElementById('photo-carousel').addEventListener('click', (e) => {
    if (e.target.id === 'photo-carousel') closeCarousel();
  });
  document.getElementById('pc-prev').addEventListener('click', () => pcGo(-1));
  document.getElementById('pc-next').addEventListener('click', () => pcGo(1));
  // 手机触摸左右滑动翻页
  let _touchX = null;
  const stage = document.querySelector('.pc-stage');
  stage.addEventListener('touchstart', (e) => { _touchX = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (_touchX == null) return;
    const dx = e.changedTouches[0].clientX - _touchX;
    if (Math.abs(dx) > 40) pcGo(dx > 0 ? -1 : 1);
    _touchX = null;
  }, { passive: true });
  document.getElementById('pc-thumbs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-pc-idx]');
    if (!t) return;
    const i = Number(t.dataset.pcIdx);
    if (i !== _pcIdx) { const dir = i > _pcIdx ? 1 : -1; _pcIdx = i; renderCarousel(dir); }
  });
}

/* ===== 设置：常驻城市 / 导出 / 导入 / 清空 ===== */
// 登录态/数据来源：让用户一眼确认当前读到的是云端还是本机
function renderAuthInfo() {
  const el = document.getElementById('auth-info');
  if (!el) return;
  if (!window._sbUser) {
    el.textContent = '👤 当前：游客模式（数据仅存本机浏览器，登录后自动上传云端）';
    return;
  }
  el.textContent = `👤 已登录 ${window._sbUser.email}｜当前显示：行程 ${TRIPS.length} / 城市 ${uniqueCityCount()} / 到访 ${STOPS.length} / 交通段 ${LEGS.length} / 日记 ${DIARIES.length} / 心愿 ${WISHES.length}`;
}
// 数据统计条 + 备份提醒（距上次导出超过 30 天或从未导出时显示）
async function renderStats() {
  const el = document.getElementById('stats-bar');
  if (el) el.textContent = `📊 行程 ${TRIPS.length} ｜ 城市 ${uniqueCityCount()} ｜ 到访 ${STOPS.length} ｜ 交通段 ${LEGS.length} ｜ 日记 ${DIARIES.length} ｜ 照片 ${_photoIndex.length}`;
  renderAuthInfo();
  const tip = document.getElementById('backup-tip');
  if (!tip) return;
  let last = null;
  try { const rec = await DB.getConfig('lastExportAt'); last = rec ? rec.value : null; } catch (e) { last = null; }
  const over = !last || (Date.now() - new Date(last).getTime() > 30 * 864e5);
  tip.hidden = !over;
  tip.textContent = last
    ? `⚠️ 距上次导出已超过 30 天，建议导出 JSON 备份，防止清缓存丢失`
    : '⚠️ 建议导出 JSON 备份，防止清缓存丢失';
}
/* ===== 数据自检：城市被编辑到错误行程后，会“混入”别的行程时间线 =====
   判定依据：引用该城市的交通段属于哪个行程。只有一个行程引用时才自动归位；
   多个行程都引用或没有交通段时不猜，交给用户手动处理。 */
function legRefsStop(l, stopId) {
  const f = (l.from && l.from.kind === 'stop') ? l.from.stopId : l.fromStopId;
  const t = (l.to && l.to.kind === 'stop') ? l.to.stopId : l.toStopId;
  return f === stopId || t === stopId;
}
/* 无主交通段：所属行程已删除，或起止城市指向已不存在的 Stop。
   这类记录不会再画在地图上（缺端点坐标时会跳过），也不会随“删城市/删行程”被级联，
   因为它的父记录早已不在了；用一个显式清理入口把它们删掉。 */
function isOrphanLeg(l) {
  if (!l) return false;
  if (!l.tripId || !TRIPS.some(t => t.id === l.tripId)) return true;
  for (const end of ['from', 'to']) {
    const e = l[end];
    const sid = (e && (e.kind === 'stop' || !e.kind)) ? (e.stopId || l[end + 'StopId']) : l[end + 'StopId'];
    if (sid && !STOPS.some(s => s.id === sid)) return true;
  }
  return false;
}
function findOrphanLegs() { return LEGS.filter(isOrphanLeg); }
async function cleanOrphanLegs() {
  const orphans = findOrphanLegs();
  if (!orphans.length) { toast('没有发现无主交通段（所属行程/城市都还在）'); return; }
  const lines = orphans.slice(0, 10).map(l => {
    const st = legStyle(l.mode);
    const from = legEndpointLabel(l, 'from') || '?';
    const to = legEndpointLabel(l, 'to') || '?';
    const reasons = [];
    if (!l.tripId || !TRIPS.some(t => t.id === l.tripId)) reasons.push('行程已删除');
    for (const end of ['from', 'to']) {
      const e = l[end];
      const sid = (e && (e.kind === 'stop' || !e.kind)) ? (e.stopId || l[end + 'StopId']) : l[end + 'StopId'];
      if (sid && !STOPS.some(s => s.id === sid)) reasons.push((end === 'from' ? '出发' : '到达') + '城市已删除');
    }
    return `• ${st.icon} ${from} → ${to}（${reasons.join('、') || '无主'}）`;
  }).join('\n');
  if (!confirm(`发现 ${orphans.length} 条无主交通段：\n\n${lines}${orphans.length > 10 ? '\n…' : ''}\n\n这些记录不会再被级联删除，清理后不可恢复。确定删除？`)) return;
  let ok = 0, fail = 0;
  for (const l of orphans) {
    try { await DB.delLeg(l.id); ok++; }
    catch (e) { fail++; console.warn('[footprint] 清理无主交通段失败：', l.id, e); }
  }
  await reload();
  toast(`已清理 ${ok} 条无主交通段` + (fail ? `，${fail} 条失败，可再试一次` : ''));
}
function tripContainsDate(t, date) {
  if (!t || !date) return false;
  if (t.dateStart && date < t.dateStart) return false;
  if (t.dateEnd && date > t.dateEnd) return false;
  return !!(t.dateStart || t.dateEnd);
}
function findMisassignedStops() {
  const fixes = [];
  for (const s of STOPS) {
    const refs = LEGS.filter(l => legRefsStop(l, s.id));
    const tripIds = [...new Set(refs.map(l => l.tripId).filter(id => id && TRIPS.some(t => t.id === id)))];
    let targetId = null, basis = '';
    if (tripIds.length === 1) {
      targetId = tripIds[0]; basis = '交通段';
    } else if (tripIds.length === 0) {
      // 没有交通段可依据时，退回用到达/离开日期：恰好落入一个行程的日期范围才归位
      const date = s.arriveDate || s.leaveDate;
      const byDate = TRIPS.filter(t => tripContainsDate(t, date));
      if (byDate.length === 1) { targetId = byDate[0].id; basis = '日期'; }
    }
    if (!targetId || targetId === s.tripId) continue;
    const from = TRIPS.find(t => t.id === s.tripId);
    const to = TRIPS.find(t => t.id === targetId);
    fixes.push({ stop: s, targetId, basis, fromTitle: from ? from.title : '（无/已删除行程）', toTitle: to.title });
  }
  return fixes;
}
async function repairMisassignedStops() {
  const fixes = findMisassignedStops();
  if (!fixes.length) { toast('未发现错位城市（城市所属行程与交通段一致）'); return; }
  const lines = fixes.map(f => `「${f.stop.nameZh}」：${f.fromTitle} → ${f.toTitle}（依据：${f.basis}）`).join('\n');
  if (!confirm(`发现 ${fixes.length} 个城市的所属行程与交通段不一致。\n\n${lines}\n\n城市不会删除，只会归位到交通段所在行程。继续？`)) return;
  let ok = 0, fail = 0;
  for (const f of fixes) {
    try { await DB.putStop({ ...f.stop, tripId: f.targetId }); ok++; }
    catch (e) { console.warn('[footprint] 城市归位失败：', f.stop.id, e); fail++; }
  }
  await reload();
  toast(`已归位 ${ok} 个城市` + (fail ? `，失败 ${fail} 个，可再试一次` : ''));
}

function bindSettings() {
  renderStats();
  const btnRepair = document.getElementById('btn-repair');
  if (btnRepair) btnRepair.addEventListener('click', repairMisassignedStops);
  const btnCleanLegs = document.getElementById('btn-clean-legs');
  if (btnCleanLegs) btnCleanLegs.addEventListener('click', cleanOrphanLegs);
  // 常驻城市：改名/改坐标后保存，Leg 下拉与连线随 reload 同步更新
  const hf = document.getElementById('form-home-city');
  if (hf) {
    hf.name.value = HOME_CITY.name;
    hf.lat.value = HOME_CITY.lat;
    hf.lng.value = HOME_CITY.lng;
    hf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = hf.name.value.trim();
      const lat = parseFloat(hf.lat.value), lng = parseFloat(hf.lng.value);
      if (!name) { toast('请填写常驻城市名称'); return; }
      if (isNaN(lat) || isNaN(lng)) { toast('常驻城市经纬度必须是数字'); return; }
      HOME_CITY = { name, lat, lng };
      await DB.putConfig({ key: 'homeCity', name, lat, lng });
      await reload();
      toast('常驻城市已保存：' + name);
    });
  }

  document.getElementById('btn-export').addEventListener('click', async () => {
    const data = await DB.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'footprint-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    await DB.putConfig({ key: 'lastExportAt', value: new Date().toISOString() });
    renderStats();
    toast('已导出 JSON');
  });

  document.getElementById('file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('导入将覆盖当前全部数据，确定继续？')) { e.target.value = ''; return; }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const skipped = await DB.importAll(data);
      await reload();
      const fixed = skipped ? (skipped.stops + skipped.legs + skipped.diaries + skipped.converted) : 0;
      if (fixed) {
        // 详情放在控制台：孤儿行程/城市在云端外键下会导致整批导入失败，这里已自动跳过/降级
        console.warn('[footprint] 导入时跳过或修正的记录：', skipped.details);
        toast(`导入成功；已跳过/修正 ${fixed} 条无主旧记录（详情见控制台）`);
      } else {
        toast('导入成功');
      }
    } catch (err) {
      toast('导入失败：' + err.message);
    }
    e.target.value = '';
  });

  const btnSyncUp = document.getElementById('btn-sync-up');
  if (btnSyncUp) btnSyncUp.addEventListener('click', async () => {
    if (!window._sbUser) {
      const av = document.getElementById('btn-avatar');
      toast('当前页面未检测到登录（头像显示：' + (av ? av.textContent.trim() : '游客') + '）。账号在 github.io 与 deno.net 通用，换站点重新登录即可（不用重新注册），但登录状态不互通');
      return;
    }
    btnSyncUp.disabled = true;
    const old = btnSyncUp.textContent; btnSyncUp.textContent = '上传中…';
    try {
      const m = await window.mergeLocalToCloud(true);   // 手动上传：强制把本机全部记录推回云端
      const errs = (m.errors || []).slice(0, 2).join('；');
      if (m.up) {
        await reload();
        toast(`本机记录已上传云端 ${m.up} 条` + (m.fail ? `，失败 ${m.fail} 项（可再点一次重试）` : '') + (errs ? `｜${errs}` : ''));
      } else if (m.fail) {
        toast(`上传失败 ${m.fail} 项` + (errs ? `｜${errs}` : '') + '，请稍后重试');
      } else {
        toast('本机数据已全部在云端，无需上传');
      }
      renderAuthInfo();
    } catch (e) {
      toast('上传失败：' + e.message);
    }
    btnSyncUp.disabled = false; btnSyncUp.textContent = old;
  });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!confirm('将清空全部行程、城市、交通段、点亮状态、日记和照片，且无法恢复。确定清空？')) return;
    if (!confirm('二次确认：真的要清空所有数据吗？')) return;
    await DB.clearAll();
    await reload();
    toast('已清空全部数据');
  });
}

/* ===== 启动 ===== */
(async function init() {
  initTheme();
  bindDrawers(); bindForms(); bindSettings(); bindKeyboard(); bindPhotos(); bindWish(); bindPlay(); bindTimelineDrag(); bindListGroups();
  // 游客模式：无论是否登录都直接启动（未登录数据走本地 IndexedDB）
  window.startApp = async function () {
    if (window._appStarted) return null;
    window._appStarted = true;
    try {
      const counts = await loadAll();
      await loadPhotoIndex();
      await refreshCoverUrls();
      refreshSelects(); renderLegend(); initMap(); renderTimeline(); renderLists(); renderDiaries(); renderWishes(); renderStats();
      const boot = document.getElementById('boot');
      if (boot) boot.hidden = true;   // 首屏已就绪，撤掉加载提示
      return counts;
    } catch (err) {
      console.error(err);
      const bootMsg = document.getElementById('boot-msg');
      if (bootMsg) bootMsg.textContent = '初始化失败：' + err.message;
      toast('初始化出错：' + err.message);
    }
  };
  await window._authReady;          // supabase.js：会话恢复完成（游客不等待登录）
  await window.startApp();
  if (window._sbUser) {   // 启动时已登录：只补传游客期间新增、尚未同步的记录（不覆盖云端已有/已删数据）
    window.mergeLocalToCloud().then(async m => {
      if (m.up) await reload();   // 有新增才刷新
      const errs = (m.errors || []).slice(0, 2).join('；');
      if (m.up || m.fail) toast(`本机记录已上传云端 ${m.up} 条` + (m.fail ? `，失败 ${m.fail} 项（设置里可手动重传）` : '') + (errs ? `｜${errs}` : ''));
    }).catch(e => console.warn('[footprint] 启动迁移失败：', e));
    window.syncAllPhotos().then(r => {   // 补一次照片双向同步
      if (r.up || r.down || r.fail) toast(`照片已同步：上传 ${r.up} 张，下载 ${r.down} 张` + (r.fail ? `，失败 ${r.fail} 张（下次登录自动补传）` : ''));
    }).catch(e => console.warn('[footprint] 照片同步失败：', e));
  }
  // 登录成功后（supabase.js SIGNED_IN 事件调用）：从云端重载五类数据并整体刷新
  window.onSignedIn = async function () {
    try {
      window._appStarted = false;   // 允许完整重跑启动流程
      let merged = { up: 0 };
      try { merged = await window.mergeLocalToCloud(); }   // 游客期间录入的本机数据并入云端
      catch (e) { console.warn('[footprint] 本机数据合并失败：', e); }
      const c = await window.startApp();
      const cnt = c ? `（云端：行程 ${c.trips} / 城市 ${c.cities} / 到访 ${c.stops} / 交通段 ${c.legs} / 日记 ${c.diaries} / 心愿 ${c.wish}）` : '';
      const errs = (merged.errors || []).slice(0, 2).join('；');
      toast('已登录，数据已切换为云端同步' + (merged.up ? `，本机记录已上传云端 ${merged.up} 条` : '') + (merged.fail ? `，失败 ${merged.fail} 项（设置里可手动重传）` : '') + (errs ? `｜${errs}` : '') + ' ' + cnt);
      const r = await window.syncAllPhotos();
      if (r.up || r.down || r.fail) toast(`照片已同步：上传 ${r.up} 张，下载 ${r.down} 张` + (r.fail ? `，失败 ${r.fail} 张（下次登录自动补传）` : ''));
    } catch (err) {
      console.error(err);
      toast('云端数据加载失败：' + err.message);
    }
  };
})();
