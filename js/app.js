/* ===== 全局状态 & 工具 ===== */
let TRIPS = [], STOPS = [], LEGS = [], DIARIES = [];
let VISITED_PROVINCES = [];  // 手动点亮省名数组
let VISITED_CITIES = [];     // 手动点亮城市 [{name, region, lat, lng}]
let map, layerGroup, _legGroup = null, provinceLayer = null, _cityLayer = null, _outlineLayer = null;
let _mapReady = false;
let _highlightMode = false;
let _drillAdcode = null, _drillProvName = null, _cityGeo = null;
const _cityGeoCache = new Map();
let _editingDiaryId = null;
let _editingTripId = null, _editingStopId = null, _editingLegId = null;

/* 照片模块状态 */
let _photoStopId = null, _stopPhotos = [], _thumbUrls = [];
let _photoIndex = [];   // 轻量索引 [{id, stopId}]，用于弹窗计数
let _lbPhotoId = null, _lbUrl = null;

/* 封面气泡 & 轮播状态 */
let _stopMarkers = new Map();   // stopId -> Leaflet marker（用于原位改色）
let _coverUrls = new Map();     // photoId -> objectURL（封面缩略图缓存）
let _pcStopId = null, _pcPhotos = [], _pcUrls = [], _pcIdx = 0;

/* 主题状态（light / dark），持久化到 localStorage */
let _theme = 'light';
let _tileLayer = null;
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

/* 按主题切换高德瓦片；暗色瓦片加载失败时回退浅色瓦片 + 深色遮罩兜底，不白屏 */
function setTiles(mode) {
  if (!_mapReady) return;
  const mapEl = document.getElementById('map');
  if (_tileLayer) { map.removeLayer(_tileLayer); _tileLayer = null; }
  mapEl.classList.remove('tile-dark-mask');
  let fallbackDone = false;
  _tileLayer = L.tileLayer(TILE_URLS[mode], {
    subdomains: '1234', maxZoom: 18, attribution: '© 高德地图 GS(2023)4197号',
  });
  _tileLayer.on('tileerror', () => {
    if (fallbackDone || mode !== 'dark') return;
    fallbackDone = true;
    console.warn('[footprint] 暗色瓦片加载失败，回退浅色瓦片并加深色遮罩兜底');
    setTiles('light');
    mapEl.classList.add('tile-dark-mask');
    toast('暗色瓦片不可用，已用深色遮罩兜底');
  });
  _tileLayer.addTo(map);
  _tileLayer.bringToBack();
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
  plane:     { color: '#3d5a6c', dash: null, icon: '✈️', label: '飞机' },
  highspeed: { color: '#2E7D63', dash: null, icon: '🚄', label: '高铁/动车' },
  train:     { color: '#8a5a2b', dash: null, icon: '🚞', label: '普速火车' },
  bus:       { color: '#C99A45', dash: null, icon: '🚌', label: '大巴' },
  boat:      { color: '#4a90a4', dash: null, icon: '⛵', label: '轮船' },
  car:       { color: '#B34532', dash: null, icon: '🚗', label: '自驾' },
};
const LEG_FALLBACK = {
  walk: { color: '#6b7280', dash: '1,6', icon: '🚶', label: '步行' },
};
function legStyle(mode) {
  return MODE_STYLE[mode] || LEG_FALLBACK[mode] || { color: '#6b7280', dash: null, icon: '📍', label: '交通' };
}

/* 圆点自定义颜色（8 色预设色板） */
const MARKER_COLORS = ['#2E7D63', '#C99A45', '#B34532', '#f0a35e', '#d4677f', '#3d5a6c', '#7a6aa8', '#8a8f8a'];
const DEFAULT_MARKER_COLOR = '#2E7D63';

/* 全国城市坐标表来自 data/cities.js（window.CITIES：{name, province, lat, lng}），选择器见 initCityPicker() */

