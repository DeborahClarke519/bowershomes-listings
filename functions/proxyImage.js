// functions/proxyImage.js
const fetch = require('node-fetch');

const ACCESS_TOKEN = process.env.PROPTX_ACCESS_TOKEN;
const BASE = 'https://query.ampre.ca/odata';
const CORS = { 'Access-Control-Allow-Origin': '*' };

exports.handler = async (event) => {
  try {
    const qs = event.queryStringParameters || {};
    const key = qs.key; // MediaKey (preferred)
    const u   = qs.u;   // raw CDN URL (fallback)

    if (!ACCESS_TOKEN) {
      return { statusCode: 500, headers: CORS, body: 'Missing PROPTX_ACCESS_TOKEN' };
    }

    // Prefer fetching the binary directly from PropTX by MediaKey (authorized).
    if (key) {
      // OData binary stream for a single media record
      const mediaUrl = `${BASE}/Media('${encodeURIComponent(key)}')/$value`;
      const upstream = await fetch(mediaUrl, {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        }
      });

      if (!upstream.ok) {
        const txt = await upstream.text().catch(()=> '');
        return { statusCode: upstream.status, headers: { ...CORS, 'Content-Type': 'text/plain' }, body: txt || `Upstream error ${upstream.status}` };
      }

      const ct = upstream.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await upstream.arrayBuffer());
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': ct, 'Cache-Control': 'public, max-age=600' }, body: buf.toString('base64'), isBase64Encoded: true };
    }

    // Fallback: proxy a raw URL (may be forbidden by CDN policies).
    if (u) {
      const upstream = await fetch(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        },
        redirect: 'follow'
      });

      if (!upstream.ok) {
        const txt = await upstream.text().catch(()=> '');
        return { statusCode: upstream.status, headers: { ...CORS, 'Content-Type': 'text/plain' }, body: txt || `Upstream error ${upstream.status}` };
      }

      const ct = upstream.headers.get('content-type') || 'image/jpeg';
      const buf = Buffer.from(await upstream.arrayBuffer());
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': ct, 'Cache-Control': 'public, max-age=600' }, body: buf.toString('base64'), isBase64Encoded: true };
    }

    return { statusCode: 400, headers: CORS, body: 'Missing "key" or "u" query param' };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: e.message || 'Proxy failure' };
  }
};

