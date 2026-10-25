const base = process.env.API_URL || 'http://127.0.0.1:4000';

const origin = {
  name: 'Gaya Junction Railway Station (Demo)',
  latitude: 24.7982,
  longitude: 85.0082,
  source: 'DEMO',
};
const destination = {
  name: 'ANMMCH Hospital Gate (Demo)',
  latitude: 24.749,
  longitude: 84.9685,
  source: 'DEMO',
};

const startResponse = await fetch(`${base}/api/trips/start`, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({
    driverUserId: 'DRV001',
    ambulanceNo: 'AMB-101',
    origin,
    destination,
    mode: 'DEMO',
  }),
});

if (!startResponse.ok) {
  throw new Error(`Start failed: ${await startResponse.text()}`);
}

const start = await startResponse.json();
console.log('Trip', start.tripId, 'checkpoints', start.checkpoints?.length ?? 0);

for (const [lon, lat] of start.route.coordinates) {
  const response = await fetch(`${base}/api/trips/${start.tripId}/location`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({latitude: lat, longitude: lon}),
  });
  const result = await response.json();
  console.log(result.nextJunction);
  await new Promise(resolve => setTimeout(resolve, 600));
}
