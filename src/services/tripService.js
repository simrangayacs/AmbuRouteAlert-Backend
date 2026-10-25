import 'dotenv/config';
import {pool} from '../config/db.js';
import {cumulativeOffsets, routeOffsetAt} from '../utils/routeMath.js';
import {publishSpeakerCommand} from './mqttService.js';
import {
  closeDutyAreaAlert,
  syncDutyAreaAlertsForTrip,
  upsertTargetedPoliceAlerts,
} from './alertService.js';
import {dutyRouteTarget, selectManualAlertCandidates} from '../utils/targeting.js';

const activation = Number(process.env.ACTIVATION_DISTANCE_METERS || 550);
const earlyWarningDistance = Number(process.env.EARLY_WARNING_DISTANCE_METERS || 3000);
const manualEarlyWarningDistance = Number(process.env.MANUAL_EARLY_WARNING_DISTANCE_METERS || 8000);
const manualEarlyWarningCheckpointCount = Number(process.env.MANUAL_EARLY_WARNING_CHECKPOINT_COUNT || 5);
const passedTolerance = Number(process.env.PASSED_TOLERANCE_METERS || 70);
const maxGpsAccuracy = Number(process.env.MAX_GPS_ACCURACY_METERS || 120);
const maxOffRouteDistance = Number(process.env.MAX_OFF_ROUTE_METERS || 120);
const destinationReachedMeters = Number(process.env.DESTINATION_REACHED_METERS || 45);
const policeRouteBuffer = Number(process.env.POLICE_ROUTE_CORRIDOR_BUFFER_METERS || 100);
const policeMapAheadDistance = Number(process.env.POLICE_MAP_AHEAD_DISTANCE_METERS || 12000);

function parseRoute(trip) {
  try {
    const route = trip?.route_json ? JSON.parse(trip.route_json) : [];
    return Array.isArray(route) ? route : [];
  } catch {
    return [];
  }
}

async function activePolicePostsForTrip(tripId) {
  const [[trip]] = await pool.query('SELECT route_json,current_route_offset_m FROM trips WHERE id=?', [tripId]);
  if (!trip) return [];
  const route = parseRoute(trip);
  if (route.length < 2) return [];
  const currentOffset = Number(trip.current_route_offset_m || 0);
  const [duties] = await pool.query(
    `SELECT pds.id,pds.post_name,pds.latitude,pds.longitude,pds.radius_m,
            u.user_id officer_user_code,u.name officer_name,u.sector
     FROM police_duty_sessions pds
     JOIN users u ON u.id=pds.officer_user_id
     WHERE pds.status='ACTIVE'`,
  );
  return duties
    .map(duty => ({
      duty,
      target: dutyRouteTarget(duty, route, currentOffset, policeMapAheadDistance, policeRouteBuffer),
    }))
    .filter(item => item.target.eligible)
    .sort((a, b) => a.target.aheadDistanceMeters - b.target.aheadDistanceMeters)
    .map(({duty, target}) => ({
      id: Number(duty.id),
      officerUserId: duty.officer_user_code,
      officerName: duty.officer_name,
      postName: duty.post_name,
      latitude: Number(duty.latitude),
      longitude: Number(duty.longitude),
      radiusMeters: Number(duty.radius_m),
      aheadDistanceMeters: Math.max(0, Math.round(target.aheadDistanceMeters || 0)),
      routeDistanceMeters: Math.round(target.routeDistanceMeters || 0),
    }));
}

async function nextCheckpoint(tripId) {
  const [[j]] = await pool.query(
    `SELECT tj.*,j.name,j.latitude,j.longitude,j.speaker_id,j.sector,COALESCE(tr.level,'LOW') traffic_level
     FROM trip_junctions tj
     JOIN junctions j ON j.id=tj.junction_id
     LEFT JOIN traffic_reports tr ON tr.junction_id=j.id
     WHERE tj.trip_id=? AND tj.status IN ('UPCOMING','ACTIVE')
     ORDER BY tj.sequence_no LIMIT 1`,
    [tripId],
  );
  return j || null;
}

async function closePoliceAlertsForCheckpoint(tripId, junctionId, io) {
  const [alerts] = await pool.query(
    `SELECT pa.id,u.user_id officer_user_code
     FROM police_alerts pa
     LEFT JOIN users u ON u.id=pa.officer_user_id
     WHERE pa.trip_id=? AND pa.junction_id=? AND pa.status='ACTIVE'`,
    [tripId, junctionId],
  );
  await pool.query(
    "UPDATE police_alerts SET status='CLOSED' WHERE trip_id=? AND junction_id=? AND status='ACTIVE'",
    [tripId, junctionId],
  );
  for (const alert of alerts) {
    if (alert.officer_user_code) {
      io.to(`officer:${alert.officer_user_code}`).emit('police.alert.closed', {tripId, junctionId});
    }
  }
}

