# camelot-server

REST backend for Camelot, an air-quality monitoring system. It ingests sensor
readings from BLE-connected devices, stores them in PostgreSQL, and serves
per-device history and generated advice.

## Stack

Node.js, Express 5, PostgreSQL (`pg`), Axios, dotenv.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/readings` | Ingest a reading (CO, CO2, NO2, NH3, CH4, H2, PM10, humidity, pressure, temperature, light, ethanol) and geolocate the device by IP |
| GET | `/api/readings/:deviceId` | Reading history for a device |
| GET | `/api/devices` | Known devices with last-seen time and location |
| GET | `/api/advice/:deviceId` | Generated advice for a device |

Tables (`devices`, `readings`, `advice`) are created on startup.

## Running

```sh
npm install
cp .env.example .env   # set DATABASE_URL and ANTHROPIC_API_KEY
node index.js
```