function uid() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
}
function fmt(v) { return v ? v : '—'; }
function money(v) { return (v !== '' && v != null && !isNaN(v)) ? ('¥' + Number(v).toLocaleString()) : '—'; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}
function normProv(s) { return (s || '').replace(/(省|市|自治区|特别行政区)$/, ''); }
function normCity(s) { return (s || '').replace(/(市|地区|自治州|盟|林区|旗)$/, ''); }

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
  const hc = await DB.getConfig('homeCity');
  if (hc && hc.name) HOME_CITY = { name: hc.name, lat: Number(hc.lat), lng: Number(hc.lng) };
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
  map = L.map('map', { zoomControl: true, doubleClickZoom: false }).setView([35, 105], 4);
  setTiles(_theme);
  map.createPane('provincePane');
  map.getPane('provincePane').style.zIndex = 350;
  map.createPane('outlinePane');   // 省级外轮廓：压在地市边界之上、圆点之下
  map.getPane('outlinePane').style.zIndex = 360;
  layerGroup = L.layerGroup().addTo(map);   // 城市圆点/封面气泡
  _legGroup = L.layerGroup().addTo(map);    // 交通连线（独立图层组）
  // Leaflet 会阻止弹窗内点击冒泡到 document，需在 popupopen 时单独绑弹窗内按钮
  map.on('popupopen', (e) => {
    const el = e.popup.getElement();
    if (el) bindPopupActions(el);
  });
  // 封面气泡随缩放级别显隐（zoom >= 9 显示）；地市标签重叠避让随缩放重算
  map.on('zoomend', () => { updateBubbleVisibility(); resolveCityLabelOverlap(); });
  updateBubbleVisibility();
  _mapReady = true;
  renderLegend();
  renderMap();
  ensureProvinceData().then(() => renderProvinces());
}

