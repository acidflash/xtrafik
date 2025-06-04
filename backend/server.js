const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
// Importera gtfs-bindings korrekt för att säkerställa att FeedMessage är tillgängligt
const { transit_realtime } = require('gtfs-realtime-bindings');
// Importera vår egen GTFS-laddare för att få tillgång till statisk GTFS-data
const gtfsLoader = require('./gtfs-loader');
const RateLimit = require('express-rate-limit');

// Här kan du lägga till nya bussnummerfunktioner senare
// För tillfället har vi tagit bort de gamla som inte fungerade

// Ladda .env från projektets rot-katalog
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;  // Använd port 3001 som fallback istället för 3000
const API_KEY = process.env.API_KEY;

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

// API-endpoint för fordonshämtning
app.get('/api/vehicles', apiLimiter, async (req, res) => {
  try {
    if (!API_KEY) {
      throw new Error('API-nyckel saknas');
    }

    const response = await fetch(`https://opendata.samtrafiken.se/gtfs-rt/xt/VehiclePositions.pb?key=${API_KEY}`, {
      headers: {
        'Accept-Encoding': 'gzip, deflate'
      }
    });
    
    if (!response.ok) {
      console.error(`API-fel: ${response.status} ${response.statusText}`);
      
      let errorBody = 'Kunde inte läsa felmeddelande';
      try {
        errorBody = await response.text();
        console.error('API svarade med:', errorBody.substring(0, 200));
      } catch (e) {
        console.error('Kunde inte läsa svarskropp');
      }
      
      throw new Error(`Fel vid hämtning från API: ${response.status} ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    
    if (buffer.byteLength === 0) {
      throw new Error('API returnerade tom data');
    }
    
    // Avkoda GTFS-data
    const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
    
    // Skapa en enkel lista med fordon utan bussnummerlogik
    const vehicles = feed.entity
      .filter(entity => entity && entity.vehicle && entity.vehicle.position)
      .map(entity => {
        const vehicle = entity.vehicle;
        const vehicleId = vehicle.vehicle && vehicle.vehicle.id ? vehicle.vehicle.id : 'unknown';
        
        return {
          id: vehicleId,
          position: vehicle.position,
          timestamp: vehicle.timestamp,
          routeId: vehicle.trip ? vehicle.trip.route_id : null,
          trip: vehicle.trip || null,
          // Standardfärger för alla fordon
          routeColor: '#1c65b0',
          routeTextColor: '#FFFFFF'
        };
      });
    
    console.log(`Skickar ${vehicles.length} fordon till klienten`);
    res.json(vehicles);
    
  } catch (error) {
    console.error('Fel vid fordonshämtning:', error);
    res.status(500).json({
      error: 'Kunde inte hämta fordonsdata',
      message: error.message
    });
  }
});

// Manuell uppdatering av GTFS-data
app.get('/admin/refresh-gtfs', statusLimiter, async (req, res) => {
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
app.get('*', (req, res) => {
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
