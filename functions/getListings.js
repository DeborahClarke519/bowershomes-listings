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

// OData-safe quoted string
const q = v => `'${String(v).replace(/'/g, "''")}'`;

// Build (field eq 'A' or field eq 'B' ...)
function orEq(field, values) {
  const parts = values.map(v => `${field} eq ${q(v)}`);
  return parts.length > 1 ? `(${parts.join(' or ')})` : parts[0];
}

// Toronto weekend window → UTC ISO strings
function getWeekendRangeISO() {
  const now = new Date(); // server likely UTC; we'll compute in local then adjust roughly
  // Get next Saturday
  const day = now.getDay(); // 0 Sun .. 6 Sat
  const daysToSat = (6 - day + 7) % 7;
  const sat = new Date(now);
  sat.setHours(0,0,0,0);
  sat.setDate(sat.getDate() + daysToSat);
  // Sunday end
  const sun = new Date(sat);
  sun.setDate(sun.getDate() + 1);
  sun.setHours(23,59,59,999);
  // ISO strings (Z) — PropTX typically expects UTC ISO
  return { startISO: sat.toISOString(), endISO: sun.toISOString() };
}

exports.handler = async (event) => {
  try {
    if (!ACCESS_TOKEN) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing PROPTX_ACCESS_TOKEN' }) };
    }

    const qp = event.queryStringParameters || {};
    const city       = (qp.city || '').trim();           // blank → Ontario-wide
    const status     = qp.status || 'Active';
    const minPrice   = qp.min_price ? Number(qp.min_price) : null;
    const maxPrice   = qp.max_price ? Number(qp.max_price) : null;
    const beds       = qp.beds ? Number(qp.beds) : null;
    const baths      = qp.baths ? Number(qp.baths) : null;
    const pgsize     = qp.pgsize ? Math.min(Number(qp.pgsize), 50) : 20;
    const startidx   = qp.startidx ? Number(qp.startidx) : 0;
    const sortBy     = qp.sort_by || 'date_desc';
    const openhouse  = qp.openhouse === '1';

    const filters = [];
    if (city)            filters.push(`City eq ${q(city)}`);
    if (status)          filters.push(`StandardStatus eq ${q(status)}`);
    if (minPrice != null)filters.push(`ListPrice ge ${minPrice}`);
    if (maxPrice != null)filters.push(`ListPrice le ${maxPrice}`);
    if (beds != null)    filters.push(`BedroomsTotal ge ${beds}`);
    if (baths != null)   filters.push(`BathroomsTotalInteger ge ${baths}`);

    let orderby = 'ModificationTimestamp desc';
    if (sortBy === 'price_asc')  orderby = 'ListPrice asc';
    if (sortBy === 'price_desc') orderby = 'ListPrice desc';
    if (sortBy === 'date_asc')   orderby = 'ModificationTimestamp asc';

    // Conservative field list known to work in your feed
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

    // If the user wants Open Houses, pre-compute the keys for this weekend
    let restrictKeys = null;
    if (openhouse) {
      const { startISO, endISO } = getWeekendRangeISO();

      // Try typical RESO OpenHouse fields; if the resource or fields aren't available,
      // the call will fail and we'll gracefully return no records.
      const ohFilters = [
        // Common names: StartTimestamp/EndTimestamp
        `StartTimestamp ge ${q(startISO)} and EndTimestamp le ${q(endISO)}`,
        // Alternatives seen on some feeds:
        `OpenHouseStartTimestamp ge ${q(startISO)} and OpenHouseEndTimestamp le ${q(endISO)}`,
        `StartTime ge ${q(startISO)} and EndTime le ${q(endISO)}`,
        `OpenHouseStartTime ge ${q(startISO)} and OpenHouseEndTime le ${q(endISO)}`
      ];

      for (const f of ohFilters) {
        const ohUrl = `${BASE}/OpenHouse?$select=ResourceRecordKey&$filter=${encodeURIComponent(f)}&$top=5000`;
        try {
          const ohRes = await fetch(ohUrl, { headers: AUTH_HEADERS });
          if (!ohRes.ok) continue;
          const ohJson = await ohRes.json().catch(()=> ({}));
          const arr = Array.isArray(ohJson.value) ? ohJson.value : [];
          if (arr.length) {
            restrictKeys = Array.from(new Set(arr.map(x => x && x.ResourceRecordKey).filter(Boolean)));
            break;
          }
        } catch { /* try next */ }
      }

      if (!restrictKeys || !restrictKeys.length) {
        // No open houses found or resource unavailable
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ value: [], paging: { startidx, pgsize, openhouse:true } }) };
      }
    }

    // 1) Fetch properties (normal OR restricted to open-house keys)
    let propUrl = `${BASE}/Property?${select}`;
    const propFilters = filters.slice();
    if (restrictKeys && restrictKeys.length) {
      // Intersect with selected keys for open houses
      // Chunk the OR list if needed to avoid overly long URLs
      const chunkSize = 40;
      const orGroups = [];
      for (let i = 0; i < restrictKeys.length; i += chunkSize) {
        const chunk = restrictKeys.slice(i, i + chunkSize);
        orGroups.push(orEq('ListingKey', chunk));
      }
      const keysPredicate = orGroups.length > 1 ? `(${orGroups.join(' or ')})` : orGroups[0];
      propFilters.push(keysPredicate);
    }
    if (propFilters.length) {
      propUrl += `&$filter=${encodeURIComponent(propFilters.join(' and '))}`;
    }
    propUrl += `&$orderby=${encodeURIComponent(orderby)}&$top=${pgsize}&$skip=${startidx}`;

    const propRes = await fetch(propUrl, { headers: AUTH_HEADERS });
    if (!propRes.ok) {
      const t = await propRes.text();
      return { statusCode: propRes.status, headers: CORS, body: JSON.stringify({ error: 'Property fetch failed', detail: t }) };
    }
    const propJson = await propRes.json();
    const listings = Array.isArray(propJson.value) ? propJson.value : [];
    if (!listings.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ value: [], paging: { startidx, pgsize, openhouse: !!openhouse } }) };
    }

    // 2) Join photos — preferred photo first; if none, any photo
    const keys = listings.map(l => l.ListingKey).filter(Boolean);
    const photoMap = {}; // ListingKey -> { url, key }

    async function fetchMediaBatch(listingKeys, extraPredicate) {
      const chunkSize = 40;
      for (let i = 0; i < listingKeys.length; i += chunkSize) {
        const chunk = listingKeys.slice(i, i + chunkSize);
        const basePred = [
          "ResourceName eq 'Property'",
          "MediaCategory eq 'Photo'",
          extraPredicate,
          orEq('ResourceRecordKey', chunk)
        ].filter(Boolean).join(' and ');
        const url = `${BASE}/Media?$filter=${encodeURIComponent(basePred)}&$top=2000`;
        const res = await fetch(url, { headers: AUTH_HEADERS });
        if (!res.ok) continue;
        const json = await res.json().catch(() => ({}));
        const arr = Array.isArray(json.value) ? json.value : [];
        for (const m of arr) {
          const k = m && m.ResourceRecordKey;
          if (!k || photoMap[k]) continue;
          photoMap[k] = { url: m.MediaURL || null, key: m.MediaKey || null };
        }
      }
    }

    await fetchMediaBatch(keys, "PreferredPhotoYN eq true");
    const missing = keys.filter(k => !photoMap[k]);
    if (missing.length) {
      await fetchMediaBatch(missing, null);
    }

    const enriched = listings.map(l => ({
      ...l,
      PhotoURL: photoMap[l.ListingKey]?.url || null,
      PhotoKey: photoMap[l.ListingKey]?.key || null
    }));

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ value: enriched, paging: { startidx, pgsize, openhouse: !!openhouse } }) };
  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server error', detail: err.message }) };
  }
};

