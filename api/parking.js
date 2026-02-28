export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: 'Missing lat/lon' });
  }

  const apiKey = process.env.GOOGLE_API_KEY;

  // Using the new Places API (New)
  const url = `https://places.googleapis.com/v1/places:searchNearby`;

  const body = {
    includedTypes: ['parking'],
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: {
          latitude: parseFloat(lat),
          longitude: parseFloat(lon)
        },
        radius: 800.0
      }
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.rating,places.currentOpeningHours,places.id'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    // Normalize response to match what the frontend expects
    const results = (data.places || []).map(place => ({
      place_id: place.id,
      name: place.displayName?.text || 'Parking',
      vicinity: place.formattedAddress || '',
      geometry: {
        location: {
          lat: place.location?.latitude,
          lng: place.location?.longitude
        }
      },
      rating: place.rating || null,
      opening_hours: place.currentOpeningHours
        ? { open_now: place.currentOpeningHours.openNow }
        : null
    }));

    return res.status(200).json({ results });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch parking data', detail: err.message });
  }
}
