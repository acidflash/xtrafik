const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
// Importera gtfs-bindings korrekt för att säkerställa att FeedMessage är tillgängligt
const { transit_realtime } = require('gtfs-realtime-bindings');
// Importera vår egen GTFS-laddare för att få tillgång till statisk GTFS-data
const gtfsLoader = require('./gtfs-loader');
const trafikverket = require('./trafikverket');
const RateLimit = require('express-rate-limit');

// Här kan du lägga till nya bussnummerfunktioner senare
// För tillfället har vi tagit bort de gamla som inte fungerade

// Ladda .env från projektets rot-katalog
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
app.set('trust proxy', 1); // Lita på proxy (Docker/nginx) för korrekt IP-identifiering
const PORT = process.env.PORT || 3000;  // Använd port 3000
const API_KEY = process.env.API_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;

// Kontrollera och logga API-nyckeln
if (API_KEY) {
  const firstChars = API_KEY.substring(0, 4);
  const lastChars = API_KEY.substring(API_KEY.length - 4);
  console.log(`API-nyckel laddad. Börjar med: ${firstChars}, slutar med: ${lastChars}, längd: ${API_KEY.length}`);
} else {
  console.error('ALLVARLIGT FEL: API_KEY är inte definierad. Kontrollera din .env-fil i projektets rotkatalog.');
  console.error('Servern kommer att starta men API-anrop kommer att misslyckas.');
  // Vi fortsätter köra för att tillåta lokal utveckling, men varnar tydligt
}

if (!ADMIN_KEY) {
  console.warn('VARNING: ADMIN_KEY är inte satt. /admin/refresh-gtfs kommer att vara otillgänglig.');
}

// Middleware som skyddar admin-endpoints med nyckel från Authorization-headern
function requireAdminKey(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).json({ error: 'Admin-nyckel är inte konfigurerad på servern' });
  }
  const provided = req.headers['authorization'];
  if (!provided || provided !== `Bearer ${ADMIN_KEY}`) {
    console.warn(`Obehörigt försök att nå admin-endpoint från ${req.ip}`);
    return res.status(401).json({ error: 'Ogiltig eller saknad Authorization-header' });
  }
  next();
}

// Statisk filhantering - Försök med både Docker-sökväg och relativ sökväg
const FRONTEND_PATHS = [
  '/app/frontend',                             // Docker-sökväg
  path.resolve(__dirname, '../frontend'),      // Relativ sökväg från backend-katalogen
];

// Konfigurera statisk filservering för alla möjliga sökvägar
FRONTEND_PATHS.forEach(frontendPath => {
  if (fs.existsSync(frontendPath)) {
    console.log(`Serverar statiska filer från: ${frontendPath}`);
    app.use(express.static(frontendPath));
  }
});

// CORS-stöd för utvecklingsmiljö
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Rate limiter för API-endpoints
const apiLimiter = RateLimit({
  windowMs: 1 * 60 * 1000, // 1 minut
  max: 60, // max 60 requests per minut
  message: { error: 'För många förfrågningar, försök igen senare' }
});

// Route till admin-sidan för att se status för GTFS-data
const statusLimiter = RateLimit({
  windowMs: 15 * 60 * 1000, // 15 minuter
  max: 100, // begränsa varje IP till 100 förfrågningar per 15 minuter
});
app.get('/status', statusLimiter, (req, res) => {
  // Försök hitta status-filen i alla möjliga sökvägar
  for (const frontendPath of FRONTEND_PATHS) {
    const statusPath = path.join(frontendPath, 'gtfs-status.html');
    if (fs.existsSync(statusPath)) {
      return res.sendFile(statusPath);
    }
  }
  res.status(404).send('Status-sidan kunde inte hittas');
});

// API för att kontrollera GTFS-data status
app.get('/api/gtfs-status', apiLimiter, (req, res) => {
  try {
    const routeMap = gtfsLoader.getRouteMap();
    const tripMap = gtfsLoader.getTripMap();
    const blockMap = gtfsLoader.getBlockMap();
    
    // Hämta metadata för nedladdningsinformation
    let metadata = { error: "Kunde inte läsa metadata" };
    try {
      const METADATA_FILE = path.resolve(__dirname, 'gtfs-metadata.json');
      if (fs.existsSync(METADATA_FILE)) {
        metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
      }
    } catch (metadataError) {
      console.error('Fel vid läsning av metadata:', metadataError);
    }
    
    const status = {
      loaded: Object.keys(routeMap).length > 0,
      stats: {
        routes: Object.keys(routeMap).length,
        trips: Object.keys(tripMap).length,
        blocks: Object.keys(blockMap).length
      },
      examples: {
        routes: Object.keys(routeMap).slice(0, 5).map(id => ({ 
          id, 
          busNumber: routeMap[id],
          color: gtfsLoader.getRouteColorFromRouteId(id),
          textColor: gtfsLoader.getRouteTextColorFromRouteId(id),
          longName: gtfsLoader.getRouteLongNameFromRouteId(id)
        }))
      },
      downloadMetadata: metadata,
      usingMockData: gtfsLoader.isUsingMockData()
    };
    
    res.json(status);
  } catch (error) {
    console.error('Fel vid hämtning av GTFS-status:', error);
    res.status(500).json({ 
      error: 'Kunde inte hämta GTFS-status', 
      message: error.message 
    });
  }
});

