const base=process.env.API_URL||'http://127.0.0.1:4000';
const origin={latitude:24.7982,longitude:85.0082};
const start=await fetch(`${base}/api/trips/start`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({driverUserId:'DRV001',ambulanceNo:'AMB-101',origin,destinationHospitalId:1,mode:'DEMO'})}).then(r=>r.json());
console.log('Trip',start.tripId,'checkpoints',start.checkpoints?.length);
for(const [lon,lat] of start.route.coordinates){const r=await fetch(`${base}/api/trips/${start.tripId}/location`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({latitude:lat,longitude:lon})}).then(x=>x.json());console.log(r.nextJunction);await new Promise(x=>setTimeout(x,900));}
