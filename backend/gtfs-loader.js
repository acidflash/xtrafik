const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const extract = require('extract-zip');
const csv = require('csv-parser');
const dotenv = require('dotenv');

// Ladda miljövariabler
dotenv.config({ path: path.resolve(__dirname, '../.env') });
const GTFS_API_KEY = process.env.GTFS_API_KEY || process.env.API_KEY; // Använd GTFS-specifik nyckel eller fallback till den vanliga API-nyckeln

// Sökvägar för nedladdade och extraherade filer
const GTFS_ZIP_PATH = path.resolve(__dirname, 'gtfs-data.zip');
const GTFS_EXTRACT_PATH = path.resolve(__dirname, 'gtfs-data');
const ROUTES_PATH = path.join(GTFS_EXTRACT_PATH, 'routes.txt');
const TRIPS_PATH = path.join(GTFS_EXTRACT_PATH, 'trips.txt');

// För att lagra route-mappning
let routeMap = {}; // route_id -> route_short_name
let routeInfoMap = {}; // route_id -> full route info (namn, färger, etc)
let tripToRouteMap = {}; // trip_id -> route_id
let blockToRouteMap = {}; // block_id -> route_id

// Tid för senaste uppdatering och uppdateringsintervall (7 dagar i millisekunder)
let lastUpdateTime = 0;
const UPDATE_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 dagar
const METADATA_FILE = path.resolve(__dirname, 'gtfs-metadata.json');

// Variabel för att hålla timer för automatisk uppdatering
let refreshTimer = null;

// Flag för att indikera om vi använder testdata
let usingMockData = false;

// Konstant för att aktivera/inaktivera användning av mock-data om API misslyckas
const USE_MOCK_DATA_ON_FAILURE = true;

/**
 * Läs in metadata om senaste nedladdning
 */
function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
      lastUpdateTime = metadata.lastUpdateTime || 0;
      const downloadCount = metadata.downloadCount || 0;
      const nextUpdate = new Date(lastUpdateTime + UPDATE_INTERVAL);
      const isMockData = metadata.mockData || false;
      
      // Uppdatera global usingMockData-flagg
      usingMockData = isMockData;
      
      console.log('=== GTFS API STATUS ===');
      if (isMockData) {
        console.log('ANVÄNDER SIMULERAD TEST-DATA (ingen API-nyckel tillgänglig)');
      }
      console.log(`Senaste uppdatering: ${new Date(lastUpdateTime).toLocaleString()}`);
      console.log(`API-anrop hittills: ${downloadCount} (max 50/månad)`);
      console.log(`Nästa schemalagda uppdatering: ${nextUpdate.toLocaleString()} (${getDaysUntilNextUpdate(nextUpdate)} dagar kvar)`);
      if (isMockData) {
        console.log('OBS: Testdata används för utveckling och testning.');
        console.log('För produktionsdata, se till att ha en giltig API-nyckel.');
      }
      console.log('======================');
      
      return true;
    } else {
      console.log('Ingen tidigare GTFS-metadata hittad. Första nedladdningen kommer att ske nu.');
    }
  } catch (error) {
    console.error('Kunde inte läsa metadata:', error.message);
  }
  return false;
}

/**
 * Hjälpfunktion för att beräkna dagar till nästa uppdatering
 */
function getDaysUntilNextUpdate(nextUpdateDate) {
  const now = new Date();
  const diffTime = nextUpdateDate.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays > 0 ? diffDays : 0;
}

/**
 * Spara metadata om senaste nedladdning
 */
