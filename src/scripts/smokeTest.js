const base = process.env.API_URL || 'http://127.0.0.1:4000';

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {'content-type': 'application/json', ...(options.headers || {})},
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {raw: text}; }
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${path}: ${response.status} ${body.message || text}`);
  return body;
}
const assert = (condition, message) => { if (!condition) throw new Error(`ASSERTION FAILED: ${message}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Named exactly after the real acceptance scenario requested by the project owner.
// Coordinates are DEMO corridor coordinates, not claimed as surveyed production coordinates.
const origin = {
  name: 'Bypass More - Demo Ambulance Start',
  displayName: 'Bypass More, Gaya - demo corridor start',
  latitude: 24.7982,
  longitude: 85.0082,
  source: 'DEMO',
};
const destination = {
  name: 'Hospital near Vishnupad - Demo Destination',
  displayName: 'Hospital near Vishnupad Temple, Gaya - demo destination',
  latitude: 24.749,
  longitude: 84.9685,
  source: 'DEMO',
};

console.log('1/16 health + service status + local location search + role logins');
const health = await call('/health');
assert(health.database==='ok','database health is not ok');
assert(health.mqtt==='ok','MQTT broker is not connected');
const locationSearch = await call('/api/locations/search?q=Vishnupad&fallback=0');
assert(locationSearch.results?.length>=1,'local location search did not return Vishnupad');
await call('/api/auth/login',{method:'POST',body:JSON.stringify({userId:'DRV001',password:'1234',role:'DRIVER'})});
await call('/api/auth/login',{method:'POST',body:JSON.stringify({userId:'POL005',password:'1234',role:'POLICE'})});

console.log('2/16 Vishnupad officer starts duty');
await call('/api/police/duty/POL005/stop',{method:'POST'}).catch(()=>{});
const duty = await call('/api/police/duty/start',{
  method:'POST',
  body:JSON.stringify({
    officerUserId:'POL005',
    postName:'Vishnupad Temple Traffic Post',
    latitude:24.7690,
    longitude:84.9830,
    radiusMeters:800,
  }),
});
assert(duty.duty?.id,'Vishnupad police duty not created');

console.log('3/16 Bypass More -> Vishnupad hospital preview');
const preview = await call('/api/trips/preview',{
  method:'POST',
  body:JSON.stringify({origin,destination,mode:'DEMO'}),
});
assert(preview.route?.coordinates?.length,'preview route missing');
assert(preview.checkpoints?.some(cp=>String(cp.name).includes('Vishnupad')),'Vishnupad monitored junction missing from route');

console.log('4/16 start ambulance trip + verify From/To persistence + police map location');
const start = await call('/api/trips/start',{
  method:'POST',
  body:JSON.stringify({driverUserId:'DRV001',ambulanceNo:'AMB-101',mode:'DEMO',origin,destination}),
});
assert(start.tripId,'tripId missing');
const details = await call(`/api/trips/${start.tripId}`);
assert(details.trip.origin_name===origin.name,'origin not persisted');
assert(Number(details.trip.origin_latitude)===origin.latitude,'origin latitude not persisted');
assert(details.trip.destination===destination.name,'destination not persisted');
assert(Number(details.trip.destination_longitude)===destination.longitude,'destination longitude not persisted');
assert(details.policePosts?.some(p=>p.officerUserId==='POL005'),'Vishnupad Police duty location not returned to Driver map');
const recoveredActive = await call('/api/trips/active/driver/DRV001');
assert(recoveredActive.active===true,'active Driver trip recovery endpoint did not find the active trip');
assert(Number(recoveredActive.details?.trip?.id)===Number(start.tripId),'active Driver trip recovery returned the wrong trip');

console.log('5/16 route-corridor officer comes online away from any smart junction');
await call('/api/police/duty/POL002/stop',{method:'POST'}).catch(()=>{});
const routeOnlyDuty = await call('/api/police/duty/start',{
  method:'POST',
  body:JSON.stringify({
    officerUserId:'POL002',
    postName:'Route Only Police Post',
    latitude:24.7885,
    longitude:84.9980,
    radiusMeters:300,
  }),
});
assert(routeOnlyDuty.duty?.id,'route-only police duty not created');
assert((routeOnlyDuty.recoveredAlerts||[]).length>=1,'new Police duty did not reconcile against already-active route');
const routeOnlyAlerts = await call('/api/police/alerts/officer/POL002');
assert(routeOnlyAlerts.alerts.some(a=>a.status==='ACTIVE' && a.target_kind==='DUTY_AREA'),'route-corridor Police alert missing when no smart junction is inside duty radius');

