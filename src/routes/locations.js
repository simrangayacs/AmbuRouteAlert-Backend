import {Router} from 'express';
import {pool} from '../config/db.js';
import {reverseLocation, searchLocations} from '../services/locationService.js';

const router = Router();

function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    const lat = Number(item.latitude);
    const lon = Number(item.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function localSearch(query) {
  const like = `%${query}%`;
  const [hospitals] = await pool.query(
    `SELECT CONCAT('hospital-',id) id,name,
            CONCAT(name, ', configured hospital') displayName,
            latitude,longitude
     FROM hospitals WHERE name LIKE ? LIMIT 8`,
    [like],
  );
  const [junctions] = await pool.query(
    `SELECT CONCAT('junction-',id) id,name,
            CONCAT(name, ', ', sector, ', monitored corridor') displayName,
            latitude,longitude
     FROM junctions WHERE enabled=1 AND (name LIKE ? OR sector LIKE ?) LIMIT 8`,
    [like, like],
  );
  return [...hospitals, ...junctions].map(item => ({
    ...item,
    latitude: Number(item.latitude),
    longitude: Number(item.longitude),
  }));
}

router.get('/search', async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) {
      return res.status(400).json({message: 'Search query must be at least 2 characters.'});
    }

    // Latitude/longitude can always be entered directly, even if external
    // geocoding providers are unavailable.
    const coordinateMatch = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    const coordinateResult = coordinateMatch
      ? [{
          id: `coordinate-${coordinateMatch[1]}-${coordinateMatch[2]}`,
          name: 'Entered coordinates',
          displayName: `${coordinateMatch[1]}, ${coordinateMatch[2]}`,
          latitude: Number(coordinateMatch[1]),
          longitude: Number(coordinateMatch[2]),
        }]
      : [];

    const local = await localSearch(query);
    const allowNominatim = String(req.query.fallback || '1') !== '0';
    let external = [];
    let providerWarning = null;
    try {
      external = await searchLocations(query, {allowNominatim});
    } catch (error) {
      providerWarning = error instanceof Error ? error.message : 'External place search unavailable.';
    }

    const results = dedupe([...coordinateResult, ...local, ...external]).slice(0, 12);
    return res.json({results, providerWarning});
  } catch (error) {
    next(error);
  }
});

router.get('/reverse', async (req, res, next) => {
  try {
    const latitude = Number(req.query.latitude);
    const longitude = Number(req.query.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({message: 'Valid latitude and longitude are required.'});
    }
    const location = await reverseLocation(latitude, longitude);
    return res.json({location});
  } catch (error) {
    next(error);
  }
});

export default router;