function saveMetadata() {
  try {
    // Läs tidigare nedladdningsräknare utan att ändra lastUpdateTime
    let downloadCount = 1;
    if (fs.existsSync(METADATA_FILE)) {
      const previousMetadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
      downloadCount = (previousMetadata.downloadCount || 0) + 1;
    }
    
    const metadata = {
      lastUpdateTime,
      downloadCount,
      lastDownload: new Date().toISOString(),
      monthlyLimit: 50, // Maxantal API-anrop per månad
      nextScheduledUpdate: new Date(lastUpdateTime + UPDATE_INTERVAL).toISOString()
    };
    
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
    
    console.log(`GTFS API-användning: Nedladdning #${metadata.downloadCount} (max 50/månad), nästa uppdatering ${new Date(lastUpdateTime + UPDATE_INTERVAL).toLocaleDateString()}`);
    return true;
  } catch (error) {
    console.error('Kunde inte spara metadata:', error.message);
    return false;
  }
}

/**
 * Hämtar GTFS-zip-filen från Samtrafiken API
 */
async function downloadGtfsData() {
  // Kontrollera om vi redan har nedladdade data och om de är tillräckligt aktuella
  const currentTime = Date.now();
  const weeksSinceUpdate = (currentTime - lastUpdateTime) / (7 * 24 * 60 * 60 * 1000);
  const daysLeft = 7 - Math.floor(weeksSinceUpdate * 7);
  
  console.log(`Det har gått ${weeksSinceUpdate.toFixed(1)} veckor sedan senaste GTFS-uppdateringen.`);
  
  // Läs tidigare nedladdningsstatistik för att visa i loggen
  let downloadCount = 0;
  if (fs.existsSync(METADATA_FILE)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
      downloadCount = metadata.downloadCount || 0;
    } catch (err) {
      console.warn('Kunde inte läsa nedladdningsstatistik:', err.message);
    }
  }
  
  if (lastUpdateTime > 0 && weeksSinceUpdate < 1 && fs.existsSync(GTFS_ZIP_PATH)) {
    console.log(`GTFS-data är mindre än en vecka gammal (${daysLeft} dagar kvar till nästa uppdatering).`);
    console.log(`Använder cached version för att spara API-anrop (hittills använt ${downloadCount} av 50 tillåtna per månad).`);
    return true;
  }
  
  console.log(`Hämtar GTFS-statiska data från Samtrafiken (API-användning: ${downloadCount}/50 per månad)...`);
  
  try {
    // Kontrollera att API-nyckeln är tillgänglig
    if (!GTFS_API_KEY) {
      console.error('GTFS API-nyckel saknas. Kontrollera din .env-fil och se till att GTFS_API_KEY är korrekt inställd.');
      return false;
    }
    
    const response = await fetch(`https://opendata.samtrafiken.se/gtfs/xt/xt.zip?key=${GTFS_API_KEY}`);
    
    if (!response.ok) {
      if (response.status === 403) {
        console.error(`API-åtkomst nekad (403 Forbidden). Kontrollera att din GTFS API-nyckel är giltig och har tillräckliga behörigheter.`);
        console.error(`GTFS API-nyckel som användes: ${GTFS_API_KEY.substring(0, 4)}...${GTFS_API_KEY.substring(GTFS_API_KEY.length - 4)}`);
      } else {
        console.error(`API svarade med statuskod ${response.status}: ${response.statusText}`);
      }
      
      // Försök läsa eventuellt felmeddelande från API:et
      try {
        const errorText = await response.text();
        console.error('API-svar:', errorText.substring(0, 500));
      } catch (e) {
        // Kunde inte läsa svarstext
      }
      
      throw new Error(`API svarade med statuskod: ${response.status}`);
    }
    
    const buffer = await response.buffer();
    fs.writeFileSync(GTFS_ZIP_PATH, buffer);
    
    // Uppdatera timestamp och spara metadata
    lastUpdateTime = currentTime;
    saveMetadata();
    
    console.log(`GTFS-data hämtad och sparad till ${GTFS_ZIP_PATH}`);
    return true;
  } catch (error) {
    console.error('Fel vid nedladdning av GTFS-data:', error);
    return false;
  }
}

/**
 * Extraherar den nedladdade zip-filen
 */
