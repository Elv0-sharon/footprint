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

/* ---- 登录态路由：读取优先云端（失败回退本机缓存）；写入/删除先云端，成功后同步本机缓存 ---- */
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
// 登录态：先写/删云端，成功后再同步本机 IndexedDB 作为缓存；游客态只操作本机。
// 游客期间写入的记录带 _localOnly 标记：登录时只合并这些记录，避免把本机旧缓存里
// 已在另一台设备删除的数据重新传回云端（否则会出现“删了又回来”的残留）。
async function putCloudAndLocal(store, cloudFn, item) {
  if (!_cloudOn()) return _put(store, { ...item, _localOnly: true });
  let result;
  try { result = await cloudFn(item); }
  catch (e) {
    console.warn('[footprint] 云端写入失败，未更新本机缓存：', store, item && item.id, e);
    throw e;
  }
  await _put(store, item);
  return result;
}
async function delCloudAndLocal(store, key, cloudFn) {
  if (!_cloudOn()) return _del(store, key);
  let result;
  try { result = await cloudFn(key); }
  catch (e) {
    console.warn('[footprint] 云端删除失败，未更新本机缓存：', store, key, e);
    throw e;
  }
  await _del(store, key);
  return result;
}

/* 导入前清洗：云端表带外键（stops.trip_id → trips，legs.trip_id/from_stop_id/to_stop_id → trips/stops，
   diaries 也引用行程/城市）。旧版本留下的孤儿行程/城市引用会让整批云端导入在外键处中断，
   所以先剔除无主行程/城市，把失效端点降级为手动地点；返回清洗结果和明细用于提示。 */
