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

const DB = {
  // 五类数据：登录后走 Supabase 云端（SBCloud），游客/照片/点亮/配置走本地 IndexedDB
  getTrips: () => (window.SBCloud && window._sbUser ? SBCloud.getTrips() : _getAll('trips')),
  getStops: () => (window.SBCloud && window._sbUser ? SBCloud.getStops() : _getAll('stops')),
  getLegs:  () => (window.SBCloud && window._sbUser ? SBCloud.getLegs()  : _getAll('legs')),
  putTrip:  (t) => (window.SBCloud && window._sbUser ? SBCloud.putTrip(t) : _put('trips', t)),
  putStop:  (s) => (window.SBCloud && window._sbUser ? SBCloud.putStop(s) : _put('stops', s)),
  putLeg:   (l) => (window.SBCloud && window._sbUser ? SBCloud.putLeg(l)  : _put('legs',  l)),
  delTrip:  (id) => (window.SBCloud && window._sbUser ? SBCloud.delTrip(id) : _del('trips', id)),
  delStop:  (id) => (window.SBCloud && window._sbUser ? SBCloud.delStop(id) : _del('stops', id)),
  delLeg:   (id) => (window.SBCloud && window._sbUser ? SBCloud.delLeg(id)  : _del('legs',  id)),

  // 手动点亮集合
  getVisitedProvinces: () => _getAll('visitedProvinces').then(list => list.map(r => r.name)),
  putVisitedProvince:  (name) => _put('visitedProvinces', { name }),
  delVisitedProvince:  (name) => _del('visitedProvinces', name),
  getVisitedCities:    () => _getAll('visitedCities'),
  putVisitedCity:      (c) => _put('visitedCities', c),
  delVisitedCity:      (name) => _del('visitedCities', name),

  // 心情日记
  getDiaries: () => (window.SBCloud && window._sbUser ? SBCloud.getDiaries() : _getAll('diaries')),
  putDiary:   (d) => (window.SBCloud && window._sbUser ? SBCloud.putDiary(d) : _put('diaries', d)),
  delDiary:   (id) => (window.SBCloud && window._sbUser ? SBCloud.delDiary(id) : _del('diaries', id)),

  // 通用配置（键值对，如常驻城市）
  getConfig: (key) => openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction('config', 'readonly').objectStore('config').get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  })),
  putConfig: (rec) => _put('config', rec),

  // 心愿清单
  getWishlist: () => (window.SBCloud && window._sbUser ? SBCloud.getWishlist() : _getAll('wishlist')),
  putWish:  (w) => (window.SBCloud && window._sbUser ? SBCloud.putWish(w) : _put('wishlist', w)),
  delWish:  (id) => (window.SBCloud && window._sbUser ? SBCloud.delWish(id) : _del('wishlist', id)),

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

  // 用户主动"清空全部数据"：连照片一起清
  clearAll: () => _clear('trips')
    .then(() => _clear('stops')).then(() => _clear('legs'))
    .then(() => _clear('diaries'))
    .then(() => _clear('visitedProvinces')).then(() => _clear('visitedCities'))
    .then(() => _clear('photos')),

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
    // 五类数据：登录时云端覆盖当前账号（SBCloud.importAll）；游客只写本地五表
    if (window.SBCloud && window._sbUser) await SBCloud.importAll(data);
    else { await _clear('trips'); await _clear('stops'); await _clear('legs'); await _clear('diaries'); await _clear('wishlist'); }
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
