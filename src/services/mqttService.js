import mqtt from 'mqtt';
import 'dotenv/config';

let client;
let ioRef;

export function initMqtt(io) {
ioRef = io;

const mqttUrl = process.env.MQTT_URL;

if (!mqttUrl) {
console.log('[MQTT] MQTT_URL not configured; MQTT disabled.');
return;
}

client = mqtt.connect(mqttUrl, {
reconnectPeriod: 5000,
});

client.on('connect', () => {
console.log('[MQTT] connected');
client.subscribe('amburoute/speaker/+/status');
});

client.on('message', (topic, payload) => {
const message = payload.toString();

```
console.log('[MQTT STATUS]', topic, message);

ioRef?.emit('speaker.status', {
  topic,
  message,
});
```

});

client.on('error', (error) => {
console.warn('[MQTT] unavailable:', error.message);
});
}

export function publishSpeakerCommand(speakerId, command, tripId) {
if (!client?.connected) {
console.warn(
'[MQTT] broker not connected; phone siren/socket still works',
);
return false;
}

const topic = `amburoute/speaker/${speakerId}/command`;

const payload = JSON.stringify({
command,
tripId,
speakerId,
issuedAt: new Date().toISOString(),
ttlMs: 30000,
});

client.publish(topic, payload, { qos: 1 });

console.log('[MQTT COMMAND]', topic, payload);

return true;
}