console.log('6/16 Police marks Vishnupad traffic HIGH and Driver trip receives it');
const vishnupadCheckpoint = preview.checkpoints.find(cp=>String(cp.name).includes('Vishnupad'));
assert(vishnupadCheckpoint?.id,'Vishnupad checkpoint id missing');
await call(`/api/police/junctions/${vishnupadCheckpoint.id}/traffic`,{
  method:'POST',
  body:JSON.stringify({level:'HIGH',officerUserId:'POL005',note:'Acceptance-test congestion'}),
});
const trafficDetails = await call(`/api/trips/${start.tripId}`);
const trafficCheckpoint = trafficDetails.checkpoints.find(cp=>Number(cp.junction_id)===Number(vishnupadCheckpoint.id));
assert(trafficCheckpoint?.traffic_level==='HIGH','Driver route did not receive HIGH traffic state');

console.log('7/16 DRIVER presses ALERT POLICE AHEAD');
const manual = await call(`/api/trips/${start.tripId}/alert-police-ahead`,{method:'POST'});
assert(manual.eligibleOfficerCount>=1,'no eligible Vishnupad officer found for manual corridor request');
assert((manual.alertedDutyAreas||[]).some(a=>String(a.postName).includes('Vishnupad')) || manual.alertedJunctions.some(j=>String(j.name).includes('Vishnupad')),'manual request did not target Vishnupad duty corridor');

console.log('8/16 verify POL005 receives EARLY driver-requested alert');
let alerts = await call('/api/police/alerts/officer/POL005');
let active = alerts.alerts.find(a=>a.status==='ACTIVE' && String(a.junction_name).includes('Vishnupad'));
assert(active,'Vishnupad early alert missing');
assert(active.alert_type==='EARLY','manual alert should initially be EARLY');
assert(Boolean(Number(active.requested_by_driver)),'manual alert not marked requested_by_driver');

console.log('9/16 police ACKNOWLEDGE + CLEAR_LANE');
await call(`/api/police/alerts/${active.id}/action`,{method:'POST',body:JSON.stringify({action:'ACKNOWLEDGE'})});
await call(`/api/police/alerts/${active.id}/action`,{method:'POST',body:JSON.stringify({action:'CLEAR_LANE'})});

console.log('10/16 move ambulance along demo route with accurate GPS');
for (const [lon,lat] of start.route.coordinates) {
  await call(`/api/trips/${start.tripId}/location`,{
    method:'POST',
    body:JSON.stringify({latitude:lat,longitude:lon,accuracy:5,speed:12.5,heading:90,recordedAt:new Date().toISOString()}),
  });
  await sleep(20);
}

console.log('11/16 verify Vishnupad alert upgraded to CRITICAL near junction');
alerts = await call('/api/police/alerts/officer/POL005');
const vishnupadAlerts = alerts.alerts.filter(a=>String(a.junction_name).includes('Vishnupad'));
assert(vishnupadAlerts.length>=1,'Vishnupad alert history missing');
assert(vishnupadAlerts.some(a=>a.alert_type==='CRITICAL'),'Vishnupad alert never upgraded to CRITICAL');

console.log('12/16 verify telemetry persistence');
const telemetry = await call(`/api/trips/${start.tripId}/telemetry`);
assert(telemetry.telemetry.length>=5,'GPS telemetry not persisted');

console.log('13/16 complete trip + verify alert closure');
await call(`/api/trips/${start.tripId}/complete`,{method:'POST'}).catch(()=>{});
const completed = await call(`/api/trips/${start.tripId}`);
assert(completed.trip.status==='COMPLETED','trip not completed');
alerts = await call('/api/police/alerts/officer/POL005');
assert(!alerts.alerts.some(a=>a.trip_id===start.tripId && a.status==='ACTIVE'),'active police alert remained after trip completion');

console.log('14/16 stop Police duties');
await call('/api/police/duty/POL005/stop',{method:'POST'});
await call('/api/police/duty/POL002/stop',{method:'POST'});
console.log('15/16 verify no active Driver trip remains after completion');
const noActive = await call('/api/trips/active/driver/DRV001');
assert(noActive.active===false,'completed trip was incorrectly recovered as active');
console.log('16/16 all target services and scenario assertions passed');
console.log('SCENARIO SMOKE PASSED: route-corridor duty targeting + Bypass More -> Vishnupad manual alert -> police ACK/CLEAR_LANE -> critical alert -> telemetry -> completion');
