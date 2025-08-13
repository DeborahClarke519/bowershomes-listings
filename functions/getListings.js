// functions/getListings.js
const fetch = require('node-fetch');

const ACCESS_TOKEN = process.env.PROPTX_ACCESS_TOKEN;
const BASE = 'https://query.ampre.ca/odata';

const AUTH_HEADERS = {
  Authorization: `Bearer ${ACCESS_TOKEN}`,
  Accept: 'application/json'
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};

// OData-safe single-quoted string
const q = v => `'${String(v).replace(/'/g, "''")}'`;

exports.handler = async (event) => {
  try {
    if (!ACCESS_TOKEN) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing PROPTX_ACCESS_TOKEN' }) };
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
    if (city)          filters.push(`City eq ${q(city)}`);
    if (status)        filters.push(`StandardStatus eq ${q(status)}`);
    if (minPrice!=null)filters.push(`ListPrice ge ${minPrice}`);
    if (maxPrice!=null)filters.push(`ListPrice le ${maxPrice}`);
    if (beds!=null)    filters.push(`BedroomsTotal ge ${beds}`);
    if (baths!=null)   filters.push(`BathroomsTotalInteger ge ${baths}`);

    let orderby = 'ModificationTimestamp desc';
    if (sortBy === 'price_asc')  orderby = 'ListPrice asc';
    if (sortBy === 'price_desc') orderby = 'ListPrice desc';
    if (sortBy === 'date_asc')   orderby = 'ModificationTimestamp asc';

    // Conservative field list (we pruned fields that previously 1109'd)
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

    const propUrl = `${BASE}/Property?${select}`
      + (filters.length ? `&$filter=${encodeURIComponent(filters.join(' and '))}` : '')
      + `&$orderby=${encodeURIComponent(orderby)}&$top=${pgsize}&$skip=${startidx}`;

    // 1) Fetch properties
    const propRes = await fetch(propUrl, { headers: AUTH_HEADERS });
    if (!propRes.ok) {
      const t = await propRes.text();
      return { statusCode: propRes.status, headers: CORS, body: JSON.stringify({ error: 'Property fetch failed', detail: t }) };
    }
    const propJson = await propRes.json();
    const listings = Array.isArray(propJson.value) ? propJson.value : [];
    if (!listings.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ value: [], paging: { startidx, pgsize } }) };
    }

    // 2) Fetch "preferred photo" media (no size filter), then map by ListingKey
    const prefUrl = `${BASE}/Media?$filter=${encodeURIComponent("PreferredPhotoYN eq true")}&$top=4000`;
    const prefRes = await fetch(prefUrl, { headers: AUTH_HEADERS });

    const photoMap = {}; // ListingKey -> { url, key }
    if (prefRes.ok) {
      const mediaJson = await prefRes.json().catch(() => ({}));
      const mediaArr = Array.isArray(mediaJson.value) ? mediaJson.value : [];
      const wanted = new Set(listings.map(l => l.ListingKey).filter(Boolean));
      for (const m of mediaArr) {
        if (!m || !m.ResourceRecordKey) continue;
        if (!wanted.has(m.ResourceRecordKey)) continue;
        // Keep first preferred record we see (usually primary)
        if (!photoMap[m.ResourceRecordKey]) {
          photoMap[m.ResourceRecordKey] = { url: m.MediaURL || null, key: m.MediaKey || null };
        }
      }
    }

    const enriched = listings.map(l => ({
      ...l,
      PhotoURL: photoMap[l.ListingKey]?.url || null,
      PhotoKey: photoMap[l.ListingKey]?.key || null
    }));

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ value: enriched, paging: { startidx, pgsize } }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server error', detail: err.message }) };
  }
};

