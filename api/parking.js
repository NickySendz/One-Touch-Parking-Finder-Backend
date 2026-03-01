export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { lat, lon, type } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'Missing lat/lon' });

  // ── STREET PARKING via Overpass API ──
  if (type === 'street') {
    try {
      const r = 800;
      // Much broader query — catches all OSM parking tagging styles used in Canada
      const query = `
        [out:json][timeout:25];
        (
          way["highway"]["parking:lane:both"!~"no"](around:${r},${lat},${lon});
          way["highway"]["parking:lane:right"!~"no"](around:${r},${lat},${lon});
          way["highway"]["parking:lane:left"!~"no"](around:${r},${lat},${lon});
          way["highway"]["parking:lane:both"="parallel"](around:${r},${lat},${lon});
          way["highway"]["parking:lane:both"="diagonal"](around:${r},${lat},${lon});
          way["highway"]["parking:lane:both"="perpendicular"](around:${r},${lat},${lon});
          node["amenity"="parking"]["access"!="private"]["access"!="no"](around:${r},${lat},${lon});
          way["amenity"="parking"]["access"!="private"]["access"!="no"](around:${r},${lat},${lon});
        );
        out center tags;
      `;

      const overpassRes = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      });

      if (!overpassRes.ok) {
        const txt = await overpassRes.text();
        return res.status(500).json({ error: 'Overpass error', status: overpassRes.status, detail: txt.slice(0, 300) });
      }

      const data = await overpassRes.json();
      const elements = data.elements || [];

      const seen = new Set();
      const results = elements.map(el => {
        const elLat = el.lat || el.center?.lat;
        const elLon = el.lon || el.center?.lon;
        if (!elLat || !elLon) return null;

        // Deduplicate
        const key = `${(elLat).toFixed(3)}_${(elLon).toFixed(3)}`;
        if (seen.has(key)) return null;
        seen.add(key);

        const tags = el.tags || {};

        // Figure out parking type and fee from all possible tag combos
        const laneTag = tags['parking:lane:both'] || tags['parking:lane:right'] || tags['parking:lane:left'] || '';
        const feeTag = tags['parking:lane:both:fee'] || tags['parking:fee'] || tags['fee'] || '';
        const maxStay = tags['parking:lane:both:maxstay'] || tags['parking:lane:right:maxstay'] || tags['parking:lane:left:maxstay'] || tags['maxstay'] || null;
        const streetName = tags['name'] || tags['addr:street'] || tags['ref'] || null;
        const isMetered = feeTag === 'yes' || feeTag === 'meter' || tags['payment:coins'] === 'yes' || tags['payment:meter'] === 'yes';
        const isFree = feeTag === 'no' || feeTag === 'free' || (!isMetered && feeTag === '');
        const parkStyle = laneTag || tags['parking'] || 'street';

        const name = streetName
          ? `${streetName} — Street Parking`
          : `Street Parking`;

        const address = [tags['addr:street'], tags['addr:city']].filter(Boolean).join(', ');

        return {
          place_id: 'street_' + el.id,
          name,
          vicinity: address,
          geometry: { location: { lat: elLat, lng: elLon } },
          rating: null,
          opening_hours: { open_now: true },
          is_street: true,
          parking_type: parkStyle,
          fee: feeTag,
          is_free: isFree,
          is_metered: isMetered,
          max_stay: maxStay,
        };
      }).filter(Boolean).slice(0, 40);

      return res.status(200).json({
        results,
        source: 'overpass',
        raw_count: elements.length,
        debug_sample: elements.slice(0, 2).map(e => ({ type: e.type, tags: e.tags }))
      });

    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch street parking', detail: err.message });
    }
  }

  // ── EV CHARGERS + PARKING via Google Places ──
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