// 弧线控制点（中点抬高，形状与原 planeCurve 完全一致）
function curveCtrl(a, b) {
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const dx = b[1] - a[1], dy = b[0] - a[0];
  const len = Math.hypot(dx, dy) || 1;
  const lift = len * 0.18;
  return [mid[0] + (-dy / len) * lift, mid[1] + (dx / len) * lift];
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

// 两点间罗盘方位角（度）：CSS rotate 的 0deg 指向正北，顺时针为正
function bearingDeg(from, to) {
  const dx = (to[1] - from[1]) * Math.cos(((from[0] + to[0]) / 2) * Math.PI / 180);
  const dy = to[0] - from[0];
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

// 连线末端（到达端）方向箭头：直线沿线方向，弧线沿终点附近切线；颜色随连线
function legArrow(a, b, ctrl, color) {
  let pos, angle;
  if (ctrl) {
    const t = 0.9, u = 1 - t;
    pos = [u * u * a[0] + 2 * u * t * ctrl[0] + t * t * b[0], u * u * a[1] + 2 * u * t * ctrl[1] + t * t * b[1]];
    const dLat = 2 * u * (ctrl[0] - a[0]) + 2 * t * (b[0] - ctrl[0]);
    const dLng = 2 * u * (ctrl[1] - a[1]) + 2 * t * (b[1] - ctrl[1]);
    angle = Math.atan2(dLng * Math.cos(pos[0] * Math.PI / 180), dLat) * 180 / Math.PI;
  } else {
    pos = [a[0] + (b[0] - a[0]) * 0.9, a[1] + (b[1] - a[1]) * 0.9];
    angle = bearingDeg(a, b);
  }
  L.marker(pos, {
    icon: L.divIcon({
      className: 'fp-arrow-icon', iconSize: [12, 12], iconAnchor: [6, 6],
      html: `<div class="fp-arrow" style="transform:rotate(${angle.toFixed(1)}deg);border-bottom-color:${color}"></div>`,
    }),
    interactive: false, keyboard: false,
  }).addTo(_legGroup);
}

function renderMap() {
  if (!_mapReady) return;
  layerGroup.clearLayers();
  // Leg 连线独立 LayerGroup：省内下钻视图不绘制，返回全国再统一刷新
  if (_legGroup) {
    map.removeLayer(_legGroup);
    _legGroup.clearLayers();
    if (!_drillAdcode) {
      map.addLayer(_legGroup);
      LEGS.forEach(leg => {
        const pa = legEndpoint(leg, 'from'), pb = legEndpoint(leg, 'to');
        const A = legCoords(pa), B = legCoords(pb);
        if (!A || !B) return;   // 任一端缺坐标/无记录则不画该段，另一端不报错
        const st = legStyle(leg.mode);
        let pts, ctrl = null;
        if (leg.mode === 'plane') { ctrl = curveCtrl(A, B); pts = planeCurve(A, B, ctrl); }
        else { pts = [A, B]; }
        // 全部实线，线宽 3
        L.polyline(pts, { color: st.color, weight: 3, opacity: 0.9 })
          .bindPopup(`<b>${st.icon} ${st.label}</b><br>${esc(pa.name)} → ${esc(pb.name)}<br>出发: ${fmt(leg.departAt)}　到达: ${fmt(leg.arriveAt)}<br>花费: ${money(leg.cost)}`)
          .addTo(_legGroup);
        legArrow(A, B, ctrl, st.color);   // 到达端方向箭头
      });
    }
  }
  _stopMarkers = new Map();
  STOPS.forEach(s => {
    const color = s.markerColor || DEFAULT_MARKER_COLOR;
    const coverUrl = s.coverPhotoId ? (_coverUrls.get(s.coverPhotoId) || null) : null;
    let html, iconSize;
    if (coverUrl) {
      html = `<div class="fp-marker"><div class="fp-bubble"><img src="${coverUrl}" alt=""></div>`
        + `<div class="fp-tail"></div><div class="fp-dot" style="background:${color}"></div></div>`;
      iconSize = [56, 68];
    } else {
      html = `<div class="fp-marker"><div class="fp-dot" style="background:${color}"></div></div>`;
      iconSize = [56, 16];
    }
    const marker = L.marker([s.lat, s.lng], {
      icon: L.divIcon({ className: 'fp-marker-icon', html, iconSize, iconAnchor: [Math.round(iconSize[0] / 2), iconSize[1] - 1] }),
      keyboard: false,
    }).bindPopup(() => stopPopupHtml(s)).addTo(layerGroup);
    marker.on('dblclick', () => openCarousel(s.id));   // 双击封面气泡 → 轮播
    _stopMarkers.set(s.id, marker);
  });
}

// 弹窗内容函数化：每次打开都取最新的日记摘要、照片数与颜色选中态
function stopPopupHtml(s) {
  const linked = DIARIES.filter(d => d.stopId === s.id).slice(0, 3);
  const diaryHtml = linked.length
    ? '<br>📔 ' + linked.map(d => `${fmt(d.date)} ${esc(d.mood || '')} ${esc((d.note || '').slice(0, 20))}`).join('<br>📔 ')
    : '';
  const cur = s.markerColor || DEFAULT_MARKER_COLOR;
  const swatches = MARKER_COLORS.map(c =>
    `<button class="swatch${c === cur ? ' selected' : ''}" data-stopcolor="${c}" data-stop-id="${s.id}" style="background:${c}" title="${c}"></button>`).join('');
  return `<b>${esc(s.nameZh)}${s.nameEn ? ' / ' + esc(s.nameEn) : ''}</b><br>`
    + `${fmt(s.arriveDate)}${s.leaveDate ? ' ~ ' + fmt(s.leaveDate) : ''}<br>`
    + `心情: ${fmt(s.mood)}　花费: ${money(s.cost)}<br>${esc(s.note || '')}${diaryHtml}`
    + `<br><button class="link-btn" data-photos="${s.id}">📷 照片（${photoCount(s.id)}）</button>`
    + `<div class="swatch-row" style="margin-top:6px;">${swatches}</div>`;
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
        m.setPopupContent(stopPopupHtml(st));
        const pe = m.getPopup() && m.getPopup().getElement();
        if (pe) bindPopupActions(pe);
      }
      toast('圆点颜色已更新');
    }));
}