async function extractGtfsData() {
  console.log(`Extraherar GTFS-data till ${GTFS_EXTRACT_PATH}...`);
  
  try {
    // Skapa målkatalog om den inte finns
    if (!fs.existsSync(GTFS_EXTRACT_PATH)) {
      fs.mkdirSync(GTFS_EXTRACT_PATH, { recursive: true });
    }
    
    await extract(GTFS_ZIP_PATH, { dir: GTFS_EXTRACT_PATH });
    console.log('GTFS-data extraherad!');
    return true;
  } catch (error) {
    console.error('Fel vid extrahering av GTFS-data:', error);
    return false;
  }
}

/**
 * Parse routes.txt för att bygga upp route-mappning
 */
function parseRoutesData() {
  return new Promise((resolve, reject) => {
    console.log('Parsning av routes.txt...');
    
    const shortNameResults = {};
    const infoResults = {};
    
    fs.createReadStream(path.join(GTFS_EXTRACT_PATH, 'routes.txt'))
      .pipe(csv())
      .on('data', (data) => {
        // Lagra route_id -> route_short_name
        const routeId = data.route_id;
        const routeShortName = data.route_short_name;
        
        if (routeId && routeShortName) {
          // Spara grundläggande mappning för snabb uppslagning
          shortNameResults[routeId] = routeShortName;
          
          // Spara också detaljerad information för mer avancerad användning
          infoResults[routeId] = {
            shortName: routeShortName,
            longName: data.route_long_name || '',
            agency: data.agency_id || '',
            type: parseInt(data.route_type) || 3, // 3 = buss som standard
            color: data.route_color || '000000', // Svart som standard
            textColor: data.route_text_color || 'FFFFFF', // Vit som standard
          };
        }
      })
      .on('end', () => {
        console.log(`${Object.keys(shortNameResults).length} rutter lästes in`);
        routeMap = shortNameResults;
        routeInfoMap = infoResults;
        resolve({ shortNameResults, infoResults });
      })
      .on('error', (error) => {
        console.error('Fel vid parsning av routes.txt:', error);
        reject(error);
      });
  });
}

/**
 * Parse trips.txt för att bygga upp en mappning från trip_id till route_id
 */
function parseTripsData() {
  return new Promise((resolve, reject) => {
    console.log('Parsning av trips.txt...');
    
    const results = {};
    const blockResults = {};
    
    fs.createReadStream(path.join(GTFS_EXTRACT_PATH, 'trips.txt'))
      .pipe(csv())
      .on('data', (data) => {
        // Lagra trip_id -> route_id
        const tripId = data.trip_id;
        const routeId = data.route_id;
        const blockId = data.block_id;
        
        if (tripId && routeId) {
          results[tripId] = routeId;
        }
        
        // Om block_id finns, koppla den till route_id
        if (blockId && routeId) {
          blockResults[blockId] = routeId;
        }
      })
      .on('end', () => {
        console.log(`${Object.keys(results).length} resor lästes in`);
        console.log(`${Object.keys(blockResults).length} block-IDs lästes in`);
        tripToRouteMap = results;
        blockToRouteMap = blockResults;
        resolve({ trips: results, blocks: blockResults });
      })
      .on('error', (error) => {
        console.error('Fel vid parsning av trips.txt:', error);
        reject(error);
      });
  });
}

/**
 * Returnerar bussnummer baserat på route_id
 */
function getBusNumberFromRouteId(routeId) {
  return routeMap[routeId] || null;
}

/**
 * Returnerar detaljerad ruttinformation baserat på route_id
 */
function getRouteInfoFromRouteId(routeId) {
  return routeInfoMap[routeId] || null;
}

/**
 * Returnerar färgkod för en rutt baserat på route_id
 * Om ingen färg finns, returneras 'FFFFFF' (vit)
 */
function getRouteColorFromRouteId(routeId) {
  const routeInfo = routeInfoMap[routeId];
  return routeInfo ? `#${routeInfo.color}` : '#000000';
}

/**
 * Returnerar textfärgkod för en rutt baserat på route_id
 * Om ingen textfärg finns, returneras 'FFFFFF' (vit)
 */
