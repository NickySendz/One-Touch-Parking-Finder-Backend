export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { lat, lon, type } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });

  // ── STREET PARKING via Overpass API (OpenStreetMap) ──
  if (type === 'street') {
    try {
      const r = 600; // 600m radius
      const query = `
        [out:json][timeout:15];
        (
          node["amenity"="parking"]["parking"="street_side"](around:${r},${lat},${lon});
          node["amenity"="parking"]["parking"="lane"](around:${r},${lat},${lon});
          node["amenity"="parking"]["parking"="layby"](around:${r},${lat},${lon});
          way["amenity"="parking"]["parking"="street_side"](around:${r},${lat},${lon});
          way["amenity"="parking"]["parking"="lane"](around:${r},${lat},${lon});
          node["highway"="parking_entrance"](around:${r},${lat},${lon});
          node["amenity"="parking_space"](around:${r},${lat},${lon});
          way["parking:lane:both"](around:${r},${lat},${lon});
          way["parking:lane:right"](around:${r},${lat},${lon});
          way["parking:lane:left"](around:${r},${lat},${lon});
          node["amenity"="parking"]["access"!="private"](around:${r},${lat},${lon});
        );
        out center tags;
      `;

      const overpassRes = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });

      if (!overpassRes.ok) {
        return res.status(500).json({ error: 'Overpass API error', status: overpassRes.status });
      }

      const data = await overpassRes.json();
      const elements = data.elements || [];

      // Deduplicate by proximity and normalize
      const seen = new Set();
      const results = elements
        .map(el => {
          const elLat = el.lat || el.center?.lat;
          const elLon = el.lon || el.center?.lon;
          if (!elLat || !elLon) return null;

          // Deduplicate nearby points
          const key = `${Math.round(elLat * 1000)}_${Math.round(elLon * 1000)}`;
          if (seen.has(key)) return null;
          seen.add(key);

          const tags = el.tags || {};
          const parkingType = tags['parking'] || tags['parking:lane:both'] || tags['parking:lane:right'] || tags['parking:lane:left'] || 'street';
          const fee = tags['fee'] || tags['parking:fee'] || null;
          const maxStay = tags['maxstay'] || tags['parking:maxstay'] || null;
          const access = tags['access'] || 'yes';
          const isFree = fee === 'no' || fee === 'free';
          const isMetered = fee === 'yes' || fee === 'meter' || tags['payment:coins'] === 'yes';
          const name = tags['name'] || tags['addr:street']
            ? (tags['name'] || tags['addr:street'] + (tags['addr:housenumber'] ? ' ' + tags['addr:housenumber'] : ''))
            : 'Street Parking';

          const address = [tags['addr:street'], tags['addr:city']]
            .filter(Boolean).join(', ') || '';

          return {
            place_id: 'street_' + el.id,
            name,
            vicinity: address,
            geometry: { location: { lat: elLat, lng: elLon } },
            rating: null,
            opening_hours: { open_now: true },
            is_street: true,
            parking_type: parkingType,
            fee: fee,
            is_free: isFree,
            is_metered: isMetered,
            max_stay: maxStay,
            access,
          };
        })
        .filter(Boolean)
        .slice(0, 30);

      return res.status(200).json({ results, source: 'overpass', raw_count: elements.length });

    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch street parking', detail: err.message });
    }
  }

  // ── EV CHARGERS via Google Places ──
  const apiKey = process.env.GOOGLE_API_KEY;
  const url = `https://places.googleapis.com/v1/places:searchNearby`;
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
        geometry: { location: { lat: place.location?.latitude, lng: place.location?.longitude } },
        rating: place.rating || null,
        opening_hours: place.currentOpeningHours ? { open_now: place.currentOpeningHours.openNow } : null,
        is_ev: type === 'ev',
        num_points: evOpts?.connectorCount || null,
        connectors: evOpts?.connectorAggregation
          ? evOpts.connectorAggregation.map(c => c.type?.replace(/_/g, ' ') || '').filter(Boolean).slice(0, 3)
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
