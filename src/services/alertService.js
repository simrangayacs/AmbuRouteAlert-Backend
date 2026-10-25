import 'dotenv/config';
import {pool} from '../config/db.js';
import {dutyCoversCheckpoint, dutyRouteTarget} from '../utils/targeting.js';

const manualAheadDistance = Number(process.env.MANUAL_EARLY_WARNING_DISTANCE_METERS || 8000);
const earlyAheadDistance = Number(process.env.EARLY_WARNING_DISTANCE_METERS || 3000);
const activationDistance = Number(process.env.ACTIVATION_DISTANCE_METERS || 550);
const routePoliceBuffer = Number(process.env.POLICE_ROUTE_CORRIDOR_BUFFER_METERS || 100);

function emitAlert(io, duty, payload) {
  io.to(`officer:${duty.officer_user_code}`).emit('police.alert.created', payload);
}

function checkpointPayload({trip, checkpoint, aheadDistanceMeters, duty, alertType, requestedByDriver, alertId}) {
  return {
    alertId,
    tripId: trip.id,
    targetKind: 'JUNCTION',
    junctionId: checkpoint.junction_id ?? checkpoint.id,
    junctionName: checkpoint.name,
    targetName: checkpoint.name,
    targetLatitude: Number(checkpoint.latitude),
    targetLongitude: Number(checkpoint.longitude),
    sector: checkpoint.sector,
    aheadDistanceMeters: Math.max(0, Math.round(aheadDistanceMeters ?? 0)),
    ambulanceNo: trip.ambulance_no,
    destination: trip.destination_display_name || trip.destination,
    trafficLevel: checkpoint.traffic_level || 'LOW',
    officerUserId: duty.officer_user_code,
    dutyPostName: duty.post_name,
    alertType,
    requestedByDriver: Boolean(requestedByDriver),
  };
}

function dutyPayload({trip, duty, target, alertType, requestedByDriver, alertId}) {
  return {
    alertId,
    tripId: trip.id,
    targetKind: 'DUTY_AREA',
    junctionId: null,
    junctionName: duty.post_name,
    targetName: duty.post_name,
    targetLatitude: Number(duty.latitude),
    targetLongitude: Number(duty.longitude),
    sector: duty.sector || 'DUTY_AREA',
    aheadDistanceMeters: Math.max(0, Math.round(target.aheadDistanceMeters ?? 0)),
    ambulanceNo: trip.ambulance_no,
    destination: trip.destination_display_name || trip.destination,
    trafficLevel: 'LOW',
    officerUserId: duty.officer_user_code,
    dutyPostName: duty.post_name,
    alertType,
    requestedByDriver: Boolean(requestedByDriver),
  };
}

