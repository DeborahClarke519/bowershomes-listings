// functions/proxyImage.js
const fetch = require('node-fetch');

const ACCESS_TOKEN = process.env.PROPTX_ACCESS_TOKEN;
const BASE = 'https://query.ampre.ca/odata';

// CORS + caching (tune as you like)
const CORS = { 'Access-Control-Allow-Origin': '*' };
const CACHE = { 'Cache-Control': 'public, max-age=600, stale-while-revalidate=86400' };

function ok(bodyBuf, contentType) {
  return {
    statusCode: 200,
    headers: { ...CORS, ...CACHE, 'Content-Type': contentType || 'image/jpeg' },
    body: bodyBuf.toString('base64'),
    isBase64Encoded: true
  };
}
function err(status, message) {
  return {
    statusCode: status,
    headers: { ...CORS, 'Content-Type': 'text/plain' },
    body: message || String(status)
  };
}

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const key = qs.key && String(qs.key).trim();      // PropTX MediaKey
    const u   = qs.u && String(qs.u).trim();          // fallback absolute URL

    if (!ACCESS_TOKEN) return err(500, 'Missing PROPTX_ACCESS_TOKEN');

    // Primary path: fetch binary directly from PropTX by MediaKey
    if (key) {
      const url = `${BASE}/Media('${encodeURIComponent(key)}')/$value`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          // Pretend like a browser image request
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        },
        redirect: 'follow'
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return err(res.status, txt || `PropTX media error ${res.status}`);
      }
      const ct = res.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      return ok(buf, ct);
    }

    // Fallback path: proxy an absolute URL (some CDNs block hotlinking; this may 403)
    if (u) {
      try {
        new URL(u); // throws if not absolute
      } catch {
        return err(400, 'Only absolute URLs are supported');
      }
      const res = await fetch(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        },
        redirect: 'follow'
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return err(res.status, txt || `Upstream error ${res.status}`);
      }
      const ct = res.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await res.arrayBuffer());
      return ok(buf, ct);
    }

    return err(400, 'Missing "key" or "u" query param');
  } catch (e) {
    return err(500, e.message || 'Proxy failure');
  }
};

