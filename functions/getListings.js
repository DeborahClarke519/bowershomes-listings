const fetch = require('node-fetch');

const ACCESS_TOKEN = process.env.PROPTX_ACCESS_TOKEN;

const PROPERTY_API = "https://query.ampre.ca/odata/Property?$filter=City eq 'Kincardine' and StandardStatus eq 'Active'&$top=20";
const MEDIA_API = "https://query.ampre.ca/odata/Media?$filter=PreferredPhotoYN eq true and ImageSizeDescription eq 'Largest'&$top=100";

exports.handler = async function(event, context) {
  try {
    const [propertyRes, mediaRes] = await Promise.all([
      fetch(PROPERTY_API, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'application/json' }
      }),
      fetch(MEDIA_API, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: 'application/json' }
      })
    ]);

    const properties = await propertyRes.json();
    const media = await mediaRes.json();

    const mediaMap = {};
    media.value.forEach(photo => {
      if (!mediaMap[photo.ResourceRecordKey]) {
        mediaMap[photo.ResourceRecordKey] = photo.MediaURL;
      }
    });

    const enrichedListings = properties.value.map(listing => {
      return {
        ...listing,
        PhotoURL: mediaMap[listing.ListingKey] || null
      };
    });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enrichedListings)
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Something went wrong", details: err.message })
    };
  }
};