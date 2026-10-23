import 'dotenv/config';
import {cumulativeOffsets,nearestRoutePoint} from '../utils/routeMath.js';

const DEMO_ROUTE=[
 [85.0082,24.7982],[85.0074,24.7969],[85.0056,24.7954],[85.0020,24.7930],
 [84.9980,24.7885],[84.9915,24.7800],[84.9830,24.7690],[84.9755,24.7585],[84.9685,24.7490]
];

export async function computeRoute(origin,destination,mode='REAL') {
  if(mode==='DEMO') {
    const offsets=cumulativeOffsets(DEMO_ROUTE);
    return {coordinates:DEMO_ROUTE,distanceMeters:Math.round(offsets.at(-1)||0),durationSeconds:900,provider:'DEMO_OSM_CORRIDOR'};
  }
  const base=process.env.OSRM_BASE_URL||'https://router.project-osrm.org';
  const url=`${base}/route/v1/driving/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?overview=full&geometries=geojson&steps=true`;
  const r=await fetch(url,{headers:{'User-Agent':'AmbuRouteHackathon/2.0'}});
  if(!r.ok) throw new Error(`OSRM route request failed (${r.status})`);
  const data=await r.json();
  if(data.code!=='Ok'||!data.routes?.[0]) throw new Error(data.message||'No route found');
  return {coordinates:data.routes[0].geometry.coordinates,distanceMeters:Math.round(data.routes[0].distance),durationSeconds:Math.round(data.routes[0].duration),provider:'OSRM'};
}

export function matchJunctionsToRoute(routeCoords,junctions,maxDistanceMeters=700) {
  const offsets=cumulativeOffsets(routeCoords);
  return junctions.map(j=>{
    const match=nearestRoutePoint(routeCoords,Number(j.latitude),Number(j.longitude));
    return {...j,routeIndex:match.index,routeOffsetMeters:Math.round(offsets[match.index]||0),routeDistanceMeters:Math.round(match.distanceMeters)};
  }).filter(j=>j.routeDistanceMeters<=maxDistanceMeters).sort((a,b)=>a.routeOffsetMeters-b.routeOffsetMeters);
}
