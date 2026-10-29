/* ===== Supabase 云端数据层 + 游客模式（邮箱密码登录可选） =====
   游客默认直接进地图（数据存 IndexedDB）；登录后五类数据（trips/stops/legs/
   diaries/wishlist）读写云端；照片 Blob、点亮集合、常驻城市配置仍存本地。 */
const SUPABASE_URL = 'https://footprint.elv0-sharon.deno.net/sb';
const SUPABASE_KEY = 'sb_publishable_R6qwy1DK5nWDzD9EOfWm8w_Sc6cY8O6';
const AUTH_REDIRECT = 'https://elv0-sharon.github.io/footprint/';

// detectSessionInUrl: true → 页面加载时自动处理魔法链接回调（hash 中 token 换取会话）
let sb = null;
if (typeof supabase === 'undefined') {
  console.warn('[footprint] Supabase SDK 加载失败（检查网络/CDN），云端功能暂不可用');
} else {
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { detectSessionInUrl: true, persistSession: true },
  });
}
let _sbUser = null;
window._appStarted = false;
window._authReady = new Promise(r => { window._authReadyResolve = r; });

/* ---- 字段转换：前端 camelCase ↔ 云端 snake_case；空值存 null，加载 null → '' ---- */
const nv = v => (v === '' || v == null) ? null : v;
const fv = v => (v == null) ? '' : v;

const tripToRow = (t, uid) => ({ id: t.id, user_id: uid, title: nv(t.title), date_start: nv(t.dateStart), date_end: nv(t.dateEnd), note: nv(t.note) });
const tripFromRow = r => ({ id: r.id, title: fv(r.title), dateStart: fv(r.date_start), dateEnd: fv(r.date_end), note: fv(r.note) });

const stopToRow = (s, uid) => ({ id: s.id, user_id: uid, trip_id: s.tripId, name_zh: nv(s.nameZh), name_en: nv(s.nameEn), country: nv(s.country), region: nv(s.region), city: nv(s.city), lat: nv(s.lat), lng: nv(s.lng), arrive_date: nv(s.arriveDate), leave_date: nv(s.leaveDate), weather: nv(s.weather), mood: nv(s.mood), companions: nv(s.companions), cost: nv(s.cost), note: nv(s.note), marker_color: nv(s.markerColor), cover_photo_id: nv(s.coverPhotoId) });
const stopFromRow = r => ({ id: r.id, tripId: fv(r.trip_id), nameZh: fv(r.name_zh), nameEn: fv(r.name_en), country: fv(r.country), region: fv(r.region), city: fv(r.city), lat: r.lat, lng: r.lng, arriveDate: fv(r.arrive_date), leaveDate: fv(r.leave_date), weather: fv(r.weather), mood: fv(r.mood), companions: fv(r.companions), cost: r.cost, note: fv(r.note), markerColor: fv(r.marker_color), coverPhotoId: fv(r.cover_photo_id) });

// legs：规格字段 from_stop_id/to_stop_id 存站点端点；常驻城市/手动输入端点序列化到 from_json/to_json（jsonb）
const legToRow = (l, uid) => {
  const f = l.from || { kind: 'stop', stopId: l.fromStopId };
  const t = l.to || { kind: 'stop', stopId: l.toStopId };
  return { id: l.id, user_id: uid, trip_id: l.tripId, mode: l.mode, route_name: null,
    depart_at: nv(l.departAt), arrive_at: nv(l.arriveAt), cost: nv(l.cost), note: nv(l.note),
    from_stop_id: f.kind === 'stop' ? f.stopId : null,
    to_stop_id: t.kind === 'stop' ? t.stopId : null,
    from_json: f.kind === 'stop' ? null : f,
    to_json: t.kind === 'stop' ? null : t };
};
const legFromRow = r => ({ id: r.id, tripId: fv(r.trip_id), mode: fv(r.mode),
  from: r.from_json ? r.from_json : { kind: 'stop', stopId: r.from_stop_id, name: '' },
  to: r.to_json ? r.to_json : { kind: 'stop', stopId: r.to_stop_id, name: '' },
  departAt: fv(r.depart_at), arriveAt: fv(r.arrive_at), cost: r.cost, note: fv(r.note) });

