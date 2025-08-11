const fetch = require('node-fetch');

const ACCESS_TOKEN = process.env.PROPTX_ACCESS_TOKEN;
const BASE = 'https://query.ampre.ca/odata';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  try {
    if (!ACCESS_TOKEN) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing PROPTX_ACCESS_TOKEN' }) };
    }

    const qp = event.queryStringParameters || {};
    const city = (qp.city || 'Kincardine').replace(/'/g, "''");
    const status = (qp.status || 'Active').replace(/'/g, "''");
    const pgsize = Math.min(parseInt(qp.pgsize || '20', 10), 50);
    const startidx = parseInt(qp.startidx || '0', 10);

    const filters = [
      `City eq '${city}'`,
      `StandardStatus eq '${status}'`
    ];

    const select =
      '$select=ListingKey,StreetNumber,StreetName,City,PostalCode,CityRegion,CountyOrParish,ArchitecturalStyle,ListPrice,ListPriceUnit,LotDepth,LotWidth,LotSizeRangeAcres,StandardStatus,PublicRemarks,TaxAnnualAmount,TaxAssessedValue,Tax_Year,TransactionType,Waterfront,BathroomsTotalInteger,BedroomsTotal,BuildingAreaTotal,LivingAreaRange,VirtualTourUnbranded,Latitude,Longitude,ModificationTimestamp';

    const propertyUrl =
      `${BASE}/Property?${select}&$filter=${encodeURIComponent(filters.join(' and '))}` +
      `&$orderby=${encodeURIComponent('ModificationTimestamp desc')}&$top=${pgsize}&$skip=${startidx}`;

    const propRes = await fetch(propertyUrl, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'application/json' }
    });

    if (!propRes.ok) {
      const t = await propRes.text();
      return { statusCode: propRes.status, headers, body: JSON.stringify({ error: 'Property fetch failed', detail: t }) };
    }

    const propJson = await propRes.json();
    const value = Array.isArray(propJson.value) ? propJson.value : [];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ value, paging: { startidx, pgsize }, debug: { propertyUrl } })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error', detail: err.message }) };
  }
};

