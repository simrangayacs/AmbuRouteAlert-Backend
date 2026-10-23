import 'dotenv/config';
import {pool} from '../config/db.js';
import {cumulativeOffsets,routeOffsetAt} from '../utils/routeMath.js';
import {publishSpeakerCommand} from './mqttService.js';

const activation=Number(process.env.ACTIVATION_DISTANCE_METERS||550);
const passedTolerance=Number(process.env.PASSED_TOLERANCE_METERS||70);

async function nextCheckpoint(tripId){
 const [[j]]=await pool.query(`SELECT tj.*,j.name,j.latitude,j.longitude,j.speaker_id,j.sector,tr.level traffic_level
 FROM trip_junctions tj JOIN junctions j ON j.id=tj.junction_id
 LEFT JOIN traffic_reports tr ON tr.junction_id=j.id
 WHERE tj.trip_id=? AND tj.status IN ('UPCOMING','ACTIVE') ORDER BY tj.sequence_no LIMIT 1`,[tripId]);
 return j||null;
}

export async function processLocation({tripId,latitude,longitude},io){
 const [[trip]]=await pool.query('SELECT * FROM trips WHERE id=?',[tripId]);
 if(!trip) throw new Error('Trip not found');
 const route=JSON.parse(trip.route_json); const offsets=cumulativeOffsets(route);
 const current=routeOffsetAt(route,offsets,latitude,longitude);
 await pool.query('UPDATE trips SET current_latitude=?,current_longitude=?,current_route_offset_m=?,updated_at=NOW() WHERE id=?',[latitude,longitude,current.offsetMeters,tripId]);
 const cp=await nextCheckpoint(tripId);
 const response={tripId,latitude,longitude,currentRouteOffsetMeters:current.offsetMeters,nextJunction:null};
 if(!cp){io.to(`trip:${tripId}`).emit('trip.location.updated',response);return response;}
 const ahead=Math.round(cp.route_offset_m-current.offsetMeters);
 response.nextJunction={id:cp.junction_id,name:cp.name,sector:cp.sector,status:cp.status,aheadDistanceMeters:ahead,trafficLevel:cp.traffic_level||'LOW'};
 if(cp.status==='UPCOMING'&&ahead>=0&&ahead<=activation){
  const [u]=await pool.query("UPDATE trip_junctions SET status='ACTIVE',activated_at=NOW() WHERE id=? AND status='UPCOMING'",[cp.id]);
  if(u.affectedRows){
   publishSpeakerCommand(cp.speaker_id,'PLAY_EMERGENCY_ALERT',tripId);
   await pool.query(`INSERT INTO police_alerts(trip_id,junction_id,sector,status) SELECT ?,?,?,'ACTIVE' WHERE NOT EXISTS(SELECT 1 FROM police_alerts WHERE trip_id=? AND junction_id=? AND status='ACTIVE')`,[tripId,cp.junction_id,cp.sector,tripId,cp.junction_id]);
   const alert={tripId,junctionId:cp.junction_id,junctionName:cp.name,sector:cp.sector,aheadDistanceMeters:ahead,ambulanceNo:trip.ambulance_no,destination:trip.destination,trafficLevel:cp.traffic_level||'LOW'};
   io.to(`sector:${cp.sector}`).emit('police.alert.created',alert);
   io.to(`trip:${tripId}`).emit('checkpoint.activated',alert);
   response.nextJunction.status='ACTIVE';
  }
 }
 if((cp.status==='ACTIVE'||response.nextJunction.status==='ACTIVE')&&ahead < -passedTolerance){await markCheckpointPassed(tripId,cp,io);response.nextJunction.status='PASSED';}
 io.to(`trip:${tripId}`).emit('trip.location.updated',response);
 return response;
}

async function markCheckpointPassed(tripId,cp,io){
 await pool.query("UPDATE trip_junctions SET status='PASSED',passed_at=NOW() WHERE id=? AND status IN ('UPCOMING','ACTIVE')",[cp.id]);
 await pool.query("UPDATE police_alerts SET status='CLOSED' WHERE trip_id=? AND junction_id=? AND status='ACTIVE'",[tripId,cp.junction_id]);
 publishSpeakerCommand(cp.speaker_id,'STOP_EMERGENCY_ALERT',tripId);
 io.to(`trip:${tripId}`).emit('checkpoint.passed',{tripId,junctionId:cp.junction_id,junctionName:cp.name});
 io.to(`sector:${cp.sector}`).emit('police.alert.closed',{tripId,junctionId:cp.junction_id});
}

export async function forcePassCurrent(tripId,io){const cp=await nextCheckpoint(tripId);if(!cp)return null;await markCheckpointPassed(tripId,cp,io);return cp;}
export async function completeTrip(tripId,io){const cp=await nextCheckpoint(tripId);if(cp?.status==='ACTIVE')await markCheckpointPassed(tripId,cp,io);await pool.query("UPDATE police_alerts SET status='CLOSED' WHERE trip_id=?",[tripId]);await pool.query("UPDATE trips SET status='COMPLETED' WHERE id=?",[tripId]);io.to(`trip:${tripId}`).emit('trip.completed',{tripId});}
