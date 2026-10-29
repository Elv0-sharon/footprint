/* IndexedDB 封装：trips / stops / legs / diaries / visitedProvinces / visitedCities / photos */
const DB_NAME = 'footprintDB';
const DB_VERSION = 5;
let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('trips'))            db.createObjectStore('trips',            { keyPath: 'id' });
      if (!db.objectStoreNames.contains('stops'))            db.createObjectStore('stops',            { keyPath: 'id' });
      if (!db.objectStoreNames.contains('legs'))             db.createObjectStore('legs',             { keyPath: 'id' });
      if (!db.objectStoreNames.contains('diaries'))          db.createObjectStore('diaries',          { keyPath: 'id' });
      if (!db.objectStoreNames.contains('visitedProvinces')) db.createObjectStore('visitedProvinces', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('visitedCities'))    db.createObjectStore('visitedCities',    { keyPath: 'name' });
      if (!db.objectStoreNames.contains('photos')) {
        const ps = db.createObjectStore('photos', { keyPath: 'id' });
        ps.createIndex('stopId', 'stopId', { unique: false });
      }
      if (!db.objectStoreNames.contains('config')) db.createObjectStore('config', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('wishlist')) db.createObjectStore('wishlist', { keyPath: 'id' });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
  return _dbPromise;
}

function _getAll(store) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  }));
}

function _put(store, item) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(item);
    req.onsuccess = () => resolve(item);
    req.onerror   = () => reject(req.error);
  }));
}

function _del(store, key) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  }));
}

function _clear(store) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  }));
}

/* ---- 登录态路由：云端优先；云端失败时回退/保留本机副本，避免“登录后反而丢数据” ---- */
const _cloudOn = () => !!(window._sbUser && window.SBCloud);
let _lastCloudToast = 0;
function warnCloud(msg, e) {
  console.warn('[footprint] ' + msg, e);
  if (typeof toast !== 'function') return;
  const now = Date.now();
  if (now - _lastCloudToast < 5000) return;   // 首屏五表并发失败时只提示一次
  _lastCloudToast = now;
  toast(msg + '：' + ((e && (e.message || e.code)) || e));
}
async function readCloudOrLocal(store, cloudFn) {
  if (!_cloudOn()) return _getAll(store);
  try { return await cloudFn(); }
  catch (e) {
    warnCloud('云端读取失败，已显示本机缓存', e);
    return _getAll(store);
  }
}
async function putCloudAndLocal(store, cloudFn, item) {
  if (!_cloudOn()) return _put(store, item);
  await _put(store, item);          // 先落本机，云端失败也不丢数据
  try { await cloudFn(item); }
  catch (e) {
    warnCloud('已保存到本机，云端同步失败（可在设置里重试）', e);
    throw e;                        // 让调用方知道云端没成功（本机副本已保留）
  }
}
async function delCloudAndLocal(store, key, cloudFn) {
  if (!_cloudOn()) return _del(store, key);
  try { await cloudFn(key); }
  catch (e) {
    warnCloud('云端删除失败，本机数据已保留', e);
    throw e;
  }
  await _del(store, key);
}