function renderLegend() {
  const el = document.getElementById('map-legend');
  el.innerHTML = Object.keys(MODE_STYLE).map(k => {
    const s = MODE_STYLE[k];
    const d = s.dash ? `border-top-style:dashed;border-top-color:${s.color};` : `border-top-color:${s.color};`;
    return `<span class="item"><span class="line" style="${d}"></span>${s.icon} ${s.label}</span>`;
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
      const res = await fetch('https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json');
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
      const res = await fetch(`https://geo.datav.aliyun.com/areas_v3/bound/${adcode}_full.json`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
      if (!data || !Array.isArray(data.features) || !data.features.length) throw new Error('EMPTY_DATA');
      _cityGeoCache.set(adcode, data);   // 成功才缓存；404/空数据不缓存，可重试
    }
    _drillAdcode = adcode; _drillProvName = provName; _cityGeo = data;
    hideHoverBar();
    if (provinceLayer) { map.removeLayer(provinceLayer); provinceLayer = null; }
    if (_legGroup) map.removeLayer(_legGroup);   // 省内视图隐藏全部交通连线
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
function renderTimeline() {
  const el = document.getElementById('timeline');
  if (!TRIPS.length) { el.innerHTML = '<p class="empty">暂无行程，去「录入」添加吧。</p>'; return; }
  const trips = [...TRIPS].sort((a, b) => (b.dateStart || '').localeCompare(a.dateStart || ''));
  el.innerHTML = trips.map(trip => {
    const stops = STOPS.filter(s => s.tripId === trip.id)
      .map(s => ({ type: 'stop', date: s.arriveDate, html:
        `<div class="tl-icon">📍</div><div class="tl-body"><b>${esc(s.nameZh)}</b>`
        + `<div class="sub">${fmt(s.arriveDate)}${s.leaveDate ? ' ~ ' + fmt(s.leaveDate) : ''}｜心情 ${fmt(s.mood)}｜${money(s.cost)}</div>`
        + (s.note ? `<div class="sub">${esc(s.note)}</div>` : '') + `</div>` }));
    const legs = LEGS.filter(l => l.tripId === trip.id)
      .map(l => {
        const a = stopById(l.fromStopId), b = stopById(l.toStopId);
        const st = legStyle(l.mode);
        return { type: 'leg', date: l.departAt, html:
          `<div class="tl-icon">${st.icon}</div><div class="tl-body"><b>${st.label}</b>：${a ? esc(a.nameZh) : '?'} → ${b ? esc(b.nameZh) : '?'}`
          + `<div class="sub">${fmt(l.departAt)}${l.arriveAt ? ' 到达 ' + fmt(l.arriveAt) : ''}｜${money(l.cost)}</div>`
          + (l.note ? `<div class="sub">${esc(l.note)}</div>` : '') + `</div>` };
      });
    const items = [...stops, ...legs].sort((x, y) => (x.date || '').localeCompare(y.date || ''));
    const body = items.length ? items.map(i => `<div class="tl-item">${i.html}</div>`).join('')
                               : '<p class="empty">该行程暂无城市或交通段。</p>';
    const meta = `${fmt(trip.dateStart)}${trip.dateEnd ? ' ~ ' + fmt(trip.dateEnd) : ''}｜${STOPS.filter(s=>s.tripId===trip.id).length} 城市 / ${LEGS.filter(l=>l.tripId===trip.id).length} 交通段`;
    return `<div class="trip-group"><div class="trip-title">${esc(trip.title)}</div>`
      + `<div class="trip-meta">${meta}</div>${body}</div>`;
  }).join('');
}

/* ===== 录入下拉 & 数据列表 ===== */
function refreshSelects() {
  const tripOptions = TRIPS.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('');
  const stopOptions = STOPS.map(s => `<option value="${s.id}">${esc(s.nameZh)}（${esc(s.city || s.region || '?')}）</option>`).join('');

  const tripReq = tripOptions || '<option value="" disabled>请先添加行程</option>';
  document.querySelectorAll('#form-stop select[name="tripId"], #form-leg select[name="tripId"]')
    .forEach(s => s.innerHTML = tripReq);

  // Leg 起止城市下拉：常驻城市置顶 + 全部已有城市（跨行程）+ 手动输入兜底
  const legOpts = legCityOptions();
  document.querySelectorAll('#form-leg select[name="fromStopId"], #form-leg select[name="toStopId"]')
    .forEach(s => {
      const prev = s.value;
      s.innerHTML = legOpts;
      if (prev && s.querySelector(`option[value="${prev}"]`)) s.value = prev;   // 仍有效则保留已选
    });

  const dTrip = document.querySelector('#form-diary select[name="tripId"]');
  if (dTrip) dTrip.innerHTML = '<option value="">不关联行程</option>' + tripOptions;
  const dStop = document.querySelector('#form-diary select[name="stopId"]');
  if (dStop) dStop.innerHTML = '<option value="">不关联城市</option>' + stopOptions;

  updateLegManualVisibility();
  // 城市预设改为可搜索选择器（initCityPicker），不再用下拉注入
}

// Leg 起止城市选项：第一组常驻城市置顶，第二组全部已有城市，末尾手动输入兜底
function legCityOptions() {
  const stopOpts = STOPS.map(s => `<option value="${s.id}">${esc(s.nameZh)}（${esc(s.city || s.region || '?')}）</option>`).join('');
  return `<optgroup label="🏠 常驻城市"><option value="home">🏠 ${esc(HOME_CITY.name)}（常驻）</option></optgroup>`
    + `<optgroup label="📍 已有城市">${stopOpts || '<option value="" disabled>暂无城市，可手动输入</option>'}</optgroup>`
    + `<option value="__manual">✍️ 手动输入城市…</option>`;
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
  return v ? { kind: 'stop', stopId: v, name: (stopById(v) || {}).nameZh || v } : null;
}
function resetLegForm() {
  _editingLegId = null;
  const f = document.getElementById('form-leg');
  f.reset();
  updateLegManualVisibility();
}

function renderLists() {
  const tEl = document.getElementById('list-trips');
  const sEl = document.getElementById('list-stops');
  const lEl = document.getElementById('list-legs');
  if (!tEl) return;
  const tripTitle = (id) => { const t = TRIPS.find(x => x.id === id); return t ? t.title : '?'; };

  if (!TRIPS.length) {
    tEl.innerHTML = '<p class="empty">暂无行程。</p>';
  } else {
    tEl.innerHTML = TRIPS.map(t => {
      const cnt = `${STOPS.filter(s => s.tripId === t.id).length} 城市 / ${LEGS.filter(l => l.tripId === t.id).length} 交通段`;
      return `<div class="data-block"><div class="data-row"><span class="txt"><b>🧳 ${esc(t.title)}</b>`
        + `<div class="sub">${fmt(t.dateStart)}${t.dateEnd ? ' ~ ' + fmt(t.dateEnd) : ''}｜${cnt}</div>`
        + (t.note ? `<div class="sub">${esc(t.note)}</div>` : '')
        + `</span><button class="small ghost" data-edit="trip" data-id="${t.id}">编辑</button> `
        + `<button class="small" data-del="trip" data-id="${t.id}">删除</button></div></div>`;
    }).join('');
  }

  if (!STOPS.length) {
    sEl.innerHTML = '<p class="empty">暂无城市。</p>';
  } else {
    sEl.innerHTML = STOPS.map(s => {
      return `<div class="data-block"><div class="data-row"><span class="txt"><b>📍 ${esc(s.nameZh)}</b>`
        + `<div class="sub">${fmt(s.region || s.city)}｜${esc(tripTitle(s.tripId))}｜📷 ${photoCount(s.id)}</div>`
        + `<div class="sub">${s.lat}, ${s.lng}｜${fmt(s.arriveDate)}${s.leaveDate ? ' ~ ' + fmt(s.leaveDate) : ''}｜${money(s.cost)}</div>`
        + `</span><span><button class="small ghost" data-photos="${s.id}">管理照片</button> `
        + `<button class="small ghost" data-edit="stop" data-id="${s.id}">编辑</button> `
        + `<button class="small" data-del="stop" data-id="${s.id}">删除</button></span></div></div>`;
    }).join('');
  }

  if (!LEGS.length) {
    lEl.innerHTML = '<p class="empty">暂无交通段。</p>';
  } else {
    lEl.innerHTML = LEGS.map(l => {
      const pa = legEndpoint(l, 'from'), pb = legEndpoint(l, 'to');
      const st = legStyle(l.mode);
      return `<div class="data-block"><div class="data-row"><span class="txt"><b>${st.icon} ${st.label}</b>`
        + `<div class="sub">${esc(tripTitle(l.tripId))}</div>`
        + `<div class="sub">${esc(pa ? pa.name : '?')} → ${esc(pb ? pb.name : '?')}｜${fmt(l.departAt)}${l.arriveAt ? ' 到达 ' + fmt(l.arriveAt) : ''}｜${money(l.cost)}</div>`
        + `</span><button class="small ghost" data-edit="leg" data-id="${l.id}">编辑</button> `
        + `<button class="small" data-del="leg" data-id="${l.id}">删除</button></div></div>`;
    }).join('');
  }
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
    const link = [trip ? '🧳 ' + esc(trip) : '', stop ? '📍 ' + esc(stop.nameZh) : ''].filter(Boolean).join('｜');
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
const SAVE_LABELS = { trip: '保存行程', stop: '保存城市', leg: '保存交通段' };
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
  } else if (kind === 'leg') {
    resetLegForm();
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
  setEditState('stop', s.nameZh);
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function startEditLeg(id) {
  const l = LEGS.find(x => x.id === id); if (!l) return;
  _editingLegId = id;
  const f = document.getElementById('form-leg');
  f.tripId.value = l.tripId || '';
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
      if (sid && sel.querySelector(`option[value="${sid}"]`)) sel.value = sid;
      else sel.value = '__manual';   // 站点已被删除：回退手动输入补填
    }
  });
  updateLegManualVisibility();
  f.mode.value = l.mode || 'plane';
  f.departAt.value = l.departAt || '';
  f.arriveAt.value = l.arriveAt || '';
  f.cost.value = (l.cost == null ? '' : l.cost);
  f.note.value = l.note || '';
  const pa = legEndpoint(l, 'from'), pb = legEndpoint(l, 'to');
  setEditState('leg', (pa ? pa.name : '?') + ' → ' + (pb ? pb.name : '?'));
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ===== 工具栏 & 抽屉 ===== */
const DRAWER_NAMES = ['entry', 'timeline', 'diary', 'photos', 'settings'];
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
    if (e.key === 'Escape') { closeAllDrawers(); closeLightbox(); closeCarousel(); }
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

  function render(keyword) {
    const kw = (keyword || '').trim().toLowerCase();
    let html = '<div class="cp-item cp-manual" data-manual="1">✍️ 手动填写（不自动回填，直接在下方输入）</div>';
    let count = 0;
    byProv.forEach((arr, prov) => {
      const hits = arr.filter(c => !kw || c.name.toLowerCase().includes(kw) || prov.toLowerCase().includes(kw));
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
    if (!stop.tripId || !stop.nameZh) { toast('请选择行程并填写名称'); return; }
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
    await reload(); toast(wasEditing ? '城市已更新' : '城市已保存');
  });

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
      mode: f.mode.value, departAt: f.departAt.value, arriveAt: f.arriveAt.value,
      cost: f.cost.value === '' ? null : Number(f.cost.value), note: f.note.value.trim(),
    };
    if (!leg.tripId) { toast('请选择行程'); return; }
    await DB.putLeg(leg);
    if (wasEditing) exitEditMode('leg'); else resetLegForm();
    await reload(); toast(wasEditing ? '交通段已更新' : '交通段已保存');
  });

  // 已有数据：编辑按钮（事件委托）
  document.getElementById('data-lists').addEventListener('click', (e) => {
    const ebtn = e.target.closest('[data-edit]');
    if (!ebtn) return;
    const kind = ebtn.dataset.edit, id = ebtn.dataset.id;
    if (kind === 'trip') startEditTrip(id);
    else if (kind === 'stop') startEditStop(id);
    else if (kind === 'leg') startEditLeg(id);
  });

  // 已有数据删除（事件委托）
  document.getElementById('data-lists').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    const kind = btn.dataset.del, id = btn.dataset.id;
    if (!confirm('确定删除？此操作不可撤销。')) return;
    // 若正在编辑被删记录，先退出编辑态
    if (kind === 'trip' && _editingTripId === id) exitEditMode('trip');
    if (kind === 'stop' && _editingStopId === id) exitEditMode('stop');
    if (kind === 'leg' && _editingLegId === id) exitEditMode('leg');
    if (kind === 'trip') {
      await DB.delTrip(id);
      const sIds = STOPS.filter(s => s.tripId === id).map(s => s.id);
      const lIds = LEGS.filter(l => l.tripId === id).map(l => l.id);
      for (const sid of sIds) await DB.delStop(sid);
      for (const lid of lIds) await DB.delLeg(lid);
    } else if (kind === 'stop') {
      await DB.delStop(id);
      const lIds = LEGS.filter(l => l.fromStopId === id || l.toStopId === id).map(l => l.id);
      for (const lid of lIds) await DB.delLeg(lid);
    } else if (kind === 'leg') {
      await DB.delLeg(id);
    }
    await reload(); toast('已删除');
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
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
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
          canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas 导出失败')), 'image/jpeg', 0.8);
        } catch (err) { reject(err); }
      };
      img.onerror = () => reject(new Error('无法解码图片'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function openPhotoDrawer(stopId) {
  const stop = stopById(stopId);
  if (!stop) { toast('城市不存在'); return; }
  openDrawer('photos');            // 统一状态管理：先 closeAllDrawers 再开自己
  _photoStopId = stopId;
  document.getElementById('photo-drawer-title').textContent = '📷 ' + stop.nameZh;
  renderPhotoGrid();
}

async function renderPhotoGrid() {
  const grid = document.getElementById('photo-grid');
  const emptyEl = document.getElementById('photo-empty');
  if (!grid || !_photoStopId) return;
  _thumbUrls.forEach(u => URL.revokeObjectURL(u)); _thumbUrls = [];
  _stopPhotos = await DB.getPhotosByStop(_photoStopId);
  _stopPhotos.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  emptyEl.hidden = _stopPhotos.length > 0;
  grid.innerHTML = _stopPhotos.map(p => {
    const url = URL.createObjectURL(p.blob); _thumbUrls.push(url);
    return `<figure class="photo-cell"><img class="photo-thumb" src="${url}" data-photo-view="${p.id}" alt="${esc(p.caption || '照片')}"></figure>`;
  }).join('');
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
  _pcStopId = stopId; _pcPhotos = photos;
  _pcIdx = Math.max(0, photos.findIndex(p => p.id === stop.coverPhotoId));
  _pcUrls = photos.map(p => URL.createObjectURL(p.blob));
  renderCarousel(0);
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

function bindPhotos() {
  // 多选上传
  document.getElementById('photo-input').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length || !_photoStopId) return;
    let ok = 0, fail = 0;
    for (const f of files) {
      if (!f.type || !f.type.startsWith('image/')) { fail++; continue; }
      try {
        const blob = await compressImage(f);
        await DB.putPhoto({
          id: uid(), stopId: _photoStopId, blob,
          caption: '', shootDate: new Date().toISOString().slice(0, 10), author: '',
          createdAt: new Date().toISOString(),
        });
        ok++;
      } catch (err) {
        console.error('[footprint] 照片压缩/入库失败：', f.name, err);
        fail++;
      }
    }
    await loadPhotoIndex();
    await refreshCoverUrls();
    await renderPhotoGrid();
    renderMap();  // 避免弹窗计数过期，并同步封面气泡
    toast(`已添加 ${ok} 张照片` + (fail ? `，${fail} 张失败` : ''));
  });

  // 列表里的"管理照片"入口（弹窗内入口由 popupopen 单独绑定）
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-photos]');
    if (btn) openPhotoDrawer(btn.dataset.photos);
  });

  // 缩略图 → 大图
  document.getElementById('photo-grid').addEventListener('click', (e) => {
    const img = e.target.closest('[data-photo-view]');
    if (img) openLightbox(img.dataset.photoView);
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
    await DB.delPhoto(p.id);
    _stopPhotos = _stopPhotos.filter(x => x.id !== p.id);
    const coverStop = STOPS.find(x => x.coverPhotoId === p.id);
    if (coverStop) { coverStop.coverPhotoId = ''; await DB.putStop(coverStop); }
    await loadPhotoIndex();
    await refreshCoverUrls();
    closeLightbox();
    await renderPhotoGrid();
    renderMap();
    toast('照片已删除');
  });

  // 照片轮播（双击封面气泡打开）
  document.getElementById('pc-close').addEventListener('click', closeCarousel);
  document.getElementById('photo-carousel').addEventListener('click', (e) => {
    if (e.target.id === 'photo-carousel') closeCarousel();
  });
  document.getElementById('pc-prev').addEventListener('click', () => pcGo(-1));
  document.getElementById('pc-next').addEventListener('click', () => pcGo(1));
  document.getElementById('pc-thumbs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-pc-idx]');
    if (!t) return;
    const i = Number(t.dataset.pcIdx);
    if (i !== _pcIdx) { const dir = i > _pcIdx ? 1 : -1; _pcIdx = i; renderCarousel(dir); }
  });
}

