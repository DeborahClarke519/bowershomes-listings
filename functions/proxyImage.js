// functions/proxyImage.js
const fetch = require('node-fetch');

const CORS = { 'Access-Control-Allow-Origin': '*' };

// A couple of referrers some boards/CDNs allow for image hotlinking.
// We'll try them in order until one succeeds.
const REFERRERS = [
  'https://www.realtor.ca/',
  'https://trreb.ca/',
  'https://query.ampre.ca/odata/'
];

async function tryFetch(u, referer) {
  return fetch(u, {
    // Follow redirects normally
    redirect: 'follow',
    headers: {
      // Pretend like a real browser fetching an <img>
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'en-CA,en;q=0.9',
      // Most CDNs key on Referer; try the passed value (or none)
      ...(referer ? { 'Referer': referer } : {})
    }
  });
}

exports.handler = async (event) => {
  try {
    const u = event.queryStringParameters && event.queryStringParameters.u;
    if (!u) return { statusCode: 400, headers: CORS, body: 'Missing "u" query param' };

    // First try with NO referer (some CDNs allow this)
    let res = await tryFetch(u, null);

    // If blocked, rotate through common referrers
    for (const ref of REFERRERS) {
      if (res.ok) break;
      res = await tryFetch(u, ref);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        statusCode: res.status,
        headers: { ...CORS, 'Content-Type': 'text/plain' },
        body: text || `Upstream error ${res.status}`
      };
    }

    const ct = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());

    return {
      statusCode: 200,
      headers: {
        ...CORS,
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=600'
      },
      body: buf.toString('base64'),
      isBase64Encoded: true
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: e.message || 'Proxy failure' };
  }
};
