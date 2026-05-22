# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

X-trafik Realtidskarta — a real-time bus tracking map for X-trafik (Gävleborg region). The backend fetches GTFS-RT protobuf data from Samtrafiken's API and enriches it with static GTFS data. The frontend renders buses on a Leaflet map with animated positions, direction arrows, and stop markers.

## Commands

### Running locally (Docker — primary workflow)
```bash
# Build and start (always --build to pick up code changes):
BUILDTIME="$(date -u '+%Y-%m-%d %H:%M UTC')" docker compose up --build -d

# Never use docker compose restart — it reuses the old image without rebuilding.

# View logs:
docker compose logs -f

# Check version endpoint after rebuild:
curl http://localhost:3000/api/version
```

### Running without Docker (development)
```bash
cd backend
npm install
node server.js   # requires .env in project root
```

### Testing GTFS loader
```bash
node backend/test-gtfs-loader.js
node backend/test-api.js
```

### Admin endpoint (requires Authorization header)
```bash
curl -H "Authorization: Bearer $ADMIN_KEY" http://localhost:3000/admin/refresh-gtfs
```

## Environment Setup

Copy `.env.example` to `.env` in the project root (not inside `backend/`):
```
API_KEY=<GTFS Regional Realtime key>       # for VehiclePositions.pb
GTFS_API_KEY=<GTFS Regional Static key>   # for xt.zip (weekly download)
ADMIN_KEY=<random hex, e.g. openssl rand -hex 32>
PORT=3000
```

The `.env` file is read from `path.resolve(__dirname, '../.env')` in both `server.js` and `gtfs-loader.js` — i.e., always from the project root, not from `backend/`.

## Architecture

### Backend (`backend/`)

**`server.js`** — Express app (port 3000). Key design points:
- `app.set('trust proxy', 1)` is required for correct IP detection behind Docker/nginx.
- **Vehicle cache** (`_cache`): 8-second TTL with in-flight deduplication. `fetchVehiclesFromSamtrafiken()` is the single fetch point; all concurrent requests wait on the same promise.
- **GTFS-RT decoding**: Samtrafiken returns protobuf binary. `transit_realtime.FeedMessage.decode(new Uint8Array(buffer))` from `gtfs-realtime-bindings`. Field names are camelCase (`tripId`, `routeId`), not snake_case.
- **Stops cache** (`_stopsCache`): `stops.txt` is parsed once on first `/api/stops` request and held in memory.
- **Version stamp**: `version.json` is written at Docker build time via `ARG BUILDTIME`. The `BUILDTIME` arg must be passed from the host to bust Docker's layer cache: `BUILDTIME="$(date -u ...)" docker compose up --build -d`.

**`gtfs-loader.js`** — Handles static GTFS data (routes, trips, stops):
- Downloads `xt.zip` from `https://opendata.samtrafiken.se/gtfs/xt/xt.zip` at most once per 7 days (50 downloads/month API limit).
- Parses `routes.txt`, `trips.txt`, `agency.txt` into in-memory maps: `routeMap` (route_id → short_name), `tripToRouteMap` (trip_id → route_id), `routeInfoMap` (route_id → full info).
- `getRouteColorFromRouteId()` returns `null` if the GTFS data has no color (`000000`), so the frontend falls back to its own `busColors` map.
- Mock data is generated automatically if API keys are missing, for local development.
- Download metadata is persisted to `backend/gtfs-metadata.json`.
- GTFS data files (`*.txt`, `*.zip`) are git-ignored; they live in `backend/gtfs-data/` which is created at Docker build time.

### Frontend (`frontend/index.html`)

Single HTML file (no build step). Key subsystems:

**Bus icon rendering**: Each icon is a `L.divIcon` with a 4-tier zoom-adaptive size (`getIconDims()`). The icon contains a colored bus body, a direction arrow (rotated SVG triangle), and a route number badge. Icons are fully recreated each fetch cycle.