/* ===== 设置：常驻城市 / 导出 / 导入 / 清空 ===== */
function bindSettings() {
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
    toast('已导出 JSON');
  });

  document.getElementById('file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('导入将覆盖当前全部数据，确定继续？')) { e.target.value = ''; return; }
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      await DB.importAll(data);
      await reload();
      toast('导入成功');
    } catch (err) {
      toast('导入失败：' + err.message);
    }
    e.target.value = '';
  });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!confirm('将清空全部行程、城市、交通段、点亮状态、日记和照片，且无法恢复。确定清空？')) return;
    if (!confirm('二次确认：真的要清空所有数据吗？')) return;
    await DB.clearAll();
    await reload();
    toast('已清空全部数据');
  });
}

/* ===== 示例数据（仅当无行程时预置） ===== */
async function seedIfEmpty() {
  if (TRIPS.length) return;
  const tripId = uid();
  const gz = { id: uid(), tripId, nameZh: '广州', nameEn: 'Guangzhou', country: '中国', region: '广东', city: '广州',
    lat: 23.1291, lng: 113.2644, arriveDate: '2024-04-30', leaveDate: '2024-05-02', weather: '多云', mood: '兴奋',
    companions: '朋友', cost: 1200, note: '出发地，吃了一顿早茶。' };
  const xa = { id: uid(), tripId, nameZh: '西安', nameEn: "Xi'an", country: '中国', region: '陕西', city: '西安',
    lat: 34.3416, lng: 108.9398, arriveDate: '2024-05-02', leaveDate: '2024-05-05', weather: '晴', mood: '满足',
    companions: '朋友', cost: 1800, note: '看兵马俑、逛回民街。' };
  const leg = { id: uid(), tripId, fromStopId: gz.id, toStopId: xa.id, mode: 'plane',
    departAt: '2024-05-02T09:30', arriveAt: '2024-05-02T12:10', cost: 980, note: '直飞约 2.5 小时。' };
  const trip = { id: tripId, title: '广州—西安', dateStart: '2024-04-30', dateEnd: '2024-05-05',
    note: '示例行程：从广州飞往西安。' };
  await DB.putTrip(trip); await DB.putStop(gz); await DB.putStop(xa); await DB.putLeg(leg);
  // 示例点亮状态
  await DB.putVisitedProvince('广东'); await DB.putVisitedProvince('陕西');
  await DB.putVisitedCity({ name: '广州', region: '广东', lat: gz.lat, lng: gz.lng });
  await DB.putVisitedCity({ name: '西安', region: '陕西', lat: xa.lat, lng: xa.lng });
}

/* ===== 启动 ===== */
(async function init() {
  initTheme();
  bindDrawers(); bindForms(); bindSettings(); bindKeyboard(); bindPhotos();
  try {
    await loadAll();
    await seedIfEmpty();
    await loadAll();
    await loadPhotoIndex();
    await refreshCoverUrls();
    refreshSelects(); renderLegend(); initMap(); renderTimeline(); renderLists(); renderDiaries();
  } catch (err) {
    console.error(err);
    toast('初始化出错：' + err.message);
  }
})();
