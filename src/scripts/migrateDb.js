import 'dotenv/config';
import {pool} from '../config/db.js';

const dbName = process.env.MYSQL_DATABASE || 'amburoute';

async function tableExists(table) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=? LIMIT 1`,
    [dbName, table],
  );
  return rows.length > 0;
}

async function columnExists(table, column) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1`,
    [dbName, table, column],
  );
  return rows.length > 0;
}

async function addColumn(table, column, definition) {
  if (!(await tableExists(table))) return;
  if (!(await columnExists(table, column))) {
    console.log(`[DB] adding ${table}.${column}`);
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function run() {
  console.log(`[DB] upgrading ${dbName}`);

  await addColumn('junctions', 'enabled', 'TINYINT(1) NOT NULL DEFAULT 1');

  // Upgrade the original student/demo trips table to the mobile From/To contract.
  await addColumn('trips', 'origin_name', 'VARCHAR(200) NULL');
  await addColumn('trips', 'origin_display_name', 'VARCHAR(500) NULL');
  await addColumn('trips', 'origin_source', "ENUM('GPS','SEARCH','DEMO') NULL DEFAULT 'SEARCH'");
  await addColumn('trips', 'origin_latitude', 'DECIMAL(10,7) NULL');
  await addColumn('trips', 'origin_longitude', 'DECIMAL(10,7) NULL');
  await addColumn('trips', 'destination_display_name', 'VARCHAR(500) NULL');
  await addColumn('trips', 'destination_source', "ENUM('GPS','SEARCH','DEMO') NULL DEFAULT 'SEARCH'");
  await addColumn('trips', 'destination_latitude', 'DECIMAL(10,7) NULL');
  await addColumn('trips', 'destination_longitude', 'DECIMAL(10,7) NULL');
  await addColumn('trips', 'route_json', 'LONGTEXT NULL');
  await addColumn('trips', 'route_distance_m', 'INT NULL');
  await addColumn('trips', 'route_duration_s', 'INT NULL');
  await addColumn('trips', 'route_provider', "VARCHAR(40) NULL DEFAULT 'OSRM'");
  await addColumn('trips', 'mode', "ENUM('REAL','DEMO') NULL DEFAULT 'REAL'");
  await addColumn('trips', 'current_accuracy_m', 'DECIMAL(8,2) NULL');
  await addColumn('trips', 'current_speed_mps', 'DECIMAL(8,2) NULL');
  await addColumn('trips', 'current_heading_deg', 'DECIMAL(8,2) NULL');
  await addColumn('trips', 'current_route_offset_m', 'INT DEFAULT 0');
  await addColumn('trips', 'off_route_distance_m', 'INT DEFAULT 0');
  await addColumn('trips', 'alerts_paused', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('trips', 'police_alert_requested_at', 'DATETIME NULL');
  await addColumn('trips', 'completed_at', 'DATETIME NULL');

  await addColumn('trip_junctions', 'route_index', 'INT NOT NULL DEFAULT 0');
  await addColumn('trip_junctions', 'route_offset_m', 'INT NOT NULL DEFAULT 0');

  await pool.query(`CREATE TABLE IF NOT EXISTS trip_telemetry (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    trip_id INT NOT NULL,
    latitude DECIMAL(10,7) NOT NULL,
    longitude DECIMAL(10,7) NOT NULL,
    accuracy_m DECIMAL(8,2) NULL,
    speed_mps DECIMAL(8,2) NULL,
    heading_deg DECIMAL(8,2) NULL,
    route_offset_m INT NULL,
    off_route_distance_m INT DEFAULT 0,
    alerts_paused TINYINT(1) NOT NULL DEFAULT 0,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_trip_telemetry_trip_time (trip_id, recorded_at),
    FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE CASCADE
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS traffic_reports (
    id INT PRIMARY KEY AUTO_INCREMENT,
    junction_id INT NOT NULL,
    level ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'LOW',
    note VARCHAR(255) NULL,
    updated_by INT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_traffic_junction (junction_id),
    FOREIGN KEY (junction_id) REFERENCES junctions(id),
    FOREIGN KEY (updated_by) REFERENCES users(id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS police_duty_sessions (
    id INT PRIMARY KEY AUTO_INCREMENT,
    officer_user_id INT NOT NULL,
    post_name VARCHAR(120) NOT NULL,
    latitude DECIMAL(10,7) NOT NULL,
    longitude DECIMAL(10,7) NOT NULL,
    radius_m INT NOT NULL DEFAULT 500,
    status ENUM('ACTIVE','ENDED') NOT NULL DEFAULT 'ACTIVE',
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME NULL,
    INDEX idx_duty_active (status, officer_user_id),
    FOREIGN KEY (officer_user_id) REFERENCES users(id)
  )`);

  await addColumn('police_alerts', 'officer_user_id', 'INT NULL');
  await addColumn('police_alerts', 'duty_session_id', 'INT NULL');
  await addColumn('police_alerts', 'alert_type', "ENUM('EARLY','CRITICAL') NOT NULL DEFAULT 'CRITICAL'");
  await addColumn('police_alerts', 'requested_by_driver', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('police_alerts', 'target_kind', "ENUM('JUNCTION','DUTY_AREA') NOT NULL DEFAULT 'JUNCTION'");
  await addColumn('police_alerts', 'target_name', 'VARCHAR(160) NULL');
  await addColumn('police_alerts', 'target_latitude', 'DECIMAL(10,7) NULL');
  await addColumn('police_alerts', 'target_longitude', 'DECIMAL(10,7) NULL');
  await addColumn('police_alerts', 'route_offset_m', 'INT NULL');
  await addColumn('police_alerts', 'distance_ahead_m', 'INT NULL');
  await addColumn('police_alerts', 'last_notified_at', 'DATETIME NULL');

  // Older builds required a smart junction for every Police alert. v6 also supports
  // route-corridor duty-area alerts, so junction_id must be nullable.
  if (await tableExists('police_alerts') && await columnExists('police_alerts', 'junction_id')) {
    await pool.query('ALTER TABLE police_alerts MODIFY COLUMN junction_id INT NULL');
  }
  if (await tableExists('police_alerts') && await columnExists('police_alerts', 'sector')) {
    await pool.query('ALTER TABLE police_alerts MODIFY COLUMN sector VARCHAR(50) NULL');
  }

  // Old active demo trips do not contain a route; close them so the new live tracker never processes invalid rows.
  if (await columnExists('trips', 'route_json')) {
    await pool.query(
      "UPDATE trips SET status='COMPLETED',completed_at=COALESCE(completed_at,NOW()) WHERE status='ACTIVE' AND (route_json IS NULL OR route_json='')",
    );
  }

  console.log('[DB] migration complete');
  await pool.end();
}

run().catch(async error => {
  console.error('[DB] migration failed', error);
  await pool.end();
  process.exit(1);
});
