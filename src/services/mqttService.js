import mqtt from 'mqtt';
import 'dotenv/config';
let client; let ioRef;
export function initMqtt(io){
 ioRef=io; client=mqtt.connect(process.env.MQTT_URL||'mqtt://127.0.0.1:1883',{reconnectPeriod:2000});
 client.on('connect',()=>{console.log('[MQTT] connected');client.subscribe('amburoute/speaker/+/status');});
 client.on('message',(topic,payload)=>{const message=payload.toString();console.log('[MQTT STATUS]',topic,message);ioRef?.emit('speaker.status',{topic,message});});
 client.on('error',e=>console.warn('[MQTT] unavailable:',e.message));
}
export function publishSpeakerCommand(speakerId,command,tripId){
 if(!client?.connected){console.warn('[MQTT] broker not connected; phone siren/socket still works');return false;}
 const topic=`amburoute/speaker/${speakerId}/command`;
 const payload=JSON.stringify({command,tripId,speakerId,issuedAt:new Date().toISOString(),ttlMs:30000});
 client.publish(topic,payload,{qos:1}); console.log('[MQTT COMMAND]',topic,payload); return true;
}