const diaryToRow = (d, uid) => ({ id: d.id, user_id: uid, date: nv(d.date), trip_id: d.tripId || null, stop_id: d.stopId || null, mood: nv(d.mood), weather: nv(d.weather), note: nv(d.note), created_at: d.createdAt || new Date().toISOString() });
const diaryFromRow = r => ({ id: r.id, date: fv(r.date), tripId: r.trip_id || '', stopId: r.stop_id || '', mood: fv(r.mood), weather: fv(r.weather), note: fv(r.note), createdAt: r.created_at || '' });

const wishToRow = (w, uid) => ({ id: w.id, user_id: uid, name_zh: nv(w.nameZh), country: nv(w.country), region: nv(w.region), city: nv(w.city), lat: nv(w.lat), lng: nv(w.lng), note: nv(w.note), budget: nv(w.budget), saved: nv(w.saved), target_date: nv(w.targetDate), sort_order: nv(w.order), done: !!w.done, created_at: w.createdAt || new Date().toISOString(), updated_at: w.updatedAt || new Date().toISOString() });
const wishFromRow = r => ({ id: r.id, nameZh: fv(r.name_zh), country: fv(r.country), region: fv(r.region), city: fv(r.city), lat: r.lat, lng: r.lng, note: fv(r.note), budget: r.budget, saved: r.saved == null ? 0 : r.saved, targetDate: fv(r.target_date), order: r.sort_order || 0, done: !!r.done, createdAt: r.created_at || '', updatedAt: r.updated_at || '' });

async function requireUser() {
  if (!sb) throw new Error('云端服务不可用');
  if (!_sbUser) throw new Error('未登录');
  return _sbUser.id;
}
function mkCrud(table, toRow, fromRow) {
  return {
    async getAll() {
      const uid = await requireUser();
      const { data, error } = await authRetry(() => sb.from(table).select('*').eq('user_id', uid));
      if (error) throw error;
      return (data || []).map(fromRow);
    },
    async put(item) {
      const uid = await requireUser();
      const { error } = await authRetry(() => sb.from(table).upsert(toRow(item, uid)));
      if (error) throw error;
    },
    async del(id) {
      await requireUser();
      const { error } = await authRetry(() => sb.from(table).delete().eq('id', id));
      if (error) throw error;
    },
  };
}
const SBCloud = {
  trips: mkCrud('trips', tripToRow, tripFromRow),
  stops: mkCrud('stops', stopToRow, stopFromRow),
  legs: mkCrud('legs', legToRow, legFromRow),
  diaries: mkCrud('diaries', diaryToRow, diaryFromRow),
  wishlist: mkCrud('wishlist', wishToRow, wishFromRow),
  getTrips() { return this.trips.getAll(); },
  putTrip(t) { return this.trips.put(t); },
  delTrip(id) { return this.trips.del(id); },
  getStops() { return this.stops.getAll(); },
  putStop(s) { return this.stops.put(s); },
  delStop(id) { return this.stops.del(id); },
  getLegs() { return this.legs.getAll(); },
  putLeg(l) { return this.legs.put(l); },
  delLeg(id) { return this.legs.del(id); },
  getDiaries() { return this.diaries.getAll(); },
  putDiary(d) { return this.diaries.put(d); },
  delDiary(id) { return this.diaries.del(id); },
  getWishlist() { return this.wishlist.getAll(); },
  putWish(w) { return this.wishlist.put(w); },
  delWish(id) { return this.wishlist.del(id); },
  // 清空当前用户云端五表（"清空全部数据"时与本地一起清，防止刷新后被拉回来）
  async clearAll() {
    const uid = await requireUser();
    for (const table of ['trips', 'stops', 'legs', 'diaries', 'wishlist']) {
      const { error } = await authRetry(() => sb.from(table).delete().eq('user_id', uid));
      if (error) throw error;
    }
  },
  // 清空当前用户云端全部照片（元数据 + Storage 文件）
  async clearPhotos() {
    const uid = await requireUser();
    await SBPhotos.clearAll(uid);
  },
  // JSON 导入：清空当前用户五表后逐条写入（照片/点亮/配置走本地）
  async importAll(data) {
    await this.clearAll();
    for (const t of (data.trips || [])) await this.trips.put(t);
    for (const s of (data.stops || [])) await this.stops.put(s);
    for (const l of (data.legs || [])) await this.legs.put(l);
    for (const d of (data.diaries || [])) await this.diaries.put(d);
    for (const w of (data.wishlist || [])) await this.wishlist.put(w);
  },
};
window.SBCloud = SBCloud;

