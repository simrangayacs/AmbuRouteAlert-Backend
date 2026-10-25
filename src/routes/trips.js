import {Router} from 'express';
import {pool} from '../config/db.js';
import {computeRoute, matchJunctionsToRoute} from '../services/routeService.js';
import {processLocation, forcePassCurrent, completeTrip, requestPoliceAhead} from '../services/tripService.js';
import {dutyRouteTarget} from '../utils/targeting.js';

const router = Router();

function validPoint(value) {
  return (
    value &&
    Number.isFinite(Number(value.latitude)) &&
    Number.isFinite(Number(value.longitude))
  );
}

function normalizeLocation(value, fallbackName) {
  if (!validPoint(value)) return null;
  const source = ['GPS', 'SEARCH', 'DEMO'].includes(String(value.source))
    ? String(value.source)
    : 'SEARCH';
  return {
    name: String(value.name || fallbackName),
    displayName: String(value.displayName || value.name || fallbackName),
    source,
    latitude: Number(value.latitude),
    longitude: Number(value.longitude),
  };
}

async function buildRoute(origin, destination, mode) {
  const route = await computeRoute(origin, destination, mode);
  const [junctions] = await pool.query(
    `SELECT j.*, COALESCE(tr.level,'LOW') traffic_level
     FROM junctions j
     LEFT JOIN traffic_reports tr ON tr.junction_id=j.id
     ORDER BY j.route_order`,
  );
  const matched = matchJunctionsToRoute(
    route.coordinates,
    junctions,
    Number(process.env.JUNCTION_ROUTE_MATCH_METERS || 180),
  );
  return {route, matched};
}

router.post('/preview', async (req, res, next) => {
  try {
    const mode = req.body.mode === 'DEMO' ? 'DEMO' : 'REAL';
    const origin = normalizeLocation(req.body.origin, 'Start location');
    const destination = normalizeLocation(req.body.destination, 'Destination');

    if (!origin || !destination) {
      return res.status(400).json({message: 'Valid From and To locations are required.'});
    }

    const {route, matched} = await buildRoute(origin, destination, mode);
    return res.json({origin, destination, route, checkpoints: matched});
  } catch (error) {
    next(error);
  }
});

router.post('/start', async (req, res, next) => {
  try {
    const {
      driverUserId = 'DRV001',
      ambulanceNo = 'AMB-101',
    } = req.body;
    const mode = req.body.mode === 'DEMO' ? 'DEMO' : 'REAL';
    const origin = normalizeLocation(req.body.origin, 'Start location');
    const destination = normalizeLocation(req.body.destination, 'Destination');

    if (!origin || !destination) {
      return res.status(400).json({message: 'Valid From and To locations are required.'});
    }

    const [[user]] = await pool.query(
      "SELECT id FROM users WHERE user_id=? AND role='DRIVER'",
      [driverUserId],
    );
    if (!user) {
      return res.status(400).json({message: 'Invalid driver.'});
    }

    const {route, matched} = await buildRoute(origin, destination, mode);

    await pool.query("UPDATE trips SET status='COMPLETED',completed_at=NOW() WHERE status='ACTIVE' AND driver_user_id=?", [user.id]);

    const [insert] = await pool.query(
      `INSERT INTO trips(
        driver_user_id, ambulance_no,
        origin_name, origin_display_name, origin_source, origin_latitude, origin_longitude,
        destination, destination_display_name, destination_source, destination_latitude, destination_longitude,
        route_json, route_distance_m, route_duration_s, route_provider,
        status, mode, current_latitude, current_longitude
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?)`,
      [
        user.id,
        ambulanceNo,
        origin.name,
        origin.displayName,
        origin.source,
        origin.latitude,
        origin.longitude,
        destination.name,
        destination.displayName,
        destination.source,
        destination.latitude,
        destination.longitude,
        JSON.stringify(route.coordinates),
        route.distanceMeters,
        route.durationSeconds,
        route.provider,
        mode,
        origin.latitude,
        origin.longitude,
      ],
    );

    const tripId = insert.insertId;

    for (let index = 0; index < matched.length; index += 1) {
      const junction = matched[index];
      await pool.query(
        `INSERT INTO trip_junctions(
          trip_id,junction_id,sequence_no,route_index,route_offset_m,status
        ) VALUES(?,?,?,?,?,'UPCOMING')`,
        [
          tripId,
          junction.id,
          index + 1,
          junction.routeIndex,
          junction.routeOffsetMeters,
        ],
      );
    }

    return res.json({
      success: true,
      tripId,
      origin,
      destination,
      route,
      checkpoints: matched,
      monitoredJunctionCount: matched.length,
    });
  } catch (error) {
    next(error);
  }
});

