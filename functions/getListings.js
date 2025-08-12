// functions/getListings.js
const fetch = require('node-fetch');

const ACCESS_TOKEN = process.env.PROPTX_ACCESS_TOKEN;
const BASE = 'https://query.ampre.ca/odata';
const headersAuth = { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'application/json' };
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};
const s = v => `'${String(v).replace(/'/g, "''")}'`; // OData-safe quotes

exports.handler = async (event) => {
  try {
    if (!ACCESS_TOKEN) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Missing PROPTX_ACCESS_TOKEN' }) };
    }

    const qp = event.queryStringParameters || {};
    const city     = qp.city || 'Kincardine';
    const status   = qp.status || 'Active';
    const minPrice = qp.min_price ? Number(qp.min_price) : null;
    const maxPrice = qp.max_price ? Number(qp.max_price) : null;
    const beds     = qp.beds ? Number(qp.beds) : null;
    const baths    = qp.baths ? Number(qp.baths) : null;
    const pgsize   = qp.pgsize ? Math.min(Number(qp.pgsize), 50) : 20;
    const startidx = qp.startidx ? Number(qp.startidx) : 0;
    const sortBy   = qp.sort_by || 'date_desc';

    const filters = [];
    if (city)   filters.push(`City eq ${s(city)}`);
    if (status) filters.push(`StandardStatus eq ${s(status)}`);
    if (minPrice !== null) filters.push(`ListPrice ge ${minPrice}`);
    if (maxPrice !== null) filters.push(`ListPrice le ${maxPrice}`);
    if (beds !== null)     filters.push(`BedroomsTotal ge ${beds}`);
    if (baths !== null)    filters.push(`BathroomsTotalInteger ge ${baths}`);

    let orderby = 'ModificationTimestamp desc';
    if (sortBy === 'price_asc')  orderby = 'ListPrice asc';
    if (sortBy === 'price_desc') orderby = 'ListPrice desc';
    if (sortBy === 'date_asc')   orderby = 'ModificationTimestamp asc';

    // keep fields conservative (we’ll add more later if needed)
    const select =
      '$select=' + [
        'ListingKey',
        'StreetNumber','StreetName','City','PostalCode','CityRegion','CountyOrParish',
        'ArchitecturalStyle',
        'ListPrice',
        'LotDepth','LotWidth','LotSizeRangeAcres',
        'StandardStatus','PublicRemarks',
        'TaxAnnualAmount','TaxAssessedValue',
        'Waterfront',
        'BathroomsTotalInteger','BedroomsTotal',
        'BuildingAreaTotal',
        'Latitude','Longitude','ModificationTimestamp'
      ].join(',');

    const propUrl = `${BASE}/Property?${select}${
      filters.length ? `&$filter=${encodeURIComponent(filters.join(' and '))}` : ''
    }&$orderby=${encodeURIComponent(orderby)}&$top=${pgsize}&$skip=${startidx}`;

    // 1) fetch properties
    const propRes = await fetch(propUrl, { headers: headersAuth });
    if (!propRes.ok) {
      const t = await propRes.text();
      return { statusCode: propRes.status, headers: cors, body: JSON.stringify({ error: 'Property fetch failed', detail: t }) };
    }
    const propJson = await propRes.json();
    const listings = Array.isArray(propJson.value) ? propJson.value : [];
    if (!listings.length) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ value: [], paging: { startidx, pgsize } }) };
    }

  // 2) fetch preferred THUMBNAIL photos for speed; map by ResourceRecordKey (== ListingKey)
const thumbsUrl = `${BASE}/Media?$filter=${encodeURIComponent(
  "PreferredPhotoYN eq true and ImageSizeDescription eq 'Thumbnail'"
)}&$top=2000`;
const thumbsRes = await fetch(thumbsUrl, { headers: headersAuth });

const thumbMap = {};
if (thumbsRes.ok) {
  const mediaJson = await thumbsRes.json().catch(() => ({}));
  const mediaArr = Array.isArray(mediaJson.value) ? mediaJson.value : [];
  const want = new Set(listings.map(l => l.ListingKey).filter(Boolean));
  for (const m of mediaArr) {
    if (!m || !m.ResourceRecordKey || !m.MediaURL) continue;
    if (want.has(m.ResourceRecordKey) && !thumbMap[m.ResourceRecordKey]) {
      thumbMap[m.ResourceRecordKey] = m.MediaURL;
    }
  }
}

// Optional: fallback to LARGEST only if no thumb was found
const largestUrl = `${BASE}/Media?$filter=${encodeURIComponent(
  "PreferredPhotoYN eq true and ImageSizeDescription eq 'Largest'"
)}&$top=2000`;
const largestRes = await fetch(largestUrl, { headers: headersAuth });

const largeMap = {};
if (largestRes.ok) {
  const mediaJson = await largestRes.json().catch(() => ({}));
  const mediaArr = Array.isArray(mediaJson.value) ? mediaJson.value : [];
  const want = new Set(listings.map(l => l.ListingKey).filter(Boolean));
  for (const m of mediaArr) {
    if (!m || !m.ResourceRecordKey || !m.MediaURL) continue;
    if (want.has(m.ResourceRecordKey) && !largeMap[m.ResourceRecordKey]) {
      largeMap[m.ResourceRecordKey] = m.MediaURL;
    }
  }
}

const enriched = listings.map(l => ({
  ...l,
  PhotoURL: thumbMap[l.ListingKey] || largeMap[l.ListingKey] || null
}));