function getRouteTextColorFromRouteId(routeId) {
  const routeInfo = routeInfoMap[routeId];
  return routeInfo ? `#${routeInfo.textColor}` : '#FFFFFF';
}

/**
 * Returnerar långt namn för en rutt baserat på route_id
 */
function getRouteLongNameFromRouteId(routeId) {
  const routeInfo = routeInfoMap[routeId];
  return routeInfo ? routeInfo.longName : null;
}

/**
 * Returnerar bussnummer baserat på trip_id
 */
function getBusNumberFromTripId(tripId) {
  const routeId = tripToRouteMap[tripId];
  return routeId ? getBusNumberFromRouteId(routeId) : null;
}

/**
 * Returnerar bussnummer baserat på block_id
 */
function getBusNumberFromBlockId(blockId) {
  const routeId = blockToRouteMap[blockId];
  return routeId ? getBusNumberFromRouteId(routeId) : null;
}

/**
 * Huvudfunktion för att ladda GTFS-data
 */
async function loadGtfsData(forceRefresh = false) {
  try {
    // Läs in metadata för att få senaste uppdateringstid
    loadMetadata();
    
    // Kontrollera om vi behöver uppdatera data baserat på tid eller force flag
    const currentTime = Date.now();
    const needsRefresh = forceRefresh || (currentTime - lastUpdateTime) > UPDATE_INTERVAL;
    const filesExist = fs.existsSync(path.join(GTFS_EXTRACT_PATH, 'routes.txt')) && 
                        fs.existsSync(path.join(GTFS_EXTRACT_PATH, 'trips.txt'));
    
    // Om vi behöver hämta och extrahera data
    if (needsRefresh || !filesExist) {
      console.log('GTFS-data behöver uppdateras...');
      
      const downloaded = await downloadGtfsData();
      if (!downloaded) {
        // Om nedladdningen misslyckas men vi har befintliga filer, använd dem istället
        if (filesExist) {
          console.log('Använder befintlig GTFS-data då nedladdning misslyckades');
        } else if (USE_MOCK_DATA_ON_FAILURE) {
          console.log('Nedladdning misslyckades. Använder mock-data för testning istället.');
          await generateMockGtfsData();
        } else {
          throw new Error('Kunde inte hämta GTFS-data och inga tidigare data finns tillgängliga');
        }
      } else {
        const extracted = await extractGtfsData();
        if (!extracted) {
          if (filesExist) {
            console.log('Använder befintlig GTFS-data då extrahering misslyckades');
          } else if (USE_MOCK_DATA_ON_FAILURE) {
            console.log('Extrahering misslyckades. Använder mock-data för testning istället.');
            await generateMockGtfsData();
          } else {
            throw new Error('Kunde inte extrahera GTFS-data och inga tidigare data finns tillgängliga');
          }
        }
      }
      
      // Uppdatera tidsstämpel för senaste uppdatering
      lastUpdateTime = currentTime;
      saveMetadata();
    } else {
      console.log('GTFS-data är aktuell, använder befintlig data');
    }
    
    // Parse data files
    await parseRoutesData();
    await parseTripsData();
    
    console.log('GTFS-data laddad och redo att användas!');
    
    // Ställ in automatisk uppdatering
    scheduleNextRefresh();
    
    return true;
  } catch (error) {
    console.error('Fel vid laddning av GTFS-data:', error);
    return false;
  }
}

/**
 * Schemalägg nästa automatiska uppdatering av GTFS-data
 */
function scheduleNextRefresh() {
  // Rensa befintlig timer om sådan finns
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  
  // Beräkna tid till nästa uppdatering
  const currentTime = Date.now();
  const timeSinceLastUpdate = currentTime - lastUpdateTime;
  const timeToNextUpdate = Math.max(UPDATE_INTERVAL - timeSinceLastUpdate, 0);
  
  console.log(`Nästa automatiska GTFS-uppdatering schemalagd om ${Math.round(timeToNextUpdate / (60 * 60 * 1000))} timmar`);
  
  // Schemalägg nästa uppdatering
  refreshTimer = setTimeout(async () => {
    console.log('Utför schemalagd uppdatering av GTFS-data');
    try {
      await loadGtfsData(true); // Tvinga uppdatering
    } catch (error) {
      console.error('Schemalagd GTFS-uppdatering misslyckades:', error);
      // Schemalägg nästa försök även vid fel
      scheduleNextRefresh();
    }
  }, timeToNextUpdate);
}

