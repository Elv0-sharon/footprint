/* ===== Supabase 云端数据层 + 邮箱魔法链接登录 =====
   五类数据（trips/stops/legs/diaries/wishlist）登录后读写云端；
   照片 Blob、点亮集合、常驻城市配置仍存本地 IndexedDB。 */
const SUPABASE_URL = 'https://bysvetvsfmjfbrpkorad.supabase.co';
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
      const { data, error } = await sb.from(table).select('*').eq('user_id', uid);
      if (error) throw error;
      return (data || []).map(fromRow);
    },
    async put(item) {
      const uid = await requireUser();
      const { error } = await sb.from(table).upsert(toRow(item, uid));
      if (error) throw error;
    },
    async del(id) {
      await requireUser();
      const { error } = await sb.from(table).delete().eq('id', id);
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
  // JSON 导入：清空当前用户五表后逐条写入（照片/点亮/配置走本地）
  async importAll(data) {
    const uid = await requireUser();
    for (const table of ['trips', 'stops', 'legs', 'diaries', 'wishlist']) {
      const { error } = await sb.from(table).delete().eq('user_id', uid);
      if (error) throw error;
    }
    for (const t of (data.trips || [])) await this.trips.put(t);
    for (const s of (data.stops || [])) await this.stops.put(s);
    for (const l of (data.legs || [])) await this.legs.put(l);
    for (const d of (data.diaries || [])) await this.diaries.put(d);
    for (const w of (data.wishlist || [])) await this.wishlist.put(w);
  },
};
window.SBCloud = SBCloud;

/* ---- 登录界面 ---- */
function showLogin() {
  const el = document.getElementById('auth-screen');
  if (el) el.hidden = false;
  document.body.classList.add('auth-lock');
}
function showAppUI() {
  const el = document.getElementById('auth-screen');
  if (el) el.hidden = true;
  document.body.classList.remove('auth-lock');
  const info = document.getElementById('auth-info');
  if (info && _sbUser) {
    info.innerHTML = `👤 ${_sbUser.email || '已登录'} <button id="btn-signout" class="small danger">退出登录</button>`;
    document.getElementById('btn-signout').addEventListener('click', async () => {
      const { error } = await sb.auth.signOut();
      if (error) { toast('退出失败：' + error.message); return; }
      location.reload();   // 退出后回到登录页
    });
  }
}
async function sendMagicLink() {
  const email = document.getElementById('auth-email').value.trim();
  const msg = document.getElementById('auth-msg');
  if (!sb) { msg.textContent = '云端服务不可用，请检查网络后刷新重试'; return; }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = '请输入有效邮箱地址'; return; }
  msg.textContent = '发送中…';
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: AUTH_REDIRECT },
  });
  if (error) { msg.textContent = '发送失败：' + error.message; return; }
  msg.textContent = '登录链接已发到邮箱，点击邮件里的链接登录';
}
function bindAuth() {
  const btn = document.getElementById('btn-auth-send');
  if (btn) btn.addEventListener('click', sendMagicLink);
  const input = document.getElementById('auth-email');
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMagicLink(); });
}

/* ---- 会话初始化：恢复本地会话 + 处理魔法链接回调 + 监听登录状态 ---- */
async function sbInit() {
  if (!sb) {
    const msg = document.getElementById('auth-msg');
    if (msg) msg.textContent = '云端服务不可用（SDK 加载失败），请检查网络后刷新重试';
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
    if (event === 'SIGNED_IN') {
      showAppUI();
      if (window.startApp) window.startApp();   // 幂等：邮件链接回跳 / 已有会话 / 登录事件统一入口
    } else if (event === 'SIGNED_OUT') {
      showLogin();
    }
  });
  bindAuth();
  window._authReadyResolve(_sbUser);
}
sbInit();
