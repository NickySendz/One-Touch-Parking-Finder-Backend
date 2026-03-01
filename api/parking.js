export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { lat, lon, type } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: 'Missing lat/lon' });
  }

  // ── EV CHARGERS via Open Charge Map ──────────────
  if (type === 'ev') {
    try {
      // Use key if available, otherwise keyless (rate limited but works)
      const apiKey = process.env.OCMAP_API_KEY || '';
      const keyParam = apiKey ? `&key=${apiKey}` : '';

      const evUrl = `https://api.openchargemap.io/v3/poi/?output=json&latitude=${lat}&longitude=${lon}&distance=2&distanceunit=km&maxresults=20&compact=true&verbose=false${keyParam}`;

      const evRes = await fetch(evUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'OneTouchParkingFinder/1.0'
        }
      });

      if (!evRes.ok) {
        const txt = await evRes.text();
        return res.status(500).json({ error: 'OCM API error', status: evRes.status, detail: txt.slice(0, 200) });
      }

      const evData = await evRes.json();

      if (!Array.isArray(evData)) {
        return res.status(500).json({ error: 'Unexpected OCM response', detail: JSON.stringify(evData).slice(0, 200) });
      }

      const results = evData.map(station => ({
        place_id: 'ev_' + station.ID,
        name: station.AddressInfo?.Title || 'EV Charging Station',
        vicinity: [station.AddressInfo?.AddressLine1, station.AddressInfo?.Town]
          .filter(Boolean).join(', '),
        geometry: {
          location: {
            lat: station.AddressInfo?.Latitude,
            lng: station.AddressInfo?.Longitude
          }
        },
        rating: null,
        opening_hours: {
          open_now: station.StatusType?.IsOperational !== false
        },
        is_ev: true,
        num_points: station.NumberOfPoints || 1,
        connectors: (station.Connections || [])
          .map(c => c.ConnectionType?.Title || '')
          .filter((v, i, a) => v && a.indexOf(v) === i)
          .slice(0, 3),
        network: station.OperatorInfo?.Title || null,
        is_free: (station.UsageCost || '').toLowerCase().includes('free'),
        usage_cost: station.UsageCost || null,
      }));

      return res.status(200).json({ results, source: 'openchargemap', count: results.length });

    } catch (err) {
      return res.status(500).json({ error: 'Failed to fetch EV data', detail: err.message, stack: err.stack?.slice(0, 300) });
    }
  }

  // ── PARKING via Google Places API (New) ──────────
  const apiKey = process.env.GOOGLE_API_KEY;
  const url = `https://places.googleapis.com/v1/places:searchNearby`;
  const body = {
    includedTypes: ['parking'],
    maxResultCount: 20,
    locationRestriction: {
      circle: {
        center: { latitude: parseFloat(lat), longitude: parseFloat(lon) },
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
        : null,
      is_ev: false,
    }));

    return res.status(200).json({ results, source: 'google' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch parking data', detail: err.message });
  }
}