/* ---- 照片云端同步：文件存 Storage（bucket: photos，路径 userId/photoId），元数据存 photos 表 ---- */
const SBPhotos = {
  async upsertMeta(rec, uid) {
    const row = {
      id: rec.id, user_id: uid, stop_id: rec.stopId || null,
      shoot_date: nv(rec.shootDate), author: nv(rec.author), caption: nv(rec.caption),
      created_at: rec.createdAt || new Date().toISOString(),
      storage_path: `${uid}/${rec.id}`,
    };
    const { error } = await sb.from('photos').upsert(row);
    if (error) throw error;
  },
  async uploadBlob(rec, blob, uid) {
    const { error } = await sb.storage.from('photos').upload(`${uid}/${rec.id}`, blob, {
      upsert: true, contentType: (blob && blob.type) || 'image/jpeg', cacheControl: '31536000',
    });
    if (error && !/exists|Duplicate/i.test(error.message || '')) throw error;
  },
  async remove(uid, id) {
    await sb.storage.from('photos').remove([`${uid}/${id}`]);
    const { error } = await sb.from('photos').delete().eq('id', id);
    if (error) throw error;
  },
  async listMeta(uid) {
    const { data, error } = await sb.from('photos').select('*').eq('user_id', uid);
    if (error) throw error;
    return (data || []).map(r => ({
      id: r.id, stopId: r.stop_id || '', shootDate: fv(r.shoot_date), author: fv(r.author),
      caption: fv(r.caption), createdAt: r.created_at || '', storagePath: r.storage_path || `${uid}/${r.id}`,
    }));
  },
  publicUrl(storagePath) {
    const { data } = sb.storage.from('photos').getPublicUrl(storagePath);
    return data ? data.publicUrl : null;
  },
  // 清空当前用户全部云端照片（元数据 + Storage 文件），"清空全部数据"时调用
  async clearAll(uid) {
    const meta = await this.listMeta(uid);          // 失败会抛出，由调用方处理
    for (const m of meta) {
      try { await sb.storage.from('photos').remove([m.storagePath]); }
      catch (e) { console.warn('[footprint] 云端照片文件删除失败：', m.id, e); }
    }
    const { error } = await authRetry(() => sb.from('photos').delete().eq('user_id', uid));
    if (error) throw error;
  },
};

// 单张照片镜像到云端（上传/编辑注释后调用；失败不打断本地流程，登录时会自动补同步）
window.mirrorPhoto = async function (rec, blob) {
  if (!sb || !_sbUser) return false;
  try {
    const uid = _sbUser.id;
    if (blob) await SBPhotos.uploadBlob(rec, blob, uid);
    await SBPhotos.upsertMeta(rec, uid);
    return true;
  } catch (e) {
    console.warn('[footprint] 照片云端同步失败：', e);
    toast('照片云端同步失败，下次登录时会自动补传');
    return false;
  }
};
window.unmirrorPhoto = async function (id) {
  if (!sb || !_sbUser) return;
  try { await SBPhotos.remove(_sbUser.id, id); }
  catch (e) { console.warn('[footprint] 云端照片删除失败：', e); }
};

// 登录合并：把游客期间录入的本机数据（按 id 去重）并入云端，手机等其它设备登录同一账号即可看到
window.mergeLocalToCloud = async function () {
  if (!sb || !_sbUser || !DB.getLocalAll) return { up: 0 };
  const uid = _sbUser.id;
  const local = await DB.getLocalAll();
  const plan = [
    ['trips', t => SBCloud.putTrip(t)], ['stops', s => SBCloud.putStop(s)], ['legs', l => SBCloud.putLeg(l)],
    ['diaries', d => SBCloud.putDiary(d)], ['wishlist', w => SBCloud.putWish(w)],
  ];
  let up = 0;
  for (const [table, put] of plan) {          // 顺序 trips→stops→legs 满足外键依赖
    let cloudIds = new Set();
    try {
      const { data, error } = await authRetry(() => sb.from(table).select('id').eq('user_id', uid));
      if (error) throw error;
      cloudIds = new Set((data || []).map(r => r.id));
    } catch (e) { console.warn('[footprint] 合并读取云端失败：', table, e); continue; }
    for (const item of (local[table] || [])) {
      if (!item || !item.id || cloudIds.has(item.id)) continue;   // 云端已有同 id：不动
      try { await put(item); up++; }
      catch (e) { console.warn('[footprint] 合并上传失败：', table, item.id, e); }
    }
  }
  return { up };
};

