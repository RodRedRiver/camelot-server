const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

const app  = express();
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());

async function setupDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id          TEXT PRIMARY KEY,
      name        TEXT,
      last_seen   TIMESTAMP DEFAULT NOW(),
      ip          TEXT,
      lat         FLOAT,
      lng         FLOAT,
      city        TEXT,
      country     TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS readings (
      id          SERIAL PRIMARY KEY,
      device_id   TEXT REFERENCES devices(id),
      timestamp   TIMESTAMP DEFAULT NOW(),
      co          FLOAT,
      co2         FLOAT,
      humidity    FLOAT,
      temp_f      FLOAT,
      pm10        FLOAT,
      pressure    FLOAT,
      nh3         FLOAT,
      ch4         FLOAT,
      h2          FLOAT,
      ethanol     FLOAT,
      no2         FLOAT,
      lux         FLOAT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS advice (
      id          SERIAL PRIMARY KEY,
      device_id   TEXT REFERENCES devices(id),
      timestamp   TIMESTAMP DEFAULT NOW(),
      message     TEXT
    )
  `);
  console.log('Database ready');
}

async function geolocate(ip) {
  try {
    if (ip === '::1' || ip === '127.0.0.1') {
      return { lat: 51.5074, lng: -0.1278, city: 'London', country: 'GB' };
    }
    const res = await axios.get(`http://ip-api.com/json/${ip}`);
    if (res.data.status === 'success') {
      return {
        lat:     res.data.lat,
        lng:     res.data.lon,
        city:    res.data.city,
        country: res.data.countryCode
      };
    }
  } catch (e) {
    console.error('Geolocation failed:', e.message);
  }
  return { lat: 0, lng: 0, city: 'Unknown', country: 'XX' };
}

async function getAdvice(data) {
  try {
    const prompt = `You are an indoor air quality advisor. Current readings: CO=${data.co}ppm, CO2=${data.co2}ppm, Humidity=${data.humidity}%, Temp=${data.temp_f}F, PM10=${data.pm10}ug/m3, Pressure=${data.pressure}hPa, NH3=${data.nh3}ppm, LUX=${data.lux}. Ideal: CO<8ppm, CO2<1000ppm, Humidity 30-65%, Temp 66-75F, PM10<25ug/m3. Give exactly 1 short actionable sentence of advice (max 12 words). Only mention sensors that are out of range. If all good say: Air quality is good, keep it up.`;

    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages:   [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type':      'application/json'
        }
      }
    );
    return res.data.content[0].text.trim();
  } catch (e) {
    console.error('Claude error:', e.message);
    return null;
  }
}

app.post('/api/readings', async (req, res) => {
  try {
    const {
      device_id = 'camelot-001',
      co, co2, humidity, temp_f, pm10,
      pressure = 1013.25,
      nh3 = 0, ch4 = 0, h2 = 0, ethanol = 0, no2 = 0, lux = 0
    } = req.body;

    const ip  = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const geo = await geolocate(ip);

    await pool.query(`
      INSERT INTO devices (id, last_seen, ip, lat, lng, city, country)
      VALUES ($1, NOW(), $2, $3, $4, $5, $6)
      ON CONFLICT (id) DO UPDATE SET
        last_seen = NOW(), ip = $2, lat = $3, lng = $4, city = $5, country = $6
    `, [device_id, ip, geo.lat, geo.lng, geo.city, geo.country]);

    await pool.query(`
      INSERT INTO readings
        (device_id, co, co2, humidity, temp_f, pm10, pressure, nh3, ch4, h2, ethanol, no2, lux)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [device_id, co, co2, humidity, temp_f, pm10, pressure, nh3, ch4, h2, ethanol, no2, lux]);

    const needsAdvice = co > 8 || co2 > 1000 || humidity < 30 || humidity > 65 || pm10 > 25;

    let adviceMsg = null;
    const lastAdvice = await pool.query(`
      SELECT timestamp FROM advice WHERE device_id = $1
      ORDER BY timestamp DESC LIMIT 1
    `, [device_id]);

    const lastAdviceTime = lastAdvice.rows[0]?.timestamp;
    const tenMinsAgo     = new Date(Date.now() - 10 * 60 * 1000);
    const shouldAdvise   = !lastAdviceTime || lastAdviceTime < tenMinsAgo;

    if (shouldAdvise && (needsAdvice || !lastAdviceTime)) {
      adviceMsg = await getAdvice(req.body);
      if (adviceMsg) {
        await pool.query(
          'INSERT INTO advice (device_id, message) VALUES ($1, $2)',
          [device_id, adviceMsg]
        );
      }
    }

    res.json({ success: true, advice: adviceMsg });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/readings/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const { limit = 100, hours = 24 } = req.query;
    const result = await pool.query(`
      SELECT * FROM readings
      WHERE device_id = $1
        AND timestamp > NOW() - INTERVAL '${parseInt(hours)} hours'
      ORDER BY timestamp DESC
      LIMIT $2
    `, [deviceId, parseInt(limit)]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/devices', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, r.co, r.co2, r.humidity, r.temp_f, r.pm10, r.timestamp as last_reading
      FROM devices d
      LEFT JOIN readings r ON r.id = (
        SELECT id FROM readings WHERE device_id = d.id
        ORDER BY timestamp DESC LIMIT 1
      )
    `);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/advice/:deviceId', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM advice WHERE device_id = $1
      ORDER BY timestamp DESC LIMIT 20
    `, [req.params.deviceId]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
setupDB().then(() => {
  app.listen(PORT, () => console.log(`Camelot server running on port ${PORT}`));
});