async function loadTripDetails(tripId) {
  const [[trip]] = await pool.query('SELECT * FROM trips WHERE id=?', [tripId]);
  if (!trip) return null;

  const [checkpoints] = await pool.query(
    `SELECT tj.*,j.name,j.latitude,j.longitude,j.sector,j.speaker_id,
            COALESCE(tr.level,'LOW') traffic_level
     FROM trip_junctions tj
     JOIN junctions j ON j.id=tj.junction_id
     LEFT JOIN traffic_reports tr ON tr.junction_id=j.id
     WHERE tj.trip_id=?
     ORDER BY tj.sequence_no`,
    [tripId],
  );

  let parsedRoute = [];
  try { parsedRoute = trip.route_json ? JSON.parse(trip.route_json) : []; } catch { parsedRoute = []; }

  const [duties] = await pool.query(
    `SELECT pds.id,pds.post_name,pds.latitude,pds.longitude,pds.radius_m,
            u.user_id officer_user_code,u.name officer_name,u.sector
     FROM police_duty_sessions pds
     JOIN users u ON u.id=pds.officer_user_id
     WHERE pds.status='ACTIVE'`,
  );
  const currentOffset = Number(trip.current_route_offset_m || 0);
  const mapAhead = Number(process.env.POLICE_MAP_AHEAD_DISTANCE_METERS || 12000);
  const corridorBuffer = Number(process.env.POLICE_ROUTE_CORRIDOR_BUFFER_METERS || 100);
  const policePosts = duties
    .map(duty => ({duty, target: dutyRouteTarget(duty, parsedRoute, currentOffset, mapAhead, corridorBuffer)}))
    .filter(item => item.target.eligible)
    .sort((a,b) => a.target.aheadDistanceMeters - b.target.aheadDistanceMeters)
    .map(({duty,target}) => ({
      id: Number(duty.id),
      officerUserId: duty.officer_user_code,
      officerName: duty.officer_name,
      postName: duty.post_name,
      latitude: Number(duty.latitude),
      longitude: Number(duty.longitude),
      radiusMeters: Number(duty.radius_m),
      aheadDistanceMeters: Math.max(0, Math.round(target.aheadDistanceMeters || 0)),
    }));

  return {trip: {...trip, route: parsedRoute}, checkpoints, policePosts};
}

router.get('/active/driver/:driverUserId', async (req, res, next) => {
  try {
    const [[active]] = await pool.query(
      `SELECT t.id
       FROM trips t
       JOIN users u ON u.id=t.driver_user_id
       WHERE u.user_id=? AND u.role='DRIVER' AND t.status='ACTIVE'
       ORDER BY t.id DESC LIMIT 1`,
      [req.params.driverUserId],
    );
    if (!active) return res.json({active: false, details: null});
    const details = await loadTripDetails(active.id);
    return res.json({active: true, details});
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const details = await loadTripDetails(req.params.id);
    if (!details) return res.status(404).json({message: 'Trip not found'});
    return res.json(details);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/location', async (req, res, next) => {
  try {
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);
    const accuracy = req.body.accuracy == null ? null : Number(req.body.accuracy);
    const speed = req.body.speed == null ? null : Number(req.body.speed);
    const heading = req.body.heading == null ? null : Number(req.body.heading);
    const recordedAt = req.body.recordedAt || null;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({message: 'Valid latitude and longitude are required.'});
    }
    return res.json({
      success: true,
      ...(await processLocation(
        {tripId: Number(req.params.id), latitude, longitude, accuracy, speed, heading, recordedAt},
        req.app.get('io'),
      )),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/telemetry', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, trip_id, latitude, longitude, accuracy_m, speed_mps, heading_deg, route_offset_m, off_route_distance_m, alerts_paused, recorded_at
       FROM trip_telemetry
       WHERE trip_id=?
       ORDER BY recorded_at, id`,
      [req.params.id],
    );
    return res.json({tripId: Number(req.params.id), telemetry: rows});
  } catch (error) {
    next(error);
  }
});


router.post('/:id/alert-police-ahead', async (req, res, next) => {
  try {
    const result = await requestPoliceAhead(Number(req.params.id), req.app.get('io'));
    return res.json({success: true, ...result});
  } catch (error) {
    next(error);
  }
});

router.post('/:id/pass-current', async (req, res, next) => {
  try {
    return res.json({
      success: true,
      junction: await forcePassCurrent(Number(req.params.id), req.app.get('io')),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/complete', async (req, res, next) => {
  try {
    await completeTrip(Number(req.params.id), req.app.get('io'));
    return res.json({success: true});
  } catch (error) {
    next(error);
  }
});

export default router;
