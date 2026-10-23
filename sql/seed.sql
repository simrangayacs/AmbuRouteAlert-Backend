USE amburoute;
INSERT INTO users (user_id,password,name,role,sector) VALUES
('DRV001','1234','Demo Ambulance Driver','DRIVER',NULL),
('POL001','1234','Station Chowk Traffic Officer','POLICE','SECTOR-A'),
('POL002','1234','GB Road Traffic Officer','POLICE','SECTOR-B')
ON DUPLICATE KEY UPDATE name=VALUES(name);

INSERT INTO hospitals (id,name,latitude,longitude) VALUES
(1,'ANMMCH Hospital Gate',24.7490000,84.9685000),
(2,'Gaya District Hospital',24.7916000,85.0009000)
ON DUPLICATE KEY UPDATE name=VALUES(name),latitude=VALUES(latitude),longitude=VALUES(longitude);

-- Hackathon demo corridor around Gaya. Verify/adjust coordinates before real deployment.
INSERT INTO junctions (id,name,latitude,longitude,sector,speaker_id,route_order) VALUES
(1,'Gaya Junction / Station Chowk',24.7969000,85.0074000,'SECTOR-A','speaker-001',1),
(2,'GB Road Crossing / Clock Tower',24.7930000,85.0020000,'SECTOR-B','speaker-002',2),
(3,'Sherghati Road Signal',24.7800000,84.9915000,'SECTOR-C','speaker-003',3),
(4,'ANMMCH Hospital Gate',24.7490000,84.9685000,'SECTOR-D','speaker-004',4)
ON DUPLICATE KEY UPDATE name=VALUES(name),latitude=VALUES(latitude),longitude=VALUES(longitude),sector=VALUES(sector),speaker_id=VALUES(speaker_id),route_order=VALUES(route_order);

INSERT INTO traffic_reports (junction_id,level,note) VALUES
(1,'MEDIUM','Normal city traffic'),(2,'HIGH','Demo congestion'),(3,'LOW','Clear'),(4,'LOW','Hospital approach clear')
ON DUPLICATE KEY UPDATE level=VALUES(level),note=VALUES(note);