// ── Hållplats-data (parsas en gång vid uppstart) ─────────────────
let _stopsCache = null;

function getStops() {
  if (_stopsCache) return _stopsCache;
  const stopsPath = path.resolve(__dirname, 'gtfs-data', 'stops.txt');
  if (!fs.existsSync(stopsPath)) return [];
  const lines = fs.readFileSync(stopsPath, 'utf8').split('\n');
  const header = lines[0].split(',');
  const iId   = header.indexOf('stop_id');
  const iName = header.indexOf('stop_name');
  const iLat  = header.indexOf('stop_lat');
  const iLon  = header.indexOf('stop_lon');
  const iType = header.indexOf('location_type');
  const stops = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 4) continue;
    const locType = parts[iType] ? parseInt(parts[iType]) : 0;
    if (locType !== 0) continue; // Bara plattformar/hållplatslägen
    const lat = parseFloat(parts[iLat]);
    const lon = parseFloat(parts[iLon]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    stops.push({ id: parts[iId], name: parts[iName]?.trim(), lat, lon });
  }
  console.log(`Hållplatser laddade: ${stops.length} st`);
  _stopsCache = stops;
  return stops;
}

// API för hållplatser inom en bounding box (kräver ?bbox=minLat,minLon,maxLat,maxLon)
app.get('/api/stops', apiLimiter, (req, res) => {
  const { bbox } = req.query;
  if (!bbox) return res.status(400).json({ error: 'bbox krävs' });
  const parts = bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some(n => !isFinite(n))) {
    return res.status(400).json({ error: 'Ogiltig bbox' });
  }
  const [minLat, minLon, maxLat, maxLon] = parts;
  const stops = getStops();
  const result = stops.filter(s =>
    s.lat >= minLat && s.lat <= maxLat &&
    s.lon >= minLon && s.lon <= maxLon
  );
  res.json(result);
});

// ── Tåg-API (Trafikverket-interpolerade positioner) ──────────────
app.get('/api/trains', apiLimiter, async (req, res) => {
  try {
    const { bbox } = req.query;
    let bboxFilter = null;
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every(n => isFinite(n))) {
        const [minLat, minLon, maxLat, maxLon] = parts;
        if (minLat < maxLat && minLon < maxLon) bboxFilter = { minLat, minLon, maxLat, maxLon };
      }
    }

    const trains = await trafikverket.fetchTrainPositions();
    const result = bboxFilter
      ? trains.filter(t =>
          t.position.latitude  >= bboxFilter.minLat && t.position.latitude  <= bboxFilter.maxLat &&
          t.position.longitude >= bboxFilter.minLon && t.position.longitude <= bboxFilter.maxLon
        )
      : trains;

    res.set('X-Total-Count', String(trains.length));
    res.json(result);
  } catch (err) {
    console.error('Tåg-fel:', err.message);
    res.json([]);
  }
});

// ── Cache för Samtrafikens GTFS-RT (minskar externa API-anrop) ───
const CACHE_TTL = 8000; // 8 sekunder
let _cache = { vehicles: null, timestamp: 0, inflight: null };