export async function upsertTargetedPoliceAlerts({
  trip,
  checkpoint,
  aheadDistanceMeters,
  io,
  alertType = 'CRITICAL',
  requestedByDriver = false,
}) {
  const [duties] = await pool.query(
    `SELECT pds.*,u.user_id officer_user_code,u.name officer_name,u.sector
     FROM police_duty_sessions pds
     JOIN users u ON u.id=pds.officer_user_id
     WHERE pds.status='ACTIVE'`,
  );

  let eligibleOfficerCount = 0;
  let notifiedOfficerCount = 0;
  const notifiedOfficers = [];

  for (const duty of duties) {
    const coverage = dutyCoversCheckpoint(duty, checkpoint);
    if (!coverage.eligible) continue;
    eligibleOfficerCount += 1;

    const [[existing]] = await pool.query(
      `SELECT * FROM police_alerts
       WHERE trip_id=? AND junction_id=? AND officer_user_id=? AND status='ACTIVE'
       ORDER BY id DESC LIMIT 1`,
      [trip.id, checkpoint.junction_id ?? checkpoint.id, duty.officer_user_id],
    );

    let alertId;
    let shouldNotify = false;
    let effectiveType = alertType;

    if (existing) {
      if (existing.alert_type === 'CRITICAL') effectiveType = 'CRITICAL';
      const typeUpgrade = existing.alert_type !== 'CRITICAL' && alertType === 'CRITICAL';
      const driverUpgrade = requestedByDriver && !Boolean(existing.requested_by_driver);
      if (typeUpgrade || driverUpgrade) {
        await pool.query(
          `UPDATE police_alerts
           SET alert_type=?, requested_by_driver=GREATEST(requested_by_driver,?),
               target_kind='JUNCTION',target_name=?,target_latitude=?,target_longitude=?,
               route_offset_m=?,distance_ahead_m=?,last_notified_at=NOW()
           WHERE id=?`,
          [
            effectiveType,
            requestedByDriver ? 1 : 0,
            checkpoint.name,
            Number(checkpoint.latitude),
            Number(checkpoint.longitude),
            Number(checkpoint.route_offset_m || 0),
            Math.max(0, Math.round(aheadDistanceMeters || 0)),
            existing.id,
          ],
        );
        shouldNotify = true;
      }
      alertId = existing.id;
    } else {
      const [insert] = await pool.query(
        `INSERT INTO police_alerts(
          trip_id,junction_id,officer_user_id,duty_session_id,sector,status,alert_type,
          requested_by_driver,last_notified_at,target_kind,target_name,target_latitude,
          target_longitude,route_offset_m,distance_ahead_m
         ) VALUES(?,?,?,?,?,'ACTIVE',?,?,NOW(),'JUNCTION',?,?,?,?,?)`,
        [
          trip.id,
          checkpoint.junction_id ?? checkpoint.id,
          duty.officer_user_id,
          duty.id,
          checkpoint.sector,
          alertType,
          requestedByDriver ? 1 : 0,
          checkpoint.name,
          Number(checkpoint.latitude),
          Number(checkpoint.longitude),
          Number(checkpoint.route_offset_m || 0),
          Math.max(0, Math.round(aheadDistanceMeters || 0)),
        ],
      );
      alertId = insert.insertId;
      shouldNotify = true;
    }

    if (shouldNotify) {
      notifiedOfficerCount += 1;
      notifiedOfficers.push({
        officerUserId: duty.officer_user_code,
        officerName: duty.officer_name,
        postName: duty.post_name,
      });
      emitAlert(io, duty, checkpointPayload({
        trip,
        checkpoint,
        aheadDistanceMeters,
        duty,
        alertType: effectiveType,
        requestedByDriver,
        alertId,
      }));
    }
  }

  return {eligibleOfficerCount, notifiedOfficerCount, notifiedOfficers};
}

export async function upsertDutyAreaAlert({trip, duty, target, io, alertType = 'EARLY', requestedByDriver = false}) {
  const [[existing]] = await pool.query(
    `SELECT * FROM police_alerts
     WHERE trip_id=? AND duty_session_id=? AND officer_user_id=? AND target_kind='DUTY_AREA' AND status='ACTIVE'
     ORDER BY id DESC LIMIT 1`,
    [trip.id, duty.id, duty.officer_user_id],
  );

  let effectiveType = existing?.alert_type === 'CRITICAL' ? 'CRITICAL' : alertType;
  let shouldNotify = false;
  let alertId;

  if (existing) {
    const typeUpgrade = existing.alert_type !== 'CRITICAL' && alertType === 'CRITICAL';
    const driverUpgrade = requestedByDriver && !Boolean(existing.requested_by_driver);
    await pool.query(
      `UPDATE police_alerts SET
         alert_type=?,requested_by_driver=GREATEST(requested_by_driver,?),
         target_name=?,target_latitude=?,target_longitude=?,route_offset_m=?,distance_ahead_m=?,
         last_notified_at=IF(? OR ?,NOW(),last_notified_at)
       WHERE id=?`,
      [
        effectiveType,
        requestedByDriver ? 1 : 0,
        duty.post_name,
        Number(duty.latitude),
        Number(duty.longitude),
        Math.round(target.routeOffsetMeters || 0),
        Math.max(0, Math.round(target.aheadDistanceMeters || 0)),
        typeUpgrade ? 1 : 0,
        driverUpgrade ? 1 : 0,
        existing.id,
      ],
    );
    shouldNotify = typeUpgrade || driverUpgrade;
    alertId = existing.id;
  } else {
    const [insert] = await pool.query(
      `INSERT INTO police_alerts(
        trip_id,junction_id,officer_user_id,duty_session_id,sector,status,alert_type,
        requested_by_driver,last_notified_at,target_kind,target_name,target_latitude,
        target_longitude,route_offset_m,distance_ahead_m
       ) VALUES(?,NULL,?,?,?,'ACTIVE',?,?,NOW(),'DUTY_AREA',?,?,?,?,?)`,
      [
        trip.id,
        duty.officer_user_id,
        duty.id,
        duty.sector || 'DUTY_AREA',
        alertType,
        requestedByDriver ? 1 : 0,
        duty.post_name,
        Number(duty.latitude),
        Number(duty.longitude),
        Math.round(target.routeOffsetMeters || 0),
        Math.max(0, Math.round(target.aheadDistanceMeters || 0)),
      ],
    );
    alertId = insert.insertId;
    shouldNotify = true;
  }

  if (shouldNotify) {
    emitAlert(io, duty, dutyPayload({trip, duty, target, alertType: effectiveType, requestedByDriver, alertId}));
  }
  return {alertId, notified: shouldNotify, alertType: effectiveType};
}