/**
 * Manuell funktion för att tvinga omedelbar uppdatering av GTFS-data
 */
async function refreshGtfsData() {
  console.log('Tvingad manuell uppdatering av GTFS-data begärd');
  
  // Varna för API-användning
  let downloadCount = 0;
  if (fs.existsSync(METADATA_FILE)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
      downloadCount = metadata.downloadCount || 0;
    } catch (err) {}
  }
  
  console.log(`VARNING: Detta kommer att använda ett API-anrop (${downloadCount+1}/50 per månad)`);
  return await loadGtfsData(true);
}

/**
 * Skapa mockdata för tester
 */
function createMockData() {
  console.log('Skapar mockdata för tester...');
  
  try {
    // Exempeldata för routes.txt
    const routesData = [
      { route_id: '1', route_short_name: '101' },
      { route_id: '2', route_short_name: '102' },
      { route_id: '3', route_short_name: '103' }
    ];
    
    // Exempeldata för trips.txt
    const tripsData = [
      { trip_id: '1001', route_id: '1', block_id: 'B1' },
      { trip_id: '1002', route_id: '2', block_id: 'B2' },
      { trip_id: '1003', route_id: '3', block_id: 'B3' }
    ];
    
    // Skriv ut exempeldata till filer
    fs.writeFileSync(ROUTES_PATH, 'route_id,route_short_name\n' + 
      routesData.map(r => `${r.route_id},${r.route_short_name}`).join('\n'));
    fs.writeFileSync(TRIPS_PATH, 'trip_id,route_id,block_id\n' + 
      tripsData.map(t => `${t.trip_id},${t.route_id},${t.block_id}`).join('\n'));
    
    console.log('Mockdata skapad:');
    console.log('- routes.txt:', routesData);
    console.log('- trips.txt:', tripsData);
    
    // Tvinga inläsning av ny mockdata
    usingMockData = true;
    loadGtfsData(true);
  } catch (error) {
    console.error('Fel vid skapande av mockdata:', error);
  }
}

/**
 * Genererar testdata när vi inte kan hämta riktig GTFS-data
 */
