const path = require('path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'fleet.db');

const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS fleet_submissions (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at             TEXT NOT NULL,
    company_name           TEXT NOT NULL,
    location               TEXT NOT NULL,
    fleet_size             TEXT NOT NULL,
    central_depot          INTEGER NOT NULL,
    land_ownership         TEXT,
    lease_remaining_years  REAL,
    strata_approval        INTEGER,
    charger_room           INTEGER,
    ops_start_hour         REAL NOT NULL,
    ops_end_hour           REAL NOT NULL,
    raw_json               TEXT NOT NULL
  )
`);

const insertStmt = db.prepare(`
  INSERT INTO fleet_submissions (
    created_at, company_name, location, fleet_size, central_depot,
    land_ownership, lease_remaining_years, strata_approval, charger_room,
    ops_start_hour, ops_end_hour, raw_json
  ) VALUES (
    @created_at, @company_name, @location, @fleet_size, @central_depot,
    @land_ownership, @lease_remaining_years, @strata_approval, @charger_room,
    @ops_start_hour, @ops_end_hour, @raw_json
  )
`);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/Images', express.static(path.join(__dirname, 'Images')));

function toBit(v) {
  if (v === null || v === undefined) return null;
  return v ? 1 : 0;
}

app.post('/api/submit', (req, res) => {
  const body = req.body || {};
  const { companyName, location, fleetSize, centralDepot, opsStartHour, opsEndHour } = body;

  const missing = [];
  if (!companyName) missing.push('companyName');
  if (!location) missing.push('location');
  if (!fleetSize) missing.push('fleetSize');
  if (typeof centralDepot !== 'boolean') missing.push('centralDepot');
  if (typeof opsStartHour !== 'number') missing.push('opsStartHour');
  if (typeof opsEndHour !== 'number') missing.push('opsEndHour');
  if (missing.length) {
    return res.status(400).json({ error: 'Missing or invalid fields', fields: missing });
  }

  const row = {
    created_at: new Date().toISOString(),
    company_name: String(companyName),
    location: String(location),
    fleet_size: String(fleetSize),
    central_depot: toBit(centralDepot),
    land_ownership: body.landOwnership || null,
    lease_remaining_years: typeof body.leaseRemainingYears === 'number' ? body.leaseRemainingYears : null,
    strata_approval: toBit(body.strataApproval),
    charger_room: toBit(body.chargerRoom),
    ops_start_hour: opsStartHour,
    ops_end_hour: opsEndHour,
    raw_json: JSON.stringify(body),
  };

  try {
    const info = insertStmt.run(row);
    res.status(201).json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error('Insert failed:', err);
    res.status(500).json({ error: 'Database insert failed' });
  }
});

app.get('/api/submissions', (req, res) => {
  const rows = db.prepare('SELECT * FROM fleet_submissions ORDER BY id DESC LIMIT 100').all();
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`Fuse V2G fleet wizard running at http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});