export async function closeDutyAreaAlert(tripId, duty, io) {
  const [alerts] = await pool.query(
    `SELECT id FROM police_alerts
     WHERE trip_id=? AND duty_session_id=? AND target_kind='DUTY_AREA' AND status='ACTIVE'`,
    [tripId, duty.id],
  );
  if (!alerts.length) return;
  await pool.query(
    `UPDATE police_alerts SET status='CLOSED'
     WHERE trip_id=? AND duty_session_id=? AND target_kind='DUTY_AREA' AND status='ACTIVE'`,
    [tripId, duty.id],
  );
  io.to(`officer:${duty.officer_user_code}`).emit('police.alert.closed', {tripId, dutySessionId: duty.id});
}

export async function syncDutyAreaAlertsForTrip({trip, currentOffsetMeters, io, manual = false}) {
  let route = [];
  try { route = trip.route_json ? JSON.parse(trip.route_json) : []; } catch { route = []; }
  if (route.length < 2) return {eligibleOfficerCount: 0, notifiedOfficerCount: 0, notifiedOfficers: [], targets: []};

  const [duties] = await pool.query(
    `SELECT pds.*,u.user_id officer_user_code,u.name officer_name,u.sector
     FROM police_duty_sessions pds
     JOIN users u ON u.id=pds.officer_user_id
     WHERE pds.status='ACTIVE'`,
  );

  const maxAhead = manual ? manualAheadDistance : earlyAheadDistance;
  let eligibleOfficerCount = 0;
  let notifiedOfficerCount = 0;
  const notifiedOfficers = [];
  const targets = [];

  for (const duty of duties) {
    const target = dutyRouteTarget(duty, route, currentOffsetMeters, maxAhead, routePoliceBuffer);
    if (!target.eligible) {
      if (target.aheadDistanceMeters != null && target.aheadDistanceMeters < -Number(duty.radius_m || 0)) {
        await closeDutyAreaAlert(trip.id, duty, io);
      }
      continue;
    }
    eligibleOfficerCount += 1;
    const criticalThreshold = Math.max(activationDistance, Number(duty.radius_m || 0));
    const alertType = target.aheadDistanceMeters <= criticalThreshold ? 'CRITICAL' : 'EARLY';
    const result = await upsertDutyAreaAlert({
      trip,
      duty,
      target,
      io,
      alertType,
      requestedByDriver: manual,
    });
    if (result.notified) notifiedOfficerCount += 1;
    notifiedOfficers.push({officerUserId: duty.officer_user_code, officerName: duty.officer_name, postName: duty.post_name});
    targets.push({
      dutySessionId: Number(duty.id),
      postName: duty.post_name,
      officerUserId: duty.officer_user_code,
      aheadDistanceMeters: Math.max(0, Math.round(target.aheadDistanceMeters || 0)),
      alertType,
    });
  }

  return {eligibleOfficerCount, notifiedOfficerCount, notifiedOfficers, targets};
}

export async function syncNewDutyAgainstActiveTrips(duty, io) {
  const [trips] = await pool.query(`SELECT * FROM trips WHERE status='ACTIVE' AND route_json IS NOT NULL`);
  const created = [];
  for (const trip of trips) {
    let route = [];
    try { route = JSON.parse(trip.route_json || '[]'); } catch { route = []; }
    const target = dutyRouteTarget(
      duty,
      route,
      Number(trip.current_route_offset_m || 0),
      manualAheadDistance,
      routePoliceBuffer,
    );
    if (!target.eligible) continue;
    const alertType = target.aheadDistanceMeters <= Math.max(activationDistance, Number(duty.radius_m || 0)) ? 'CRITICAL' : 'EARLY';
    const requestedByDriver = Boolean(trip.police_alert_requested_at);
    const result = await upsertDutyAreaAlert({trip, duty, target, io, alertType, requestedByDriver});
    created.push({tripId: trip.id, alertId: result.alertId, alertType});
  }
  return created;
}
