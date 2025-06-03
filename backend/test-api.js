const fetch = require('node-fetch');
const path = require('path');
const dotenv = require('dotenv');

// Ladda .env från projektets rot-katalog
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const API_KEY = process.env.API_KEY;
console.log(`Testar API-anrop med nyckel: ${API_KEY}`);

async function testApi() {
  try {
    // X-Trafiks API
    console.log("Testar X-Trafiks API...");
    const xtResponse = await fetch(`https://opendata.samtrafiken.se/gtfs-rt/xt/VehiclePositions.pb?key=${API_KEY}`, {
      headers: { 'Accept-Encoding': 'gzip, deflate' }
    });
    
    console.log(`X-Trafik API status: ${xtResponse.status} ${xtResponse.statusText}`);
    if (!xtResponse.ok) {
      try {
        const errorText = await xtResponse.text();
        console.log(`X-Trafik API svarade med: ${errorText}`);
      } catch (e) {
        console.log('Kunde inte läsa svarskropp:', e.message);
      }
    } else {
      console.log('X-Trafik API anrop lyckades!');
    }
    
    // GTFS Sweden API
    console.log("\nTestar GTFS Sweden API...");
    const swedenResponse = await fetch(`https://opendata.samtrafiken.se/gtfs-sweden/VehiclePositions/VehiclePositions.pb?key=${API_KEY}`, {
      headers: { 'Accept-Encoding': 'gzip, deflate' }
    });
    
    console.log(`GTFS Sweden API status: ${swedenResponse.status} ${swedenResponse.statusText}`);
    if (!swedenResponse.ok) {
      try {
        const errorText = await swedenResponse.text();
        console.log(`GTFS Sweden API svarade med: ${errorText}`);
      } catch (e) {
        console.log('Kunde inte läsa svarskropp:', e.message);
      }
    } else {
      console.log('GTFS Sweden API anrop lyckades!');
    }
  } catch (e) {
    console.error('Ett fel uppstod:', e);
  }
}

testApi();
