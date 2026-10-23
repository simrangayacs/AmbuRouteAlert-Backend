CREATE DATABASE IF NOT EXISTS amburoute CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE amburoute;
SET FOREIGN_KEY_CHECKS=0;
DROP TABLE IF EXISTS traffic_reports;
DROP TABLE IF EXISTS police_alerts;
DROP TABLE IF EXISTS trip_junctions;
DROP TABLE IF EXISTS trips;
DROP TABLE IF EXISTS hospitals;
DROP TABLE IF EXISTS junctions;
DROP TABLE IF EXISTS users;
SET FOREIGN_KEY_CHECKS=1;

CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  user_id VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  role ENUM('DRIVER','POLICE') NOT NULL,
  sector VARCHAR(50) NULL
);

CREATE TABLE hospitals (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL
);

CREATE TABLE junctions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  latitude DECIMAL(10,7) NOT NULL,
  longitude DECIMAL(10,7) NOT NULL,
  sector VARCHAR(50) NOT NULL,
  speaker_id VARCHAR(100) NOT NULL,
  route_order INT NOT NULL
);

CREATE TABLE trips (
  id INT PRIMARY KEY AUTO_INCREMENT,
  driver_user_id INT NOT NULL,
  ambulance_no VARCHAR(30) NOT NULL,
  origin_latitude DECIMAL(10,7) NOT NULL,
  origin_longitude DECIMAL(10,7) NOT NULL,
  destination_hospital_id INT NOT NULL,
  destination VARCHAR(150) NOT NULL,
  route_json LONGTEXT NOT NULL,
  route_distance_m INT NOT NULL,
  route_duration_s INT NOT NULL,
  status ENUM('ACTIVE','COMPLETED','CANCELLED') DEFAULT 'ACTIVE',
  mode ENUM('REAL','DEMO') DEFAULT 'REAL',
  current_latitude DECIMAL(10,7) NULL,
  current_longitude DECIMAL(10,7) NULL,
  current_route_offset_m INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (driver_user_id) REFERENCES users(id),
  FOREIGN KEY (destination_hospital_id) REFERENCES hospitals(id)
);

CREATE TABLE trip_junctions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  trip_id INT NOT NULL,
  junction_id INT NOT NULL,
  sequence_no INT NOT NULL,
  route_index INT NOT NULL,
  route_offset_m INT NOT NULL,
  status ENUM('UPCOMING','ACTIVE','PASSED') DEFAULT 'UPCOMING',
  activated_at DATETIME NULL,
  passed_at DATETIME NULL,
  UNIQUE KEY uq_trip_junction (trip_id, junction_id),
  FOREIGN KEY (trip_id) REFERENCES trips(id),
  FOREIGN KEY (junction_id) REFERENCES junctions(id)
);

CREATE TABLE police_alerts (
  id INT PRIMARY KEY AUTO_INCREMENT,
  trip_id INT NOT NULL,
  junction_id INT NOT NULL,
  sector VARCHAR(50) NOT NULL,
  status ENUM('ACTIVE','CLOSED') DEFAULT 'ACTIVE',
  last_action VARCHAR(40) NULL,
  acknowledged_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (trip_id) REFERENCES trips(id),
  FOREIGN KEY (junction_id) REFERENCES junctions(id)
);

CREATE TABLE traffic_reports (
  id INT PRIMARY KEY AUTO_INCREMENT,
  junction_id INT NOT NULL,
  level ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'LOW',
  note VARCHAR(255) NULL,
  updated_by INT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_traffic_junction (junction_id),
  FOREIGN KEY (junction_id) REFERENCES junctions(id),
  FOREIGN KEY (updated_by) REFERENCES users(id)
);
