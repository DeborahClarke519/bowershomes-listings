// functions/proxyImage.js
const fetch = require('node-fetch');

exports.handler = async (event) => {
  try {
    const u = event.queryStringParameters && event.queryStringParameters.u;
    if (!u) {
      return { statusCode: 400, body: 'Missing "u" query param' };
    }

    // Fetch the image from PropTX CDN. Set a generic UA, omit Referer.
    const upstream = await fetch(u, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      return {
        statusCode: upstream.status,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' },
        body: txt || `Upstream error ${upstream.status}`
      };
    }

    const ct = upstream.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await upstream.arrayBuffer());

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': ct,
        // cache a few minutes to make scrolling snappy
        'Cache-Control': 'public, max-age=300'
      },
      body: buf.toString('base64'),
      isBase64Encoded: true
    };
  } catch (e) {
    return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: e.message };
  }
};
