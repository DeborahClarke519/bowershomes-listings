// functions/getListingDetails.js
const fetch = require('node-fetch');

const ACCESS_TOKEN = process.env.PROPTX_ACCESS_TOKEN;
const BASE = 'https://query.ampre.ca/odata';
const headersAuth = { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'application/json' };
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store'
};
const s = v => `'${String(v).replace(/'/g, "''")}'`;

exports.handler = async (event) => {
  try {
    if (!ACCESS_TOKEN) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Missing PROPTX_ACCESS_TOKEN' }) };
    }

    const qp = event.queryStringParameters || {};
    const id = qp.id; // ListingKey
    if (!id) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing id (ListingKey) query parameter' }) };
    }

    // Property fields (conservative set)
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

    const propUrl = `${BASE}/Property?${select}&$filter=${encodeURIComponent(`ListingKey eq ${s(id)}`)}&$top=1`;
    const propRes = await fetch(propUrl, { headers: headersAuth });
    if (!propRes.ok) {
      const t = await propRes.text();
      return { statusCode: propRes.status, headers: cors, body: JSON.stringify({ error: 'Property fetch failed', detail: t }) };
    }
    const propJson = await propRes.json();
    const listing = Array.isArray(propJson.value) && propJson.value[0] ? propJson.value[0] : null;
    if (!listing) {
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Listing not found' }) };
    }

    // All media for this listing, ordered if available
    const mediaUrl = `${BASE}/Media?$filter=${encodeURIComponent(`ResourceRecordKey eq ${s(id)}`)}&$top=200`;
    const mediaRes = await fetch(mediaUrl, { headers: headersAuth });

    let photos = [];
    if (mediaRes.ok) {
      const mediaJson = await mediaRes.json().catch(() => ({}));
      const arr = Array.isArray(mediaJson.value) ? mediaJson.value : [];
      photos = arr
        .filter(m => m && m.MediaURL && (m.MediaType || '').startsWith('image/'))
        .sort((a, b) => {
          // prefer PreferredPhotoYN first, then by Order (if present)
          const aPref = a.PreferredPhotoYN ? -1 : 0;
          const bPref = b.PreferredPhotoYN ? -1 : 0;
          if (aPref !== bPref) return aPref - bPref;
          const ao = Number.isFinite(a.Order) ? a.Order : 9999;
          const bo = Number.isFinite(b.Order) ? b.Order : 9999;
          return ao - bo;
        })
        .map(m => m.MediaURL);
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ listing, photos }) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server error', detail: err.message }) };
  }
};
