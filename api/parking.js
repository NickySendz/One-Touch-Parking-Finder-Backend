export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { lat, lon, type } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: 'Missing lat/lon' });
  }

  const apiKey = process.env.GOOGLE_API_KEY;
  const url = `https://places.googleapis.com/v1/places:searchNearby`;

  // Choose type — ev_charging_station or parking
  const placeType = type === 'ev' ? 'electric_vehicle_charging_station' : 'parking';

  const body = {
    includedTypes: [placeType],
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: parseFloat(lat), longitude: parseFloat(lon) },
        radius: type === 'ev' ? 2000.0 : 800.0
      }
    }
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.rating,places.currentOpeningHours,places.id,places.evChargeOptions'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    const results = (data.places || []).map(place => {
      const evOpts = place.evChargeOptions || null;
      return {
        place_id: place.id,
        name: place.displayName?.text || (type === 'ev' ? 'EV Charging Station' : 'Parking'),
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
          : null,
        is_ev: type === 'ev',
        // EV specific fields
        num_points: evOpts?.connectorCount || null,
        connectors: evOpts?.connectorAggregation
          ? evOpts.connectorAggregation.map(c => c.type?.replace(/_/g,' ') || '').filter(Boolean).slice(0,3)
          : [],
        available_points: evOpts?.connectorAggregation
          ? evOpts.connectorAggregation.reduce((sum, c) => sum + (c.availableCount || 0), 0)
          : null,
      };
    });

    return res.status(200).json({ results, source: type === 'ev' ? 'google_ev' : 'google' });

  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch data', detail: err.message });
  }
}
