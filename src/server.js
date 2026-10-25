import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import cors from 'cors';
import http from 'node:http';
import {Server} from 'socket.io';
import authRoutes from './routes/auth.js';
import tripRoutes from './routes/trips.js';
import policeRoutes from './routes/police.js';
import configRoutes from './routes/config.js';
import locationRoutes from './routes/locations.js';
import {configureSocket} from './socket/index.js';
import {initMqtt, isMqttConnected} from './services/mqttService.js';
import {pool} from './config/db.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(cors());
app.use(express.json({limit: '1mb'}));
app.use('/assets', express.static(path.join(__dirname, '../public')));

app.get('/health', async (_req, res) => {
  let database = 'down';
  try {
    await pool.query('SELECT 1');
    database = 'ok';
  } catch {}
  const mqtt = isMqttConnected() ? 'ok' : 'down';
  const status = database === 'ok' ? 'ok' : 'degraded';
  res.status(database === 'ok' ? 200 : 503).json({
    status,
    app: 'AmbuRoute Alert',
    database,
    mqtt,
    map: 'OpenStreetMap/Leaflet',
    routing: 'OSRM',
    geocoding: 'Nominatim + Photon fallback',
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/config', configRoutes);
app.use('/api/locations', locationRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/police', policeRoutes);

app.use((req, res) => {
  res.status(404).json({message: `Route not found: ${req.method} ${req.path}`});
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({success: false, message: error.message || 'Internal server error'});
});

const server = http.createServer(app);
const io = new Server(server, {cors: {origin: '*'}});
app.set('io', io);
configureSocket(io);
initMqtt(io);

const port = Number(process.env.PORT || 4000);
server.listen(port, '0.0.0.0', () => {
  console.log(`AmbuRoute backend: http://0.0.0.0:${port}`);
});