async function markCheckpointPassed(tripId, cp, io) {
  await pool.query(
    "UPDATE trip_junctions SET status='PASSED',passed_at=NOW() WHERE id=? AND status IN ('UPCOMING','ACTIVE')",
    [cp.id],
  );
  await closePoliceAlertsForCheckpoint(tripId, cp.junction_id, io);
  publishSpeakerCommand(cp.speaker_id, 'STOP_EMERGENCY_ALERT', tripId);
  io.to(`trip:${tripId}`).emit('checkpoint.passed', {
    tripId,
    junctionId: cp.junction_id,
    junctionName: cp.name,
  });
}

export async function processLocation(
  {tripId, latitude, longitude, accuracy = null, speed = null, heading = null, recordedAt = null},
  io,
) {
  const [[trip]] = await pool.query('SELECT * FROM trips WHERE id=?', [tripId]);
  if (!trip) throw new Error('Trip not found');
  if (trip.status !== 'ACTIVE') throw new Error('Trip is not active');

  const route = parseRoute(trip);
  if (route.length < 2) throw new Error('Trip route is missing. Restart the trip.');
  const offsets = cumulativeOffsets(route);
  const current = routeOffsetAt(route, offsets, latitude, longitude);
  const offRouteDistance = Math.round(current.distanceMeters || 0);
  const accuracyValue = Number.isFinite(Number(accuracy)) ? Number(accuracy) : null;
  const poorAccuracy = accuracyValue != null && accuracyValue > maxGpsAccuracy;
  const alertsPaused = poorAccuracy || offRouteDistance > maxOffRouteDistance;
  const routeDistance = Number(trip.route_distance_m || offsets.at(-1) || 0);
  const remainingDistance = Math.max(0, Math.round(routeDistance - current.offsetMeters));
  const remainingDuration = routeDistance > 0
    ? Math.max(0, Math.round(Number(trip.route_duration_s || 0) * remainingDistance / routeDistance))
    : 0;

  await pool.query(
    `UPDATE trips SET current_latitude=?,current_longitude=?,current_accuracy_m=?,current_speed_mps=?,current_heading_deg=?,
      current_route_offset_m=?,off_route_distance_m=?,alerts_paused=?,updated_at=NOW() WHERE id=?`,
    [
      latitude,
      longitude,
      accuracyValue,
      Number.isFinite(Number(speed)) ? Number(speed) : null,
      Number.isFinite(Number(heading)) ? Number(heading) : null,
      current.offsetMeters,
      offRouteDistance,
      alertsPaused ? 1 : 0,
      tripId,
    ],
  );

  await pool.query(
    `INSERT INTO trip_telemetry(
      trip_id,latitude,longitude,accuracy_m,speed_mps,heading_deg,route_offset_m,off_route_distance_m,alerts_paused,recorded_at
     ) VALUES(?,?,?,?,?,?,?,?,?,COALESCE(?,NOW()))`,
    [
      tripId,
      latitude,
      longitude,
      accuracyValue,
      Number.isFinite(Number(speed)) ? Number(speed) : null,
      Number.isFinite(Number(heading)) ? Number(heading) : null,
      Math.round(current.offsetMeters),
      offRouteDistance,
      alertsPaused ? 1 : 0,
      recordedAt ? new Date(recordedAt) : null,
    ],
  );

  const latestTrip = {...trip, current_route_offset_m: current.offsetMeters, alerts_paused: alertsPaused ? 1 : 0};
  const response = {
    tripId,
    latitude,
    longitude,
    currentRouteOffsetMeters: current.offsetMeters,
    remainingDistanceMeters: remainingDistance,
    remainingDurationSeconds: remainingDuration,
    offRouteDistanceMeters: offRouteDistance,
    alertsPaused,
    nextJunction: null,
    tripCompleted: false,
    policePosts: [],
    targetedOfficerCount: 0,
  };

  const previouslyPaused = Boolean(trip.alerts_paused);
  if (alertsPaused !== previouslyPaused) {
    io.to(`trip:${tripId}`).emit(alertsPaused ? 'trip.alerts.paused' : 'trip.alerts.resumed', {
      tripId,
      offRouteDistanceMeters: offRouteDistance,
      accuracyMeters: accuracyValue,
    });
  }

  if (!alertsPaused) {
    const dutySync = await syncDutyAreaAlertsForTrip({
      trip: latestTrip,
      currentOffsetMeters: current.offsetMeters,
      io,
      manual: false,
    });
    response.targetedOfficerCount = dutySync.eligibleOfficerCount;
  }

  response.policePosts = await activePolicePostsForTrip(tripId);

  if (remainingDistance <= destinationReachedMeters && !alertsPaused) {
    await completeTrip(tripId, io);
    response.tripCompleted = true;
    io.to(`trip:${tripId}`).emit('trip.location.updated', response);
    return response;
  }

  const cp = await nextCheckpoint(tripId);
  if (cp) {
    const ahead = Math.round(cp.route_offset_m - current.offsetMeters);
    response.nextJunction = {
      id: cp.junction_id,
      name: cp.name,
      sector: cp.sector,
      status: cp.status,
      latitude: Number(cp.latitude),
      longitude: Number(cp.longitude),
      aheadDistanceMeters: ahead,
      trafficLevel: cp.traffic_level || 'LOW',
    };

    if (!alertsPaused && cp.status === 'UPCOMING' && ahead > activation && ahead <= earlyWarningDistance) {
      const targeted = await upsertTargetedPoliceAlerts({
        trip: latestTrip,
        checkpoint: cp,
        aheadDistanceMeters: ahead,
        io,
        alertType: 'EARLY',
        requestedByDriver: false,
      });
      response.targetedOfficerCount = Math.max(response.targetedOfficerCount, targeted.eligibleOfficerCount);
    }

    if (!alertsPaused && cp.status === 'UPCOMING' && ahead >= 0 && ahead <= activation) {
      const [u] = await pool.query(
        "UPDATE trip_junctions SET status='ACTIVE',activated_at=NOW() WHERE id=? AND status='UPCOMING'",
        [cp.id],
      );
      if (u.affectedRows) {
        publishSpeakerCommand(cp.speaker_id, 'PLAY_EMERGENCY_ALERT', tripId);
        const targeted = await upsertTargetedPoliceAlerts({
          trip: latestTrip,
          checkpoint: cp,
          aheadDistanceMeters: ahead,
          io,
          alertType: 'CRITICAL',
          requestedByDriver: false,
        });
        response.targetedOfficerCount = Math.max(response.targetedOfficerCount, targeted.eligibleOfficerCount);
        const alert = {
          tripId,
          junctionId: cp.junction_id,
          junctionName: cp.name,
          sector: cp.sector,
          aheadDistanceMeters: ahead,
          ambulanceNo: trip.ambulance_no,
          destination: trip.destination_display_name || trip.destination,
          trafficLevel: cp.traffic_level || 'LOW',
          targetedOfficerCount: targeted.eligibleOfficerCount,
        };
        io.to(`trip:${tripId}`).emit('checkpoint.activated', alert);
        response.nextJunction.status = 'ACTIVE';
      }
    }

    if ((cp.status === 'ACTIVE' || response.nextJunction.status === 'ACTIVE') && ahead < -passedTolerance) {
      await markCheckpointPassed(tripId, cp, io);
      response.nextJunction.status = 'PASSED';
    }
  }

  io.to(`trip:${tripId}`).emit('trip.location.updated', response);
  return response;
}