// 双向同步：本地多出的自动上传，云端多出的自动下载到本机缓存；完成后刷新索引/封面/地图
window.syncAllPhotos = async function () {
  if (!sb || !_sbUser) return { up: 0, down: 0, fail: 0 };
  const uid = _sbUser.id;
  const cloud = await SBPhotos.listMeta(uid);
  const cloudIds = new Set(cloud.map(c => c.id));
  const localAll = (await DB.getAllPhotos()).filter(p => p && p.blob);
  const localIds = new Set(localAll.map(p => p.id));
  let up = 0, down = 0, fail = 0;
  for (const p of localAll) {                       // 上传：本地有、云端没有
    if (cloudIds.has(p.id)) continue;
    try { await authRetry(() => SBPhotos.uploadBlob(p, p.blob, uid)); await authRetry(() => SBPhotos.upsertMeta(p, uid)); up++; }
    catch (e) { console.warn('[footprint] 照片上传失败：', p.id, e); fail++; }
  }
  for (const c of cloud) {                          // 下载：云端有、本地没有
    if (localIds.has(c.id)) continue;
    try {
      let resp = null, lastErr = null;
      for (let i = 0; i < 3; i++) {                 // 公网 URL 偶发抖动，重试 3 次
        try {
          resp = await fetch(SBPhotos.publicUrl(c.storagePath));
          if (resp.ok) break;
          lastErr = new Error('HTTP ' + resp.status);
        } catch (e) { lastErr = e; }
        resp = null;
        await new Promise(r => setTimeout(r, 600 * (i + 1)));
      }
      if (!resp) throw (lastErr || new Error('下载失败'));
      const blob = await resp.blob();
      await DB.putPhoto({ id: c.id, stopId: c.stopId, blob, caption: c.caption, shootDate: c.shootDate, author: c.author, createdAt: c.createdAt });
      down++;
    } catch (e) { console.warn('[footprint] 照片下载失败：', c.id, e); fail++; }
  }
  if (up || down) {
    try {
      if (typeof loadPhotoIndex === 'function') await loadPhotoIndex();
      if (typeof refreshCoverUrls === 'function') await refreshCoverUrls();
      if (typeof renderPhotoGrid === 'function') await renderPhotoGrid();
      if (typeof renderMap === 'function') renderMap();
    } catch (e) { console.warn('[footprint] 照片同步后刷新失败：', e); }
  }
  return { up, down, fail };
};

/* ---- 认证 UI（游客模式：默认直接进地图，点头像弹出登录框） ---- */
function updateAuthUI() {
  const btn = document.getElementById('btn-avatar');
  if (btn) btn.textContent = _sbUser ? ('👤 ' + (_sbUser.email || '已登录')) : '👤 游客';
}
function openLoginModal() {
  const m = document.getElementById('login-modal');
  if (m) { m.hidden = false; const em = document.getElementById('login-email'); if (em) em.focus(); }
}
function closeLoginModal() {
  const m = document.getElementById('login-modal');
  if (m) m.hidden = true;
  const msg = document.getElementById('login-msg');
  if (msg) msg.textContent = '';
}

/* 网络偶发被重置（Failed to fetch）时自动重试，最多 3 次尝试 */
async function authRetry(fn) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fn();
      if (!res.error) return res;
      lastErr = res.error;
      if (!/fetch|network/i.test(res.error.message || '')) return res;   // 非网络错误不重试
    } catch (e) {
      lastErr = e;
      if (!/fetch|network/i.test(String(e && e.message))) throw e;
    }
    await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  return { data: null, error: lastErr };
}
function netErrMsg(e) {
  const m = (e && e.message) || String(e);
  return /fetch|network/i.test(m) ? '网络请求失败（可能被拦截或波动），已自动重试仍不通，请稍后多试几次' : m;
}

