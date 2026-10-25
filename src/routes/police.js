import {Router} from 'express';
import {pool} from '../config/db.js';
import {syncNewDutyAgainstActiveTrips} from '../services/alertService.js';

const r = Router();

r.post('/duty/start', async (req, res, next) => {
  try {
    const {officerUserId, postName, latitude, longitude, radiusMeters = 500} = req.body;
    const lat = Number(latitude);
    const lon = Number(longitude);
    const radius = Number(radiusMeters);
    if (!officerUserId || !String(postName || '').trim() || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({message: 'Officer, post name and valid location are required.'});
    }
    if (![300, 500, 800, 1200].includes(radius)) {
      return res.status(400).json({message: 'Radius must be 300, 500, 800 or 1200 metres.'});
    }
    const [[officer]] = await pool.query(
      "SELECT * FROM users WHERE user_id=? AND role='POLICE'",
      [officerUserId],
    );
    if (!officer) return res.status(404).json({message: 'Police officer not found.'});

    await pool.query(
      "UPDATE police_duty_sessions SET status='ENDED',ended_at=NOW() WHERE officer_user_id=? AND status='ACTIVE'",
      [officer.id],
    );
    const [insert] = await pool.query(
      `INSERT INTO police_duty_sessions(officer_user_id,post_name,latitude,longitude,radius_m,status)
       VALUES(?,?,?,?,?,'ACTIVE')`,
      [officer.id, String(postName).trim(), lat, lon, radius],
    );
    const [[duty]] = await pool.query(
      `SELECT pds.*,u.user_id officer_user_code,u.name officer_name,u.sector
       FROM police_duty_sessions pds JOIN users u ON u.id=pds.officer_user_id WHERE pds.id=?`,
      [insert.insertId],
    );

    // Important: if an ambulance trip was already active before the officer pressed
    // START DUTY, immediately reconcile this new duty area against active routes.
    const recoveredAlerts = await syncNewDutyAgainstActiveTrips(duty, req.app.get('io'));
    return res.json({success: true, duty, recoveredAlerts});
  } catch (error) {
    next(error);
  }
});

r.get('/duty/:officerUserId', async (req, res, next) => {
  try {
    const [[duty]] = await pool.query(
      `SELECT pds.*,u.user_id officer_user_code,u.name officer_name,u.sector
       FROM police_duty_sessions pds
       JOIN users u ON u.id=pds.officer_user_id
       WHERE u.user_id=? AND pds.status='ACTIVE'
       ORDER BY pds.id DESC LIMIT 1`,
      [req.params.officerUserId],
    );
    return res.json({duty: duty || null});
  } catch (error) {
    next(error);
  }
});

r.post('/duty/:officerUserId/stop', async (req, res, next) => {
  try {
    const [[officer]] = await pool.query(
      "SELECT id FROM users WHERE user_id=? AND role='POLICE'",
      [req.params.officerUserId],
    );
    if (!officer) return res.status(404).json({message: 'Police officer not found.'});
    await pool.query(
      "UPDATE police_duty_sessions SET status='ENDED',ended_at=NOW() WHERE officer_user_id=? AND status='ACTIVE'",
      [officer.id],
    );
    await pool.query(
      "UPDATE police_alerts SET status='CLOSED' WHERE officer_user_id=? AND status='ACTIVE'",
      [officer.id],
    );
    return res.json({success: true});
  } catch (error) {
    next(error);
  }
});

r.get('/alerts/officer/:officerUserId', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT pa.*,
              COALESCE(pa.target_name,j.name,pds.post_name,'Traffic corridor') junction_name,
              COALESCE(pa.target_latitude,j.latitude,pds.latitude) junction_latitude,
              COALESCE(pa.target_longitude,j.longitude,pds.longitude) junction_longitude,
              t.ambulance_no,t.destination,t.destination_display_name,t.current_latitude,t.current_longitude,
              t.current_accuracy_m,t.current_speed_mps,t.alerts_paused,t.off_route_distance_m,
              t.route_distance_m,t.route_duration_s,t.current_route_offset_m,t.route_json,
              driver.name driver_name,COALESCE(tr.level,'LOW') traffic_level,
              GREATEST(0,COALESCE(pa.route_offset_m,0)-COALESCE(t.current_route_offset_m,0)) distance_ahead_m,
              CASE WHEN t.route_distance_m>0 THEN ROUND(
                t.route_duration_s * GREATEST(0,COALESCE(pa.route_offset_m,0)-COALESCE(t.current_route_offset_m,0)) / t.route_distance_m
              ) ELSE 0 END eta_seconds
       FROM police_alerts pa
       JOIN users officer ON officer.id=pa.officer_user_id
       JOIN trips t ON t.id=pa.trip_id
       JOIN users driver ON driver.id=t.driver_user_id
       LEFT JOIN junctions j ON j.id=pa.junction_id
       LEFT JOIN police_duty_sessions pds ON pds.id=pa.duty_session_id
       LEFT JOIN traffic_reports tr ON tr.junction_id=pa.junction_id
       WHERE officer.user_id=?
       ORDER BY (pa.status='ACTIVE') DESC, pa.id DESC LIMIT 40`,
      [req.params.officerUserId],
    );
    return res.json({
      alerts: rows.map(row => {
        let route = [];
        try { route = row.route_json ? JSON.parse(row.route_json) : []; } catch { route = []; }
        return {...row, route};
      }),
    });
  } catch (error) {
    next(error);
  }
});

r.post('/alerts/:id/action', async (req, res) => {
  const {action} = req.body;
  const allowed = ['ACKNOWLEDGE', 'CLEAR_LANE', 'STOP_TRAFFIC'];
  if (!allowed.includes(action)) return res.status(400).json({message: 'Invalid action'});
  const [[a]] = await pool.query('SELECT * FROM police_alerts WHERE id=?', [req.params.id]);
  if (!a) return res.status(404).json({message: 'Alert not found'});
  if (a.status !== 'ACTIVE') return res.status(409).json({message: 'This alert is already closed.'});
  await pool.query(
    "UPDATE police_alerts SET last_action=?,acknowledged_at=IF(?='ACKNOWLEDGE',NOW(),acknowledged_at) WHERE id=?",
    [action, action, req.params.id],
  );
  const payload = {alertId: Number(req.params.id), tripId: a.trip_id, action};
  req.app.get('io').to(`trip:${a.trip_id}`).emit('police.action', payload);
  res.json({success: true, ...payload});
});

r.post('/junctions/:id/traffic', async (req, res) => {
  const junctionId = Number(req.params.id);
  if (!Number.isInteger(junctionId) || junctionId <= 0) {
    return res.status(400).json({message: 'Traffic reporting requires a monitored junction.'});
  }
  const {level, note = '', officerUserId = 'POL001'} = req.body;
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(level)) return res.status(400).json({message: 'Invalid traffic level'});
  const [[junction]] = await pool.query('SELECT id FROM junctions WHERE id=?', [junctionId]);
  if (!junction) return res.status(404).json({message: 'Junction not found'});
  const [[u]] = await pool.query("SELECT id FROM users WHERE user_id=? AND role='POLICE'", [officerUserId]);
  await pool.query(
    `INSERT INTO traffic_reports(junction_id,level,note,updated_by) VALUES(?,?,?,?)
     ON DUPLICATE KEY UPDATE level=VALUES(level),note=VALUES(note),updated_by=VALUES(updated_by),updated_at=NOW()`,
    [junctionId, level, note, u?.id || null],
  );
  req.app.get('io').emit('traffic.updated', {junctionId, level, note});
  res.json({success: true, level});
});

export default r;