async function fetchVehiclesFromSamtrafiken() {
  const now = Date.now();

  // Returnera cache om den är giltig
  if (_cache.vehicles && (now - _cache.timestamp) < CACHE_TTL) {
    return _cache.vehicles;
  }

  // Vänta på pågående anrop istället för att starta ett nytt
  if (_cache.inflight) return _cache.inflight;

  _cache.inflight = (async () => {
    const response = await fetch(
      `https://opendata.samtrafiken.se/gtfs-rt/xt/VehiclePositions.pb?key=${API_KEY}`,
      { headers: { 'Accept-Encoding': 'gzip, deflate' } }
    );

    if (!response.ok) {
      let errorBody = '';
      try { errorBody = await response.text(); } catch (_) {}
      console.error(`API-fel: ${response.status} ${response.statusText}`, errorBody.substring(0, 200));
      throw new Error(`Fel vid hämtning från API: ${response.status} ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) throw new Error('API returnerade tom data');

    const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));

    const vehicles = feed.entity
      .filter(entity => entity && entity.vehicle && entity.vehicle.position)
      .map(entity => {
        const vehicle = entity.vehicle;
        const vehicleId = vehicle.vehicle && vehicle.vehicle.id ? vehicle.vehicle.id : 'unknown';
        const routeId = vehicle.trip ? (vehicle.trip.routeId || vehicle.trip.route_id || null) : null;
        const tripId  = vehicle.trip ? (vehicle.trip.tripId  || vehicle.trip.trip_id  || null) : null;

        let busNumber = null;
        let resolvedRouteId = routeId;
        if (routeId) busNumber = gtfsLoader.getBusNumberFromRouteId(routeId);
        if (!busNumber && tripId) {
          busNumber = gtfsLoader.getBusNumberFromTripId(tripId);
          if (!resolvedRouteId) {
            resolvedRouteId = gtfsLoader.getTripMap()[tripId] || null;
          }
        }

        return {
          id: vehicleId,
          vehicle: { id: vehicleId },
          position: vehicle.position,
          timestamp: vehicle.timestamp,
          routeId,
          trip: vehicle.trip || null,
          busNumber: busNumber || 'Okänt',
          headsign:       tripId ? (gtfsLoader.getTripHeadsignFromTripId(tripId) || null) : null,
          routeColor:     resolvedRouteId ? (gtfsLoader.getRouteColorFromRouteId(resolvedRouteId) || null) : null,
          routeTextColor: resolvedRouteId ? gtfsLoader.getRouteTextColorFromRouteId(resolvedRouteId) : '#FFFFFF',
          routeLongName:  resolvedRouteId ? gtfsLoader.getRouteLongNameFromRouteId(resolvedRouteId)  : null,
          routeInfo:      resolvedRouteId ? gtfsLoader.getRouteInfoFromRouteId(resolvedRouteId)      : null,
        };
      });

    _cache = { vehicles, timestamp: Date.now(), inflight: null };
    console.log(`Samtrafiken: hämtade ${vehicles.length} fordon (cachas ${CACHE_TTL / 1000} s)`);
    return vehicles;
  })();

  _cache.inflight.catch(() => { _cache.inflight = null; });
  return _cache.inflight;
}

// ── Version-endpoint ──────────────────────────────────────────────
app.get('/api/version', (req, res) => {
  try {
    const versionFile = path.resolve(__dirname, 'version.json');
    if (fs.existsSync(versionFile)) {
      res.json(JSON.parse(fs.readFileSync(versionFile, 'utf8')));
    } else {
      res.json({ version: 'dev' });
    }
  } catch (_) {
    res.json({ version: 'unknown' });
  }
});

// API-endpoint för turtabell (hållplatslista) för ett specifikt trip_id
app.get('/api/stoptimes', apiLimiter, (req, res) => {
  const { tripId } = req.query;
  if (!tripId) return res.status(400).json({ error: 'tripId krävs' });

  if (!gtfsLoader.isStopTimesLoaded()) {
    return res.status(503).json({ error: 'Turtabeller laddas fortfarande, försök igen om några sekunder' });
  }

  const stops = gtfsLoader.getStopTimesForTrip(tripId);
  if (!stops) return res.status(404).json({ error: 'Ingen turtabell hittades för detta trip_id' });

  res.json(stops);
});

// API-endpoint för ruttform (polyline) för ett specifikt trip_id
app.get('/api/shape', apiLimiter, (req, res) => {
  const { tripId } = req.query;
  if (!tripId) return res.status(400).json({ error: 'tripId krävs' });

  if (!gtfsLoader.isShapesLoaded()) {
    return res.status(503).json({ error: 'Ruttdata laddas fortfarande, försök igen om några sekunder' });
  }

  const shape = gtfsLoader.getShapeForTrip(tripId);
  if (!shape) return res.status(404).json({ error: 'Ingen ruttform hittades för detta trip_id' });

  res.json(shape);
});

// API-endpoint för turtabell för ett specifikt tåg (via Trafikverket TrainAnnouncement)
app.get('/api/traintimes', apiLimiter, async (req, res) => {
  const { trainId } = req.query;
  if (!trainId) return res.status(400).json({ error: 'trainId krävs' });
  // Validera: tågnummer är alltid numeriska (1–6 siffror)
  if (!/^\d{1,6}$/.test(trainId)) return res.status(400).json({ error: 'Ogiltigt trainId' });

  try {
    const stops = await trafikverket.fetchTrainStopTimes(trainId);
    if (!stops || stops.length === 0) {
      return res.status(404).json({ error: 'Ingen turtabell hittades för detta tåg' });
    }
    res.json(stops);
  } catch (e) {
    console.error('traintimes-fel:', e.message);
    res.status(500).json({ error: 'Kunde inte hämta turtabell' });
  }
});

// API-endpoint för fordonshämtning
app.get('/api/vehicles', apiLimiter, async (req, res) => {
  try {
    if (!API_KEY) {
      throw new Error('API-nyckel saknas');
    }

    // Valfritt bounding-box-filter: ?bbox=minLat,minLon,maxLat,maxLon
    const { bbox } = req.query;
    let bboxFilter = null;
    if (bbox) {
      const parts = bbox.split(',').map(Number);
      if (parts.length === 4 && parts.every(n => isFinite(n))) {
        const [minLat, minLon, maxLat, maxLon] = parts;
        if (minLat < maxLat && minLon < maxLon) {
          bboxFilter = { minLat, minLon, maxLat, maxLon };
        }
      }
    }

    const vehicles = await fetchVehiclesFromSamtrafiken();

    // Filtrera på bounding box om angiven
    const result = bboxFilter
      ? vehicles.filter(v => {
          const { latitude: lat, longitude: lon } = v.position;
          return lat >= bboxFilter.minLat && lat <= bboxFilter.maxLat &&
                 lon >= bboxFilter.minLon && lon <= bboxFilter.maxLon;
        })
      : vehicles;

    console.log(`Skickar ${result.length}${bboxFilter ? `/${vehicles.length}` : ''} fordon (cache ${Date.now() - _cache.timestamp} ms gammal)`);
    // Skicka totalt antal i header så frontend kan visa "X av Y"
    res.set('X-Total-Count', String(vehicles.length));
    res.json(result);
    
  } catch (error) {
    console.error('Fel vid fordonshämtning:', error);
    res.status(500).json({
      error: 'Kunde inte hämta fordonsdata',
      message: error.message
    });
  }
});

// Manuell uppdatering av GTFS-data
app.get('/admin/refresh-gtfs', requireAdminKey, statusLimiter, async (req, res) => {
  try {
    console.log('Manuell uppdatering av GTFS-data begärd');
    const success = await gtfsLoader.refreshGtfsData();
    
    if (success) {
      res.json({ 
        status: 'success', 
        message: 'GTFS-data uppdaterad'
      });
    } else {
      res.status(500).json({ 
        status: 'error', 
        message: 'Kunde inte uppdatera GTFS-data'
      });
    }
  } catch (error) {
    console.error('Fel vid manuell uppdatering av GTFS-data:', error);
    res.status(500).json({ 
      status: 'error', 
      message: error.message
    });
  }
});

// "Catch-all" rutt för att hantera SPA-routing (om tillämpligt)
const catchAllLimiter = RateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // max 50 requests per windowMs
});

app.get('*', catchAllLimiter, (req, res) => {
  // Kontrollera om begäran är för en API-endpoint
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint hittades inte' });
  }
  
  // För frontend-routes, skicka index.html
  for (const frontendPath of FRONTEND_PATHS) {
    const indexPath = path.join(frontendPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
  }
  
  res.status(404).send('Sidan kunde inte hittas');
});

// Ladda GTFS-data och starta servern
(async function initServer() {
  try {
    console.log('Initialiserar server och laddar GTFS-data...');
    
    // Ladda statisk GTFS-data
    const gtfsLoaded = await gtfsLoader.loadGtfsData();

    // Förinitiera tågstationer från Trafikverket (icke-blockerande)
    trafikverket.initStations().catch(e =>
      console.warn('Trafikverket stations-init misslyckades:', e.message)
    );
    
    if (gtfsLoaded) {
      console.log('GTFS-data laddad framgångsrikt!');
      
      // Logga viss statistik
      const routeMap = gtfsLoader.getRouteMap();
      const tripMap = gtfsLoader.getTripMap();
      console.log(`GTFS-statistik: ${Object.keys(routeMap).length} rutter, ${Object.keys(tripMap).length} trips`);
    } else {
      console.warn('GTFS-data kunde inte laddas helt. Servern kommer att fungera med begränsad linjenummerfunktionalitet.');
    }
    
    // Starta servern
    app.listen(PORT, () => {
      console.log(`Servern körs på port ${PORT}`);
      console.log(`- Admin status: http://localhost:${PORT}/status`);
      console.log(`- GTFS status API: http://localhost:${PORT}/api/gtfs-status`);
      console.log(`- Fordon API: http://localhost:${PORT}/api/vehicles`);
    });
  } catch (error) {
    console.error('Allvarligt fel vid initialisering av servern:', error);
    process.exit(1);
  }
})();
