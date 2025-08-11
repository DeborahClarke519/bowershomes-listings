// functions/getListings.js
const fetch = require('node-fetch');

const ACCESS_TOKEN = process.env.PROPTX_ACCESS_TOKEN;
const BASE = 'https://query.ampre.ca/odata';

// helper: safely encode OData string
const s = v => `'${String(v).replace(/'/g, "''")}'`;

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

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

    const select = `$select=ListingKey,StreetNumber,StreetName,City,PostalCode,CityRegion,CountyOrParish,ArchitecturalStyle,ListPrice,ListPriceUnit,LotDepth,LotWidth,LotSizeRangeAcres,StandardStatus,PublicRemarks,TaxAnnualAmount,TaxAssessedValue,Tax_Year,TransactionType,Waterfront,BathroomsTotalInteger,BedroomsTotal,BuildingAreaTotal,LivingAreaRange,VirtualTourUnbranded,Latitude,Longitude,ModificationTimestamp`;
    const filter = filters.length ? `&$filter=${encodeURIComponent(filters.join(' and '))}` : '';
    const propertyUrl = `${BASE}/Property?${select}${filter}&$orderby=${encodeURIComponent(orderby)}&$top=${pgsize}&$skip=${startidx}`;

    // 1) Fetch properties
    const propRes = await fetch(propertyUrl, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'application/json' }
    });
    if (!propRes.ok) {
      const t = await propRes.text();
      return { statusCode: propRes.status, headers: cors, body: JSON.stringify({ error: 'Property fetch failed', detail: t }) };
    }
    const propJson = await propRes.json();
    const listings = Array.isArray(propJson.value) ? propJson.value : [];

    if (!listings.length) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ value: [], paging: { startidx, pgsize }, debug: { propertyUrl } }) };
    }

    // 2) Fetch media (preferred, largest). Some tenants rate-limit/shape this differently.
    const mediaUrl = `${BASE}/Media?$filter=${encodeURIComponent("PreferredPhotoYN eq true and ImageSizeDescription eq 'Largest'")}&$top=2000`;
    const mediaRes = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'application/json' }
    });

    let mediaMap = {};
    if (mediaRes.ok) {
      const mediaJson = await mediaRes.json().catch(() => ({}));
      const mediaArr = Array.isArray(mediaJson.value) ? mediaJson.value : [];
      const keysSet = new Set(listings.map(l => l.ListingKey).filter(Boolean));
      mediaArr.forEach(m => {
        if (!m || !m.ResourceRecordKey || !m.MediaURL) return;
        if (keysSet.has(m.ResourceRecordKey) && !mediaMap[m.ResourceRecordKey]) {
          mediaMap[m.ResourceRecordKey] = m.MediaURL;
        }
      });
    } else {
      // optional: log the error text for debugging
      const t = await mediaRes.text();
      console.warn('Media fetch failed:', mediaRes.status, t);
    }

    const enriched = listings.map(l => ({ ...l, PhotoURL: mediaMap[l.ListingKey] || null }));

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ value: enriched, paging: { startidx, pgsize }, debug: { propertyUrl } })
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Server error', detail: err.message }) };
  }
};
Harden media handling + add CORS
