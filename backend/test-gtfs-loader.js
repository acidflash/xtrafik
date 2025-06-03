// Test script för GTFS-loader
const gtfsLoader = require('./gtfs-loader');

async function testGtfsLoader() {
  console.log('Testing GTFS Loader...');
  
  try {
    console.log('Steg 1: Laddar GTFS data...');
    await gtfsLoader.loadGtfsData();
    
    console.log('\nSteg 2: Hämtar kartläggningar...');
    const routeMap = gtfsLoader.getRouteMap();
    const tripMap = gtfsLoader.getTripMap();
    const blockMap = gtfsLoader.getBlockMap();
    
    console.log(`Statistik: ${Object.keys(routeMap).length} rutter, ${Object.keys(tripMap).length} trips, ${Object.keys(blockMap).length} blocks`);
    
    // Kontrollera några exempelrutter
    console.log('\nSteg 3: Visa exempel på rutter...');
    const routeExamples = Object.keys(routeMap).slice(0, 10);
    if (routeExamples.length > 0) {
      routeExamples.forEach(routeId => {
        console.log(`Route ${routeId} -> Bussnummer: ${routeMap[routeId]}`);
      });
    } else {
      console.log('Inga rutter hittades!');
    }
    
    // Test av lookup-funktioner med några exempel
    console.log('\nSteg 4: Testar lookup-funktioner...');
    if (routeExamples.length > 0) {
      const testRouteId = routeExamples[0];
      console.log(`getBusNumberFromRouteId('${testRouteId}') -> ${gtfsLoader.getBusNumberFromRouteId(testRouteId)}`);
    }
    
    // Test av trip-ID lookups om tillgängligt
    const tripIds = Object.keys(tripMap).slice(0, 3);
    if (tripIds.length > 0) {
      console.log('\nTrip-ID exempel:');
      tripIds.forEach(tripId => {
        const routeId = tripMap[tripId];
        const busNumber = gtfsLoader.getBusNumberFromTripId(tripId);
        console.log(`Trip ${tripId} -> Route ${routeId} -> Bussnummer: ${busNumber}`);
      });
    }
    
    console.log('\nTest slutfört!');
  } catch (error) {
    console.error('Test misslyckades med fel:', error);
  }
}

// Kör testet
testGtfsLoader().catch(console.error);
