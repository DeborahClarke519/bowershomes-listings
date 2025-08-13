// functions/getListings.js
const fetch = require('node-fetch');

const ACCESS_TOKEN = process.env.PROPTX_ACCESS_TOKEN;
const BASE = process.env.PROPTX_BASE || 'https://query.ampre.ca/odata';

const AUTH_HEADERS = { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'application/json' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

const q = v => `'${String(v).replace(/'/g, "''")}'`;
const orEq = (field, values) => {
  const parts = values.map(v => `${field} eq ${q(v)}`);
  return parts.length > 1 ? `(${parts.join(' or ')})` : parts[0];
};

// Normalizes place names and provides municipality/region hints
function resolvePlace(raw) {
  if (!raw) return null;
  const name = String(raw).trim();

  // Canonicalize common variants
  const canon = name.toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\bclarke\b/g, 'clark'); // Point Clarke -> Point Clark

  // Map places to likely municipality + region labels
  const map = {
    'kincardine':                 { cities: ['Kincardine'], regions: [] },
    'lorne beach':                { cities: ['Huron-Kinloss','Kincardine'], regions: ['Lorne Beach'] },
    'tiverton':                   { cities: ['Kincardine'], regions: ['Tiverton'] },
    'inverhuron':                 { cities: ['Kincardine','Huron-Kinloss'], regions: ['Inverhuron'] },
    'point clark':                { cities: ['Huron-Kinloss'], regions: ['Point Clark'] },
    'lurgan beach':               { cities: ['Huron-Kinloss'], regions: ['Lurgan Beach'] },
    'amberley':                   { cities: ['Huron-Kinloss','Ashfield-Colborne-Wawanosh'], regions: ['Amberley'] },
    'port elgin':                 { cities: ['Saugeen Shores'], regions: ['Port Elgin'] },
    'saugeen shores':             { cities: ['Saugeen Shores'], regions: [] },
    'southampton':                { cities: ['Saugeen Shores'], regions: ['Southampton'] },
    'ripley':                     { cities: ['Huron-Kinloss'], regions: ['Ripley'] },
    'huron-kinloss':              { cities: ['Huron-Kinloss'], regions: [] },
    'paisley':                    { cities: ['Arran-Elderslie'], regions: ['Paisley'] },
    'arran-elderslie':            { cities: ['Arran-Elderslie'], regions: [] },
    'lucknow':                    { cities: ['Huron-Kinloss','Ashfield-Colborne-Wawanosh'], regions: ['Lucknow'] },
    // keep a few helpful extras
    'goderich':                   { cities: ['Goderich'], regions: [] },
    'bayfield':                   { cities: ['Bluewater'], regions: ['Bayfield'] },
  };
  return map[canon] || { cities: [name], regions: [name] };
}

// Next Sat 00:00 to Sun 23:59:59 (Toronto locale → ISO UTC as approximation)
function weekendWindowISO() {
  const now = new Date();
  const day = now.getDay(); // 0 Sun .. 6 Sat
  const toSat = (6 - day + 7) % 7;
  const sat = new Date(now); sat.setHours(0,0,0,0); sat.setDate(sat.getDate() + toSat);
  const sun = new Date(sat); sun.setDate(sun.getDate() + 1); sun.setHours(23,59,59,999);
  return { startISO: sat.toISOString(), endISO: sun.toISOString() };
}

async function safeJson(res) {
  try { return await res.json(); } catch { return {}; }
}