export async function requestPoliceAhead(tripId, io) {
  const [[trip]] = await pool.query('SELECT * FROM trips WHERE id=?', [tripId]);
  if (!trip) throw new Error('Trip not found');
  if (trip.status !== 'ACTIVE') throw new Error('Trip is not active');
  if (Boolean(trip.alerts_paused)) {
    throw new Error('Police alert request paused because GPS is inaccurate or ambulance is off-route.');
  }

  const currentOffset = Number(trip.current_route_offset_m || 0);
  await pool.query('UPDATE trips SET police_alert_requested_at=NOW() WHERE id=?', [tripId]);
  trip.police_alert_requested_at = new Date();

  // First target active police duty areas that intersect the remaining route.
  const dutyResult = await syncDutyAreaAlertsForTrip({
    trip,
    currentOffsetMeters: currentOffset,
    io,
    manual: true,
  });

  // Smart-junction targeting remains as a secondary path for fixed posts/ESP32 locations.
  const [checkpoints] = await pool.query(
    `SELECT tj.*,j.name,j.latitude,j.longitude,j.speaker_id,j.sector,COALESCE(tr.level,'LOW') traffic_level
     FROM trip_junctions tj
     JOIN junctions j ON j.id=tj.junction_id
     LEFT JOIN traffic_reports tr ON tr.junction_id=j.id
     WHERE tj.trip_id=? AND tj.status IN ('UPCOMING','ACTIVE')
     ORDER BY tj.sequence_no`,
    [tripId],
  );
  const candidates = selectManualAlertCandidates(
    checkpoints,
    currentOffset,
    manualEarlyWarningDistance,
    manualEarlyWarningCheckpointCount,
  );

  let junctionEligible = 0;
  let junctionNotified = 0;
  const alertedJunctions = [];
  const notifiedOfficers = [...dutyResult.notifiedOfficers];
  const seenOfficerIds = new Set(notifiedOfficers.map(item => item.officerUserId));

  for (const cp of candidates) {
    const result = await upsertTargetedPoliceAlerts({
      trip,
      checkpoint: cp,
      aheadDistanceMeters: cp.aheadDistanceMeters,
      io,
      alertType: cp.aheadDistanceMeters <= activation ? 'CRITICAL' : 'EARLY',
      requestedByDriver: true,
    });
    junctionEligible += result.eligibleOfficerCount;
    junctionNotified += result.notifiedOfficerCount;
    for (const officer of result.notifiedOfficers) {
      if (!seenOfficerIds.has(officer.officerUserId)) {
        seenOfficerIds.add(officer.officerUserId);
        notifiedOfficers.push(officer);
      }
    }
    if (result.eligibleOfficerCount > 0) {
      alertedJunctions.push({
        id: cp.junction_id,
        name: cp.name,
        sector: cp.sector,
        aheadDistanceMeters: Math.round(cp.aheadDistanceMeters),
        alertType: cp.aheadDistanceMeters <= activation ? 'CRITICAL' : 'EARLY',
      });
    }
  }

  const eligibleOfficerCount = new Set([
    ...dutyResult.notifiedOfficers.map(item => item.officerUserId),
    ...notifiedOfficers.map(item => item.officerUserId),
  ]).size || dutyResult.eligibleOfficerCount || junctionEligible;

  const payload = {
    tripId,
    requested: true,
    eligibleOfficerCount,
    notifiedOfficerCount: dutyResult.notifiedOfficerCount + junctionNotified,
    alertedJunctions,
    alertedDutyAreas: dutyResult.targets,
    notifiedOfficers,
  };
  io.to(`trip:${tripId}`).emit('police.manual.requested', payload);
  return payload;
}

