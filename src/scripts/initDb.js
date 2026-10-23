import fs from 'node:fs/promises';
import mysql from 'mysql2/promise';
import 'dotenv/config';

const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  multipleStatements: true,
});

const schema = await fs.readFile(new URL('../../sql/schema.sql', import.meta.url), 'utf8');
const seed = await fs.readFile(new URL('../../sql/seed.sql', import.meta.url), 'utf8');
await connection.query(schema);
await connection.query(seed);
console.log('Database initialized with demo users and junctions.');
await connection.end();
