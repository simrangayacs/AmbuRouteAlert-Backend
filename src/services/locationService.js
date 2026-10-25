import 'dotenv/config';

const NOMINATIM_BASE = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';
const PHOTON_BASE = process.env.PHOTON_BASE_URL || 'https://photon.komoot.io';
const USER_AGENT = process.env.NOMINATIM_USER_AGENT || 'AmbuRouteAlertHackathon/6.0 (student-project)';
let lastNominatimRequestAt = 0;

async function fetchJson(url, {nominatim = false} = {}) {
  if (nominatim) {
    const now = Date.now();
    const waitMs = Math.max(0, 1100 - (now - lastNominatimRequestAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    lastNominatimRequestAt = Date.now();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Accept-Language': 'en',
      },
    });
    if (!response.ok) throw new Error(`Location provider failed (${response.status})`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function resultName(item) {
  return (
    item?.name ||
    item?.address?.hospital ||
    item?.address?.amenity ||
    item?.address?.road ||
    item?.display_name?.split(',')?.[0] ||
    'Selected location'
  );
}

function fromNominatim(item) {
  return {
    id: `n-${item.place_id}`,
    name: resultName(item),
    displayName: item.display_name,
    latitude: Number(item.lat),
    longitude: Number(item.lon),
  };
}

function photonName(properties = {}) {
  return properties.name || properties.street || properties.city || properties.district || properties.state || 'Selected location';
}

function photonDisplay(properties = {}) {
  return [
    properties.name,
    properties.street,
    properties.locality,
    properties.district,
    properties.city,
    properties.state,
    properties.postcode,
    properties.country,
  ].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index).join(', ');
}

function fromPhoton(feature, index = 0) {
  const [longitude, latitude] = feature?.geometry?.coordinates || [];
  const properties = feature?.properties || {};
  return {
    id: `p-${properties.osm_type || 'x'}-${properties.osm_id || index}`,
    name: photonName(properties),
    displayName: photonDisplay(properties) || `${latitude}, ${longitude}`,
    latitude: Number(latitude),
    longitude: Number(longitude),
  };
}

function dedupe(results) {
  const seen = new Set();
  return results.filter(item => {
    if (!Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return false;
    const key = `${item.latitude.toFixed(5)},${item.longitude.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function nominatimSearch(q) {
  const params = new URLSearchParams({
    q,
    format: 'jsonv2',
    addressdetails: '1',
    limit: '8',
    countrycodes: 'in',
    'accept-language': 'en',
  });
  const data = await fetchJson(`${NOMINATIM_BASE}/search?${params.toString()}`, {nominatim: true});
  return Array.isArray(data) ? data.map(fromNominatim) : [];
}

async function photonSearch(q) {
  const params = new URLSearchParams({q, limit: '8', lang: 'en'});
  const data = await fetchJson(`${PHOTON_BASE}/api/?${params.toString()}`);
  const features = Array.isArray(data?.features) ? data.features : [];
  return features.map(fromPhoton);
}

export async function searchLocations(query, {allowNominatim = true} = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  // Photon is used first because it is suitable for responsive suggestions.
  // Nominatim is kept as an explicit-search fallback, not as keystroke autocomplete.
  const collected = [];
  let firstError = null;
  try {
    collected.push(...await photonSearch(q));
  } catch (error) {
    firstError = error;
  }

  if (allowNominatim && collected.length < 3) {
    try {
      collected.push(...await nominatimSearch(q));
      if (collected.length < 3 && !/\bindia\b/i.test(q)) {
        collected.push(...await nominatimSearch(`${q}, India`));
      }
    } catch (error) {
      if (!firstError) firstError = error;
    }
  }

  const result = dedupe(collected).slice(0, 8);
  if (!result.length && firstError) {
    throw new Error(`Place search is temporarily unavailable: ${firstError.message || 'provider error'}`);
  }
  return result;
}

export async function reverseLocation(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: 'jsonv2',
    addressdetails: '1',
    'accept-language': 'en',
  });

  try {
    const item = await fetchJson(`${NOMINATIM_BASE}/reverse?${params.toString()}`, {nominatim: true});
    return {
      name: resultName(item) || 'Current Location',
      displayName: item.display_name || `${lat}, ${lon}`,
      latitude: lat,
      longitude: lon,
      source: 'GPS',
    };
  } catch {
    try {
      const photonParams = new URLSearchParams({lat: String(lat), lon: String(lon), lang: 'en'});
      const data = await fetchJson(`${PHOTON_BASE}/reverse?${photonParams.toString()}`);
      const feature = data?.features?.[0];
      if (feature) {
        const result = fromPhoton(feature);
        return {...result, id: undefined, latitude: lat, longitude: lon, source: 'GPS'};
      }
    } catch {
      // Coordinate fallback below.
    }
    return {
      name: 'Current location',
      displayName: `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
      latitude: lat,
      longitude: lon,
      source: 'GPS',
    };
  }
}
