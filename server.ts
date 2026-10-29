/* Deno Deploy 反向代理：/sb/* → Supabase 项目 API
   部署地址 https://<project>.deno.dev，应用侧 SUPABASE_URL 指向它即可。 */
const UPSTREAM = 'https://bysvetvsfmjfbrpkorad.supabase.co';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, x-supabase-api-version, prefer, accept, accept-encoding',
  'Access-Control-Max-Age': '86400',
};

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (!url.pathname.startsWith('/sb/')) {
    return new Response('footprint proxy OK. Use /sb/*', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
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
