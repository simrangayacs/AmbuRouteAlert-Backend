import {Router} from 'express';
import {pool} from '../config/db.js';
import {computeRoute,matchJunctionsToRoute} from '../services/routeService.js';
import {processLocation,forcePassCurrent,completeTrip} from '../services/tripService.js';
const r=Router();

r.post('/preview',async(req,res,next)=>{try{
 const {origin,destinationHospitalId,mode='REAL'}=req.body;
 const [[h]]=await pool.query('SELECT * FROM hospitals WHERE id=?',[destinationHospitalId]);
 if(!h)return res.status(404).json({message:'Hospital not found'});
 const route=await computeRoute(origin,{latitude:Number(h.latitude),longitude:Number(h.longitude)},mode);
 res.json({hospital:h,route});
}catch(e){next(e)}});

r.post('/start',async(req,res,next)=>{try{
 const {driverUserId='DRV001',ambulanceNo='AMB-101',origin,destinationHospitalId,mode='REAL'}=req.body;
 const [[u]]=await pool.query("SELECT id FROM users WHERE user_id=? AND role='DRIVER'",[driverUserId]);
 const [[h]]=await pool.query('SELECT * FROM hospitals WHERE id=?',[destinationHospitalId]);
 if(!u||!h)return res.status(400).json({message:'Invalid driver/hospital'});
 const route=await computeRoute(origin,{latitude:Number(h.latitude),longitude:Number(h.longitude)},mode);
 await pool.query("UPDATE trips SET status='COMPLETED' WHERE status='ACTIVE'");
 const [ins]=await pool.query(`INSERT INTO trips(driver_user_id,ambulance_no,origin_latitude,origin_longitude,destination_hospital_id,destination,route_json,route_distance_m,route_duration_s,status,mode,current_latitude,current_longitude)
 VALUES(?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?)`,[u.id,ambulanceNo,origin.latitude,origin.longitude,h.id,h.name,JSON.stringify(route.coordinates),route.distanceMeters,route.durationSeconds,mode,origin.latitude,origin.longitude]);
 const tripId=ins.insertId;
 const [junctions]=await pool.query('SELECT * FROM junctions ORDER BY route_order');
 const matched=matchJunctionsToRoute(route.coordinates,junctions,Number(process.env.JUNCTION_ROUTE_MATCH_METERS||700));
 for(let i=0;i<matched.length;i++)await pool.query('INSERT INTO trip_junctions(trip_id,junction_id,sequence_no,route_index,route_offset_m,status) VALUES(?,?,?,?,?,\'UPCOMING\')',[tripId,matched[i].id,i+1,matched[i].routeIndex,matched[i].routeOffsetMeters]);
 res.json({success:true,tripId,hospital:h,route,checkpoints:matched});
}catch(e){next(e)}});

r.get('/:id',async(req,res)=>{
 const [[trip]]=await pool.query('SELECT * FROM trips WHERE id=?',[req.params.id]); if(!trip)return res.status(404).json({message:'Trip not found'});
 const [checkpoints]=await pool.query(`SELECT tj.*,j.name,j.latitude,j.longitude,j.sector,j.speaker_id,COALESCE(tr.level,'LOW') traffic_level FROM trip_junctions tj JOIN junctions j ON j.id=tj.junction_id LEFT JOIN traffic_reports tr ON tr.junction_id=j.id WHERE tj.trip_id=? ORDER BY sequence_no`,[req.params.id]);
 res.json({trip:{...trip,route:JSON.parse(trip.route_json)},checkpoints});
});

r.post('/:id/location',async(req,res,next)=>{try{res.json({success:true,...await processLocation({tripId:Number(req.params.id),latitude:Number(req.body.latitude),longitude:Number(req.body.longitude)},req.app.get('io'))});}catch(e){next(e)}});
r.post('/:id/pass-current',async(req,res,next)=>{try{res.json({success:true,junction:await forcePassCurrent(Number(req.params.id),req.app.get('io'))});}catch(e){next(e)}});
r.post('/:id/complete',async(req,res,next)=>{try{await completeTrip(Number(req.params.id),req.app.get('io'));res.json({success:true});}catch(e){next(e)}});
export default r;