**Position animation**: `animateMarker()` interpolates a marker from old to new position over 14 seconds using ease-out cubic. Uses `requestAnimationFrame`. Jumps immediately if distance > 0.005° (~500m).

**Vehicle state tracking** (`vehicleMarkers` object): Maps `vehicleId → { marker, animFrame, lat, lng, seen }`. The `seen` flag is reset each fetch; markers where `seen` stays false are removed.

**Line highlighting**: `applyHighlight(routeKey)` adds `.dimmed` class (opacity 0.15) to all markers not on the selected route. `vehicleRouteMap` maps vehicleId → routeKey. `map.on('click', clearHighlight)` clears it.

**Bus number resolution** (frontend fallback): When the backend returns `busNumber: 'Okänt'`, the frontend tries a `cmap` lookup on characters 6–10 of the 16-character vehicle ID. Lines 44 and 27 are filtered out entirely (`OUT_OF_SERVICE` set) as they represent out-of-service vehicles.

**Stop markers**: `fetchStops()` calls `/api/stops?bbox=...` and renders `L.marker` dots. Only shown at zoom ≥ 15. Refetch is skipped if bbox (rounded to 3 decimals) hasn't changed.

**Theming**: `data-theme="dark"` on `<html>` is set from localStorage/`prefers-color-scheme` immediately after `L.map()` creation, before tile layer selection (important: tile choice depends on the theme at initialization time). CartoDB dark tiles are used in dark mode.

**URL hash**: `#lat,lon,zoom` is written on every map move (1s debounce) and parsed on load to restore position. Geolocation auto-zoom is skipped if a valid hash is present.

**Color fallback**: `getBusColor(busNumber, routeColor)` uses `routeColor` only if it's non-null and not `#000000`. Otherwise falls back to the hardcoded `busColors` map keyed by line number string.

### Routing

| Path | Description |
|---|---|
| `GET /` | Serves `frontend/index.html` |
| `GET /api/vehicles?bbox=...` | Filtered real-time vehicle positions. `X-Total-Count` header = unfiltered total. |
| `GET /api/stops?bbox=...` | Stop locations within bbox (required). |
| `GET /api/version` | `{ version: "YYYY-MM-DD HH:MM UTC" }` from build-time stamp. |
| `GET /api/gtfs-status` | GTFS data health, download stats, examples. |
| `GET /status` | Serves `frontend/gtfs-status.html`. |
| `GET /admin/refresh-gtfs` | Force GTFS refresh. Requires `Authorization: Bearer <ADMIN_KEY>`. |

Rate limits: API endpoints 60 req/min per IP; admin/status endpoints 100 req/15 min.

### Docker layout

The Dockerfile context is `./backend`. Inside the container:
- Working dir: `/app`
- Frontend files: mounted as volume at `/app/frontend` (live-reload without rebuild)
- `server.js`, `gtfs-loader.js`, `node_modules/`: at `/app/`
- `version.json`: at `/app/version.json` (written by `ARG BUILDTIME` step)
- GTFS data: `/app/gtfs-data/` (created in Dockerfile, persists in container)

Because `frontend/` is a volume mount, frontend changes are live without rebuilding Docker. Backend changes require `docker compose up --build -d`.

## Key Gotchas

- **GTFS protobuf fields are camelCase** (`tripId`, not `trip_id`) after decoding with `gtfs-realtime-bindings`.
- **X-trafik GTFS has no `route_color`** — all routes return black (`000000`). The backend returns `null` for these; the frontend `busColors` map is the actual color source.
- **Static GTFS download limit**: 50 downloads/month from Samtrafiken. The 7-day cache in `gtfs-loader.js` is intentional.
- **`trust proxy`** must stay set on the Express app or `express-rate-limit` throws a `ValidationError` about `X-Forwarded-For`.
- **Samtrafiken API** for realtime: `https://opendata.samtrafiken.se/gtfs-rt/xt/VehiclePositions.pb?key=<API_KEY>`
- **Samtrafiken API** for static: `https://opendata.samtrafiken.se/gtfs/xt/xt.zip?key=<GTFS_API_KEY>`