export async function forcePassCurrent(tripId, io) {
  const cp = await nextCheckpoint(tripId);
  if (!cp) return null;
  await markCheckpointPassed(tripId, cp, io);
  return cp;
}

export async function completeTrip(tripId, io) {
  const [activeCps] = await pool.query(
    `SELECT tj.*,j.speaker_id,j.sector,j.name
     FROM trip_junctions tj JOIN junctions j ON j.id=tj.junction_id
     WHERE tj.trip_id=? AND tj.status='ACTIVE'`,
    [tripId],
  );
  for (const cp of activeCps) {
    publishSpeakerCommand(cp.speaker_id, 'STOP_EMERGENCY_ALERT', tripId);
    await closePoliceAlertsForCheckpoint(tripId, cp.junction_id, io);
  }
  const [dutyAlerts] = await pool.query(
    `SELECT DISTINCT pa.duty_session_id,pds.id,pds.post_name,pds.latitude,pds.longitude,pds.radius_m,
            pds.officer_user_id,u.user_id officer_user_code,u.name officer_name,u.sector
     FROM police_alerts pa
     JOIN police_duty_sessions pds ON pds.id=pa.duty_session_id
     JOIN users u ON u.id=pds.officer_user_id
     WHERE pa.trip_id=? AND pa.target_kind='DUTY_AREA' AND pa.status='ACTIVE'`,
    [tripId],
  );
  for (const duty of dutyAlerts) {
    await closeDutyAreaAlert(tripId, duty, io);
  }
  await pool.query("UPDATE police_alerts SET status='CLOSED' WHERE trip_id=?", [tripId]);
  await pool.query(
    "UPDATE trips SET status='COMPLETED',completed_at=NOW(),alerts_paused=0 WHERE id=?",
    [tripId],
  );
  io.to(`trip:${tripId}`).emit('trip.completed', {tripId});
}
