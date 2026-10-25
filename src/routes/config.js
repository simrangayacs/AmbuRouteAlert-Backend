import {Router} from 'express';
import {pool} from '../config/db.js';
const r=Router();
r.get('/hospitals',async(_req,res)=>{const [rows]=await pool.query('SELECT * FROM hospitals ORDER BY id');res.json({hospitals:rows});});
r.get('/junctions',async(_req,res)=>{const [rows]=await pool.query(`SELECT j.*,COALESCE(tr.level,'LOW') traffic_level FROM junctions j LEFT JOIN traffic_reports tr ON tr.junction_id=j.id ORDER BY route_order`);res.json({junctions:rows});});
export default r;
