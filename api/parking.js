export default async function handler(req, res) {
  // Allow requests from any origin (your GitHub Pages site)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { lat, lon } = req.query;

  if (!lat || !lon) {
    return res.status(400).json({ error: 'Missing lat/lon' });
  }

  // API key is stored secretly in Vercel — never visible to users
  const apiKey = process.env.GOOGLE_API_KEY;

  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lon}&radius=800&type=parking&key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch parking data' });
  }
}