function sanitizeImportData(input) {
  const skipped = { stops: 0, legs: 0, diaries: 0, converted: 0, details: [] };
  const data = { ...input };
  const trips = (Array.isArray(data.trips) ? data.trips : []).filter(t => t && t.id);
  const tripIds = new Set(trips.map(t => String(t.id)));

  const stops = [];
  for (const s of (Array.isArray(data.stops) ? data.stops : [])) {
    if (!s || !s.id) { skipped.stops++; skipped.details.push('城市记录缺少 id，已跳过'); continue; }
    if (!s.tripId || !tripIds.has(String(s.tripId))) {
      skipped.stops++;
      skipped.details.push(`城市「${s.nameZh || s.id}」所属行程不存在，已跳过`);
      continue;
    }
    stops.push(s);
  }
  const stopIds = new Set(stops.map(s => String(s.id)));

  // 端点若有 kind:stop 但指向已被剔除的城市，转成 custom（保留名称/坐标，不再触发外键）
  function cleanEndpoint(ep, legacyStopId, legId, endLabel) {
    if (ep && ep.kind) {
      if (ep.kind !== 'stop') return ep;
      const sid = ep.stopId || legacyStopId;
      if (!sid) return ep;                                  // 无 stopId：写入时就是 null，不会触发外键
      if (stopIds.has(String(sid))) return { ...ep, stopId: sid };
      skipped.converted++;
      skipped.details.push(`交通段 ${legId} 的${endLabel}城市已不存在，改为手动地点`);
      return { kind: 'custom', name: ep.name || '', lat: ep.lat ?? null, lng: ep.lng ?? null };
    }
    if (legacyStopId) {                                     // 旧结构 fromStopId/toStopId
      if (stopIds.has(String(legacyStopId))) return { kind: 'stop', stopId: legacyStopId };
      skipped.converted++;
      skipped.details.push(`交通段 ${legId} 的${endLabel}城市已不存在，改为手动地点`);
      return { kind: 'custom', name: '', lat: null, lng: null };
    }
    return ep;
  }

  const legs = [];
  for (const l of (Array.isArray(data.legs) ? data.legs : [])) {
    if (!l || !l.id) { skipped.legs++; skipped.details.push('交通段记录缺少 id，已跳过'); continue; }
    if (!l.tripId || !tripIds.has(String(l.tripId))) {
      skipped.legs++;
      skipped.details.push(`交通段 ${l.id} 所属行程不存在，已跳过`);
      continue;
    }
    legs.push({ ...l,
      from: cleanEndpoint(l.from, l.fromStopId, l.id, '出发'),
      to:   cleanEndpoint(l.to, l.toStopId, l.id, '到达'),
    });
  }

  const diaries = (Array.isArray(data.diaries) ? data.diaries : []).map(d => {
    if (!d) return d;
    let out = d, changed = false;
    if (d.tripId && !tripIds.has(String(d.tripId))) { out = { ...out, tripId: '' }; changed = true; }
    if (d.stopId && !stopIds.has(String(d.stopId))) { out = { ...out, stopId: '' }; changed = true; }
    if (changed) { skipped.diaries++; skipped.details.push(`日记 ${d.id} 关联的行程/城市不存在，已解除关联`); }
    return out;
  });

  return { data: { ...data, trips, stops, legs, diaries }, skipped };
}
window.sanitizeImportData = sanitizeImportData;

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
  // 合并成功后清掉 _localOnly 标记，避免下次登录/启动再次上传同一条
  markSynced: async (store, id) => {
    const db = await openDB();
    const rec = await new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!rec || !rec._localOnly) return;
    delete rec._localOnly;
    await _put(store, rec);
  },

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

  // JSON 导出只含文字数据，不含照片 Blob，也不带内部的 _localOnly 同步标记
  exportAll: async () => {
    const strip = r => { const c = { ...r }; delete c._localOnly; return c; };
    return {
      app: 'footprint',
      version: 3,
      exportedAt: new Date().toISOString(),
      trips: (await _getAll('trips')).map(strip),
      stops: (await _getAll('stops')).map(strip),
      legs:  (await _getAll('legs')).map(strip),
      visitedProvinces: (await _getAll('visitedProvinces')).map(r => r.name),
      visitedCities: await _getAll('visitedCities'),
      diaries: (await _getAll('diaries')).map(strip),
      homeCity: (await _getAll('config')).find(r => r.key === 'homeCity') || null,
      wishlist: (await _getAll('wishlist')).map(strip),
    };
  },

  importAll: async (data) => {
    if (!data || !Array.isArray(data.trips) || !Array.isArray(data.stops) || !Array.isArray(data.legs)) {
      throw new Error('JSON 结构不正确（需包含 trips/stops/legs 数组）');
    }
    // 先清洗孤儿引用，避免云端外键错误导致整批导入中断；返回明细供 UI 提示
    const { data: clean, skipped } = sanitizeImportData(data);
    // 五类数据：登录时先覆盖云端当前账号（失败会抛出，本机数据此时还没动）；
    // 成功后把导入内容同步写回本机五表，作为离线缓存。
    const cloud = _cloudOn();
    if (cloud) await SBCloud.importAll(clean);
    await _clear('trips'); await _clear('stops'); await _clear('legs'); await _clear('diaries'); await _clear('wishlist');
    // 游客态导入的数据标记为待合并，登录后由 mergeLocalToCloud 上传；登录态导入直接视为已同步
    const mark = r => {
      const c = { ...r }; delete c._localOnly;
      return cloud ? c : { ...c, _localOnly: true };
    };
    for (const t of clean.trips) await _put('trips', mark(t));
    for (const s of clean.stops) await _put('stops', mark(s));
    for (const l of clean.legs) await _put('legs', mark(l));
    for (const d of clean.diaries) await _put('diaries', mark(d));
    for (const w of (clean.wishlist || [])) await _put('wishlist', mark(w));
    // 点亮集合/常驻城市配置仍走本地 IndexedDB
    const vp = Array.isArray(clean.visitedProvinces) ? clean.visitedProvinces : [];
    const vc = Array.isArray(clean.visitedCities) ? clean.visitedCities : [];
    await _clear('visitedProvinces'); await _clear('visitedCities');
    for (const n of vp) if (n) await _put('visitedProvinces', { name: n });
    for (const c of vc) if (c && c.name) await _put('visitedCities', c);
    if (clean.homeCity && clean.homeCity.name != null) await _put('config', clean.homeCity);
    return skipped;
  },
};