/* 邮箱 + 密码登录（老账号） */
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pw = document.getElementById('login-password').value;
  const msg = document.getElementById('login-msg');
  if (!sb) { msg.textContent = '云端服务不可用（网络受限），请稍后重试'; return; }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = '请输入有效邮箱地址'; return; }
  if (!pw || pw.length < 6) { msg.textContent = '请输入密码（至少 6 位）'; return; }
  msg.textContent = '登录中…';
  const { error } = await authRetry(() => sb.auth.signInWithPassword({ email, password: pw }));
  if (error) { msg.textContent = '登录失败：' + netErrMsg(error); return; }
  msg.textContent = '登录成功！';   // SIGNED_IN 事件会关闭弹窗并切云端数据
}

/* 邮箱 + 密码注册（首次使用；若开启邮箱确认需去邮箱点击确认链接） */
async function doSignup() {
  const email = document.getElementById('login-email').value.trim();
  const pw = document.getElementById('login-password').value;
  const msg = document.getElementById('login-msg');
  if (!sb) { msg.textContent = '云端服务不可用（网络受限），请稍后重试'; return; }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = '请输入有效邮箱地址'; return; }
  if (!pw || pw.length < 6) { msg.textContent = '请输入密码（至少 6 位）'; return; }
  msg.textContent = '注册中…（网络不稳会自动重试）';
  const { data, error } = await authRetry(() => sb.auth.signUp({
    email, password: pw,
    options: { emailRedirectTo: AUTH_REDIRECT },
  }));
  if (error) { msg.textContent = '注册失败：' + netErrMsg(error); return; }
  if (data.session) {
    msg.textContent = '注册成功，已自动登录！';   // SIGNED_IN 事件接管
  } else {
    msg.textContent = '注册成功！请到邮箱点击确认链接，然后回来登录';
  }
}

function bindAuth() {
  const modal = document.getElementById('login-modal');
  const btnLogin = document.getElementById('btn-login');
  const btnSignup = document.getElementById('btn-signup');
  const btnClose = document.getElementById('login-close');
  const email = document.getElementById('login-email');
  const pw = document.getElementById('login-password');
  const avatar = document.getElementById('btn-avatar');
  if (btnLogin) btnLogin.addEventListener('click', doLogin);
  if (btnSignup) btnSignup.addEventListener('click', doSignup);
  if (btnClose) btnClose.addEventListener('click', closeLoginModal);
  if (modal) modal.addEventListener('click', (e) => { if (e.target.id === 'login-modal') closeLoginModal(); });
  [email, pw].forEach(el => el && el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); }));
  // 头像按钮：未登录 → 打开登录框（SDK 不可用也打开，提交时再提示）；已登录 → 询问退出
  if (avatar) avatar.addEventListener('click', async () => {
    if (_sbUser) {
      if (!sb) { toast('云端服务不可用（网络受限）'); return; }
      if (confirm('已登录 ' + (_sbUser.email || '账号') + '。\n退出后回到游客模式（数据保存在本机）。\n确定退出登录？')) {
        const { error } = await sb.auth.signOut();
        if (error) toast('退出失败：' + error.message);   // SIGNED_OUT 事件会刷新页面
      }
    } else {
      openLoginModal();
    }
  });
}

/* ---- 会话初始化：恢复本地会话 + 处理邮箱确认回调 + 监听登录状态 ---- */
bindAuth();   // 无论云端是否可用都要绑定（头像/登录框交互不依赖 SDK）
async function sbInit() {
  if (!sb) {
    console.warn('[footprint] 云端不可用，保持游客模式（本地数据）');
    updateAuthUI();
    window._authReadyResolve(null);
    return;
  }
  try {
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    _sbUser = data.session ? data.session.user : null;
  } catch (e) {
    console.warn('[footprint] Supabase 会话恢复失败：', e.message);
    _sbUser = null;
  }
  sb.auth.onAuthStateChange((event, session) => {
    _sbUser = session ? session.user : null;
    updateAuthUI();
    if (event === 'SIGNED_IN') {
      closeLoginModal();
      if (window.onSignedIn) window.onSignedIn();   // app.js：切云端重载数据
    } else if (event === 'SIGNED_OUT') {
      location.reload();   // 回到游客模式（本地数据）
    }
  });
  updateAuthUI();
  window._authReadyResolve(_sbUser);
}
sbInit();