exports.handler = async (event) => {
  try {
    if (!ACCESS_TOKEN) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Missing PROPTX_ACCESS_TOKEN' }) };

    const qp = event.queryStringParameters || {};
    const place     = (qp.city || '').trim();     // now a place or city
    const status    = qp.status || 'Active';
    const minPrice  = qp.min_price ? Number(qp.min_price) : null;
    const maxPrice  = qp.max_price ? Number(qp.max_price) : null;
    const beds      = qp.beds ? Number(qp.beds) : null;
    const baths     = qp.baths ? Number(qp.baths) : null;
    const pgsize    = qp.pgsize ? Math.min(Number(qp.pgsize), 50) : 20;
    const startidx  = qp.startidx ? Number(qp.startidx) : 0;
    const sortBy    = qp.sort_by || 'date_desc';
    const openhouse = qp.openhouse === '1';

    // Build property filter set
    const filters = [];
    if (status)          filters.push(`StandardStatus eq ${q(status)}`);
    if (minPrice != null)filters.push(`ListPrice ge ${minPrice}`);
    if (maxPrice != null)filters.push(`ListPrice le ${maxPrice}`);
    if (beds != null)    filters.push(`BedroomsTotal ge ${beds}`);
    if (baths != null)   filters.push(`BathroomsTotalInteger ge ${baths}`);

    // Place matching (municipality OR region)
    if (place) {
      const { cities, regions } = resolvePlace(place);
      const predicates = [];
      if (cities.length)  predicates.push(orEq('City', cities));
      if (regions.length) {
        // CityRegion eq '...' OR contains(CityRegion,'...') for partials
        const eqs = regions.map(r => `CityRegion eq ${q(r)}`);
        const partials = regions.map(r => `contains(CityRegion, ${q(r)})`);
        predicates.push(`(${eqs.concat(partials).join(' or ')})`);
      }
      filters.push(predicates.length > 1 ? `(${predicates.join(' or ')})` : predicates[0]);
    }

    let orderby = 'ModificationTimestamp desc';
    if (sortBy === 'price_asc')  orderby = 'ListPrice asc';
    if (sortBy === 'price_desc') orderby = 'ListPrice desc';
    if (sortBy === 'date_asc')   orderby = 'ModificationTimestamp asc';

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

    // If "open houses", try strategies to get the relevant ListingKeys
    let restrictKeys = null;
    if (openhouse) {
      const { startISO, endISO } = weekendWindowISO();

      // Strategy 1: OpenHouse resource
      const ohPreds = [
        `StartTimestamp ge ${q(startISO)} and EndTimestamp le ${q(endISO)}`,
        `OpenHouseStartTimestamp ge ${q(startISO)} and OpenHouseEndTimestamp le ${q(endISO)}`,
        `StartTime ge ${q(startISO)} and EndTime le ${q(endISO)}`,
        `OpenHouseStartTime ge ${q(startISO)} and OpenHouseEndTime le ${q(endISO)}`
      ];
      for (const p of ohPreds) {
        try {
          const u = `${BASE}/OpenHouse?$select=ResourceRecordKey&$filter=${encodeURIComponent(p)}&$top=5000`;
          const r = await fetch(u, { headers: AUTH_HEADERS });
          if (!r.ok) continue;
          const j = await safeJson(r);
          const keys = Array.isArray(j.value) ? j.value.map(x => x && x.ResourceRecordKey).filter(Boolean) : [];
          if (keys.length) { restrictKeys = Array.from(new Set(keys)); break; }
        } catch { /* try next */ }
      }

      // Strategy 2: property-level flags (try independently; first that works wins)
      if (!restrictKeys) {
        // 2a) OpenHouseCount gt 0
        try {
          const u = `${BASE}/Property?$select=ListingKey&$filter=${encodeURIComponent('OpenHouseCount gt 0')}&$top=5000`;
          const r = await fetch(u, { headers: AUTH_HEADERS });
          if (r.ok) {
            const j = await safeJson(r);
            const keys = Array.isArray(j.value) ? j.value.map(x => x && x.ListingKey).filter(Boolean) : [];
            if (keys.length) restrictKeys = Array.from(new Set(keys));
          }
        } catch { /* ignore */ }
      }
      if (!restrictKeys) {
        // 2b) OpenHouseActiveYN eq true
        try {
          const u = `${BASE}/Property?$select=ListingKey&$filter=${encodeURIComponent('OpenHouseActiveYN eq true')}&$top=5000`;
          const r = await fetch(u, { headers: AUTH_HEADERS });
          if (r.ok) {
            const j = await safeJson(r);
            const keys = Array.isArray(j.value) ? j.value.map(x => x && x.ListingKey).filter(Boolean) : [];
            if (keys.length) restrictKeys = Array.from(new Set(keys));
          }
        } catch { /* ignore */ }
      }

      // If we still have no keys, return empty (there may simply be no OH this weekend)
      if (!restrictKeys || !restrictKeys.length) {
        return { statusCode: 200, headers: CORS, body: JSON.stringify({ value: [], paging: { startidx, pgsize, openhouse:true } }) };
      }
    }

    // 1) Properties (optionally intersect with open-house keys)
    let propUrl = `${BASE}/Property?${select}`;
    const propFilters = filters.slice();
    if (restrictKeys && restrictKeys.length) {
      const chunkSize = 40;
      const orGroups = [];
      for (let i = 0; i < restrictKeys.length; i += chunkSize) {
        const chunk = restrictKeys.slice(i, i + chunkSize);
        orGroups.push(orEq('ListingKey', chunk));
      }
      const keysPredicate = orGroups.length > 1 ? `(${orGroups.join(' or ')})` : orGroups[0];
      propFilters.push(keysPredicate);
    }
    if (propFilters.length) propUrl += `&$filter=${encodeURIComponent(propFilters.join(' and '))}`;
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

    // 2) Photos (preferred first; fallback to any)
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
        const json = await safeJson(res);
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
    if (missing.length) await fetchMediaBatch(missing, null);

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
