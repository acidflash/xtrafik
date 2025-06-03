// This script analyzes vehicle IDs from X-trafik to better understand the format
const fetch = require('node-fetch');
const path = require('path');
const dotenv = require('dotenv');
const { transit_realtime } = require('gtfs-realtime-bindings');

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Check if API key is available
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error('API_KEY is missing! Make sure you have a valid .env file with API_KEY.');
  process.exit(1);
}

/**
 * Analyzes a list of vehicle IDs to identify patterns
 */
function analyzeVehicleIDs(vehicles) {
  console.log(`\n=== ANALYZING ${vehicles.length} VEHICLES ===\n`);
  
  // Store patterns by length
  const patternsByLength = {};
  const routeInfo = {};
  const companyIdMap = {}; // To track company ID segments and their relation to route IDs
  
  vehicles.forEach(vehicle => {
    if (!vehicle.vehicle || !vehicle.vehicle.id) return;
    
    const id = vehicle.vehicle.id;
    const length = id.length;
    
    // Store by length
    if (!patternsByLength[length]) {
      patternsByLength[length] = [];
    }
    
    // Extract company ID if ID length is 16 (X-trafik format)
    if (length === 16) {
      const companyId = id.substring(6, 10); // Extract company ID segment
      
      // Track which route_ids are associated with this company ID
      if (vehicle.trip && vehicle.trip.route_id) {
        const routeId = vehicle.trip.route_id;
        if (!companyIdMap[companyId]) {
          companyIdMap[companyId] = {
            routeIds: new Set(),
            examples: []
          };
        }
        companyIdMap[companyId].routeIds.add(routeId);
        
        // Store up to 3 examples
        if (companyIdMap[companyId].examples.length < 3) {
          companyIdMap[companyId].examples.push(id);
        }
      }
    }
    
    // Collect route ID info if available
    if (vehicle.trip && vehicle.trip.route_id) {
      const routeId = vehicle.trip.route_id;
      if (!routeInfo[routeId]) {
        routeInfo[routeId] = [];
      }
      routeInfo[routeId].push(id);
    }
    
    patternsByLength[length].push(id);
  });
  
  // Print results
  console.log('=== VEHICLE ID PATTERNS BY LENGTH ===');
  Object.keys(patternsByLength).sort().forEach(length => {
    const ids = patternsByLength[length];
    console.log(`\nLength ${length}: ${ids.length} vehicles`);
    
    // Print first 5 examples
    console.log('Examples:', ids.slice(0, 5).join(', '));
    
    // Analyze digit patterns
    if (ids.length > 0) {
      // Check if all IDs follow same pattern
      const firstId = ids[0];
      let digitPatterns = Array(firstId.length).fill().map(() => ({
        isStatic: true,
        digits: new Set()
      }));
      
      ids.forEach(id => {
        for (let i = 0; i < id.length; i++) {
          const digit = id[i];
          if (digitPatterns[i].digits.size < 10) {
            digitPatterns[i].digits.add(digit);
          }
        }
      });
      
      console.log('Digit analysis:');
      let pattern = '';
      digitPatterns.forEach((pos, i) => {
        if (pos.digits.size === 1) {
          // Static digit
          pattern += Array.from(pos.digits)[0];
        } else if (pos.digits.size <= 5) {
          // Limited variation
          pattern += `[${Array.from(pos.digits).join('')}]`;
        } else {
          // Variable digit
          pattern += 'X';
        }
      });
      console.log(`Pattern: ${pattern}`);
    }
  });
  
  // Print route ID info
  console.log('\n=== ROUTE IDS ===');
  Object.keys(routeInfo).sort().forEach(routeId => {
    const vehicles = routeInfo[routeId];
    console.log(`\nRoute ${routeId}: ${vehicles.length} vehicles`);
    console.log('Example IDs:', vehicles.slice(0, 3).join(', '));
  });
  
  // Print company ID to route ID mappings
  console.log('\n=== COMPANY ID TO ROUTE ID MAPPINGS ===');
  Object.keys(companyIdMap).sort().forEach(companyId => {
    const info = companyIdMap[companyId];
    console.log(`\nCompany ID: ${companyId}`);
    console.log(`Associated Routes: ${Array.from(info.routeIds).join(', ')}`);
    console.log(`Example vehicle IDs: ${info.examples.join(', ')}`);
    
    // For long IDs (16 digits), suggest pattern structure
    if (info.examples.length > 0 && info.examples[0].length === 16) {
      const exampleId = info.examples[0];
      console.log('Pattern breakdown:');
      console.log(`Prefix (pos 0-5): ${exampleId.substring(0, 6)}`);
      console.log(`Company ID (pos 6-9): ${companyId}`);
      console.log(`Suffix (pos 10-15): ${exampleId.substring(10)}`);
    }
  });
}

// Fetch vehicle positions and analyze
async function main() {
  try {
    console.log('Fetching vehicle positions...');
    
    const response = await fetch(`https://opendata.samtrafiken.se/gtfs-rt/xt/VehiclePositions.pb?key=${API_KEY}`, {
      headers: {
        'Accept-Encoding': 'gzip, deflate'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    console.log(`Fetched ${buffer.byteLength} bytes of data`);
    
    // Decode protobuf
    const feed = transit_realtime.FeedMessage.decode(new Uint8Array(buffer));
    console.log(`Found ${feed.entity.length} entities in feed`);
    
    // Extract vehicles
    const vehicles = feed.entity
      .filter(entity => entity.vehicle)
      .map(entity => entity.vehicle);
    
    // Analyze vehicle IDs
    analyzeVehicleIDs(vehicles);
    
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