async function generateMockGtfsData() {
  console.log('Genererar mock GTFS-data för testning...');
  
  try {
    // Skapa målmappar om de inte finns
    if (!fs.existsSync(GTFS_EXTRACT_PATH)) {
      fs.mkdirSync(GTFS_EXTRACT_PATH, { recursive: true });
    }
    
    // Generera testdata för routes.txt
    const routesData = 
`route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color
1,xtrafik,1,Centrum - Sjukhuset,3,0000FF,FFFFFF
2,xtrafik,2,Centrum - Bomhus,3,00FF00,FFFFFF
3,xtrafik,3,Centrum - Sätra,3,FF0000,FFFFFF
4,xtrafik,4,Centrum - Andersberg,3,FFFF00,000000
10,xtrafik,10,Centrum - Valbo,3,00FFFF,000000
11,xtrafik,11,Centrum - Brynäs,3,FF00FF,FFFFFF
12,xtrafik,12,Centrum - Stigslund,3,772233,FFFFFF
15,xtrafik,15,Centrum - Hamrånge,3,334455,FFFFFF
20,xtrafik,20,Centrum - Kungsbäck,3,998877,000000
30,xtrafik,30,Centrum - Hagaström,3,223311,FFFFFF
41,xtrafik,41,Valbo - Forsbacka,3,445511,FFFFFF
42,xtrafik,42,Centrum - Forsbacka,3,667722,FFFFFF
44,xtrafik,44,Sandviken - Gävle,3,546712,FFFFFF
50,xtrafik,50,Sandviken - Valbo,3,993300,FFFFFF
55,xtrafik,55,Sandviken - Hofors,3,234567,FFFFFF
`;
    
    // Generera testdata för trips.txt
    const tripsData = 
`route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed
1,vardagar,trip_1_01,Sjukhuset,,0,block_1_01,1,1,1
1,vardagar,trip_1_02,Centrum,,1,block_1_02,1,1,1
2,vardagar,trip_2_01,Bomhus,,0,block_2_01,2,1,1
2,vardagar,trip_2_02,Centrum,,1,block_2_02,2,1,1
3,vardagar,trip_3_01,Sätra,,0,block_3_01,3,1,1
3,vardagar,trip_3_02,Centrum,,1,block_3_02,3,1,1
4,vardagar,trip_4_01,Andersberg,,0,block_4_01,4,1,1
10,vardagar,trip_10_01,Valbo,,0,block_10_01,10,1,1
11,vardagar,trip_11_01,Brynäs,,0,block_11_01,11,1,1
12,vardagar,trip_12_01,Stigslund,,0,block_12_01,12,1,1
15,vardagar,trip_15_01,Hamrånge,,0,block_15_01,15,1,1
20,vardagar,trip_20_01,Kungsbäck,,0,block_20_01,20,1,1
30,vardagar,trip_30_01,Hagaström,,0,block_30_01,30,1,1
41,vardagar,trip_41_01,Forsbacka,,0,block_41_01,41,1,1
42,vardagar,trip_42_01,Forsbacka,,0,block_42_01,42,1,1
44,vardagar,trip_44_01,Gävle,,0,block_44_01,44,1,1
50,vardagar,trip_50_01,Valbo,,0,block_50_01,50,1,1
55,vardagar,trip_55_01,Hofors,,0,block_55_01,55,1,1
`;
    
    // Skriv filerna
    fs.writeFileSync(ROUTES_PATH, routesData);
    fs.writeFileSync(TRIPS_PATH, tripsData);
    
    console.log('Mock GTFS-data genererad och sparad till:', GTFS_EXTRACT_PATH);
    usingMockData = true;
    
    // Uppdatera lastUpdateTime men markera det som mock-data
    lastUpdateTime = Date.now();
    
    // Spara metadata med notering om att det är mock-data
    const metadata = {
      lastUpdateTime,
      downloadCount: 0, // Räkna inte mock-data som en nedladdning
      lastDownload: new Date().toISOString(),
      mockData: true,
      nextScheduledUpdate: new Date(lastUpdateTime + UPDATE_INTERVAL).toISOString()
    };
    
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
    
    return true;
  } catch (error) {
    console.error('Fel vid generering av mock GTFS-data:', error);
    return false;
  }
}

/**
 * Läs in data (antingen från filer eller API) och hantera fel med mockdata
 */
async function loadDataWithFallback() {
  try {
    // Försök ladda data från API eller filer
    await loadGtfsData();
  } catch (error) {
    console.error('Fel vid inläsning av GTFS-data, använder eventuell befintlig data eller skapar mockdata:', error);
    
    // Om vi inte redan använder mockdata, försök att skapa mockdata
    if (!usingMockData) {
      createMockData();
    } else {
      console.log('Använder befintlig mockdata');
    }
  }
}

// Anropa loadDataWithFallback vid start för att läsa in data
loadDataWithFallback();

module.exports = {
  loadGtfsData,
  refreshGtfsData,
  getBusNumberFromRouteId,
  getBusNumberFromTripId,
  getBusNumberFromBlockId,
  getRouteMap: () => routeMap,
  getTripMap: () => tripToRouteMap,
  getBlockMap: () => blockToRouteMap,
  generateMockGtfsData,
  isUsingMockData: () => usingMockData,
  getRouteInfoFromRouteId,
  getRouteColorFromRouteId,
  getRouteTextColorFromRouteId,
  getRouteLongNameFromRouteId
};