const DB = {
  // 五类数据：登录后走 Supabase 云端（SBCloud），游客/照片/点亮/配置走本地 IndexedDB
  getTrips: () => readCloudOrLocal('trips', () => SBCloud.getTrips()),
  getStops: () => readCloudOrLocal('stops', () => SBCloud.getStops()),
  getLegs:  () => readCloudOrLocal('legs',  () => SBCloud.getLegs()),
  putTrip:  (t) => putCloudAndLocal('trips', t => SBCloud.putTrip(t), t),
  putStop:  (s) => putCloudAndLocal('stops', s => SBCloud.putStop(s), s),
  putLeg:   (l) => putCloudAndLocal('legs',  l => SBCloud.putLeg(l),  l),
  delTrip:  (id) => delCloudAndLocal('trips', id, id => SBCloud.delTrip(id)),
  delStop:  (id) => delCloudAndLocal('stops', id, id => SBCloud.delStop(id)),
  delLeg:   (id) => delCloudAndLocal('legs',  id, id => SBCloud.delLeg(id)),

  // 手动点亮集合
  getVisitedProvinces: () => _getAll('visitedProvinces').then(list => list.map(r => r.name)),
  putVisitedProvince:  (name) => _put('visitedProvinces', { name }),
  delVisitedProvince:  (name) => _del('visitedProvinces', name),
  getVisitedCities:    () => _getAll('visitedCities'),
  putVisitedCity:      (c) => _put('visitedCities', c),
  delVisitedCity:      (name) => _del('visitedCities', name),

  // 心情日记
  getDiaries: () => readCloudOrLocal('diaries', () => SBCloud.getDiaries()),
  putDiary:   (d) => putCloudAndLocal('diaries', d => SBCloud.putDiary(d), d),
  delDiary:   (id) => delCloudAndLocal('diaries', id, id => SBCloud.delDiary(id)),

  // 通用配置（键值对，如常驻城市）
  getConfig: (key) => openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction('config', 'readonly').objectStore('config').get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  })),
  putConfig: (rec) => _put('config', rec),

  // 心愿清单
  getWishlist: () => readCloudOrLocal('wishlist', () => SBCloud.getWishlist()),
  putWish:  (w) => putCloudAndLocal('wishlist', w => SBCloud.putWish(w), w),
  delWish:  (id) => delCloudAndLocal('wishlist', id, id => SBCloud.delWish(id)),

  // 站点照片（Blob 仅存本机，不参与 JSON 导入导出）
  getPhotoIndex: () => openDB().then(db => new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction('photos', 'readonly').objectStore('photos').openCursor();
    req.onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) { out.push({ id: cur.value.id, stopId: cur.value.stopId }); cur.continue(); }
      else resolve(out);
    };
    req.onerror = () => reject(req.error);
  })),
  getPhotosByStop: (stopId) => openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction('photos', 'readonly').objectStore('photos').index('stopId').getAll(stopId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  })),
  getPhoto: (id) => openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction('photos', 'readonly').objectStore('photos').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  })),
  putPhoto: (p) => _put('photos', p),
  delPhoto: (id) => _del('photos', id),
  getAllPhotos: () => _getAll('photos'),   // 云端同步用：全量本地照片（含 blob）

  // 登录合并用：直接读本地 IndexedDB 五表（绕过云端路由，拿游客期间录入的数据）
  getLocalAll: async () => ({
    trips: await _getAll('trips'), stops: await _getAll('stops'), legs: await _getAll('legs'),
    diaries: await _getAll('diaries'), wishlist: await _getAll('wishlist'),
  }),

  // 用户主动"清空全部数据"：连照片一起清；登录状态同时清空云端，防止刷新/重登后被同步回来
  clearAll: async () => {
    if (_cloudOn()) {
      try {
        await SBCloud.clearPhotos();   // 云端照片（元数据+Storage）先清，避免双向同步回填
        await SBCloud.clearAll();      // 云端五表
      } catch (e) { console.warn('[footprint] 云端清空失败：', e); }
    }
    await _clear('trips'); await _clear('stops'); await _clear('legs');
    await _clear('diaries'); await _clear('wishlist');
    await _clear('visitedProvinces'); await _clear('visitedCities');
    await _clear('photos');
  },

  // JSON 导出只含文字数据，不含照片 Blob
  exportAll: async () => ({
    app: 'footprint',
    version: 3,
    exportedAt: new Date().toISOString(),
    trips: await _getAll('trips'),
    stops: await _getAll('stops'),
    legs:  await _getAll('legs'),
    visitedProvinces: (await _getAll('visitedProvinces')).map(r => r.name),
    visitedCities: await _getAll('visitedCities'),
    diaries: await _getAll('diaries'),
    homeCity: (await _getAll('config')).find(r => r.key === 'homeCity') || null,
    wishlist: await _getAll('wishlist'),
  }),

  importAll: async (data) => {
    if (!data || !Array.isArray(data.trips) || !Array.isArray(data.stops) || !Array.isArray(data.legs)) {
      throw new Error('JSON 结构不正确（需包含 trips/stops/legs 数组）');
    }
    // 五类数据：登录时先覆盖云端当前账号（失败会抛出，本机数据此时还没动）；
    // 成功后把导入内容同步写回本机五表，作为离线缓存。
    if (_cloudOn()) await SBCloud.importAll(data);
    await _clear('trips'); await _clear('stops'); await _clear('legs'); await _clear('diaries'); await _clear('wishlist');
    for (const t of (data.trips || [])) await _put('trips', t);
    for (const s of (data.stops || [])) await _put('stops', s);
    for (const l of (data.legs || [])) await _put('legs', l);
    for (const d of (data.diaries || [])) await _put('diaries', d);
    for (const w of (data.wishlist || [])) await _put('wishlist', w);
    // 点亮集合/常驻城市配置仍走本地 IndexedDB
    const vp = Array.isArray(data.visitedProvinces) ? data.visitedProvinces : [];
    const vc = Array.isArray(data.visitedCities) ? data.visitedCities : [];
    await _clear('visitedProvinces'); await _clear('visitedCities');
    for (const n of vp) if (n) await _put('visitedProvinces', { name: n });
    for (const c of vc) if (c && c.name) await _put('visitedCities', c);
    if (data.homeCity && data.homeCity.name != null) await _put('config', data.homeCity);
  },
};
