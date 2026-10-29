/* Deno Deploy 反向代理：/sb/* → Supabase 项目 API
   部署地址 https://<project>.deno.dev，应用侧 SUPABASE_URL 指向它即可。 */
const UPSTREAM = 'https://bysvetvsfmjfbrpkorad.supabase.co';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, x-supabase-api-version, prefer, accept, accept-encoding',
  'Access-Control-Max-Age': '86400',
};

const SITE = 'https://elv0-sharon.github.io/footprint';   // 静态资源回源（同源方案：页面与 API 同在 deno.net 域名下）

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // 非 /sb 路径：回源 GitHub Pages 静态资源，让应用可直接跑在 deno.net 域名下
  // （页面与 API 同源，浏览器拦截扩展/安全 DNS 不会把 API 当第三方请求拦掉）
  if (!url.pathname.startsWith('/sb/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Not Found', { status: 404, headers: { ...CORS } });
    }
    const upUrl = SITE + (url.pathname === '/' ? '/' : url.pathname) + url.search;
    try {
      const rh = new Headers();
      rh.set('accept-encoding', 'identity');
      const resp = await fetch(upUrl, { headers: rh, redirect: 'follow' });
      const out = new Response(resp.body, resp);
      out.headers.set('Access-Control-Allow-Origin', '*');
      out.headers.delete('content-encoding');   // 运行时可能已解压：删编码头防 ERR_CONTENT_DECODING_FAILED
      out.headers.delete('content-length');
      out.headers.delete('transfer-encoding');
      return out;
    } catch (e) {
      return new Response('static upstream failed: ' + String(e), {
        status: 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
      });
    }
  }

  if (req.method === 'OPTIONS') {
    const h = new Headers(CORS);
    // 动态回显预检声明的头与方法：放行 accept-profile/content-profile 等 SDK 请求头，避免固定白名单漏项导致预检失败
    const reqHeaders = req.headers.get('access-control-request-headers');
    if (reqHeaders) h.set('Access-Control-Allow-Headers', reqHeaders);
    const reqMethod = req.headers.get('access-control-request-method');
    if (reqMethod) h.set('Access-Control-Allow-Methods', reqMethod);
    return new Response(null, { status: 204, headers: h });
  }

  const path = url.pathname.slice(3) || '/';
  const upstreamUrl = UPSTREAM + path + url.search;

  const headers = new Headers(req.headers);
  headers.delete('host');
  // 要求上游不做压缩：响应体原样透传，杜绝 Content-Encoding 与实际 body 不一致
  headers.set('accept-encoding', 'identity');

  try {
    const resp = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      redirect: 'manual',
    });
    // 直接透传上游响应流（不读取/不解压/不二次压缩），只补充 CORS 头
    const out = new Response(resp.body, resp);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    // 若运行时已自动解压上游 body，必须删掉编码相关头，否则浏览器按 gzip/br 解压已解压内容 → ERR_CONTENT_DECODING_FAILED
    out.headers.delete('content-encoding');
    out.headers.delete('content-length');
    out.headers.delete('transfer-encoding');
    return out;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'upstream_failed', message: String(e) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
});
