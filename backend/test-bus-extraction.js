/**
 * Test script för att validera extraktionen av bussnummer från fordons-ID
 * 
 * Kör med: node test-bus-extraction.js
 */

const fs = require('fs');
const path = require('path');

// Importera extractBusNumber-funktionen från server.js
// Eftersom funktionen inte exporteras direkt, måste vi extrahera den från filen
const serverPath = path.join(__dirname, 'server.js');
const serverContent = fs.readFileSync(serverPath, 'utf8');

// Extrahera funktionen med regexp
const functionMatch = serverContent.match(/function\s+extractBusNumber\s*\([\s\S]*?\)\s*{[\s\S]*?return.*?;\s*}/);

if (!functionMatch) {
  console.error('Kunde inte hitta extractBusNumber-funktionen i server.js');
  process.exit(1);
}

// Skapa en funktion från strängen
const extractBusNumberFn = new Function(
  'vehicleId',
  functionMatch[0]
    .replace('function extractBusNumber(vehicleId)', '')
    .replace('console.log', '// console.log') // Deaktivera loggning för testkörning
);

// Överskuggad konsol-logg för våra test så att vi slipper skräp i output
const originalConsoleLog = console.log;
console.log = function() {
  // Gör ingenting under testet
};

// Skapa våra testfall - fordons-ID -> förväntat linjenummer
const testCases = [
  // Format: [vehicleId, expectedBusNumber, description]
  ['9031021000444499', '44', '16-siffrigt ID med företags-ID 1000 (linje 44)'],
  ['9031021001271554', '27', '16-siffrigt ID med företags-ID 1001 (linje 27)'],
  ['9031021000557751', '55', '16-siffrigt ID med företags-ID 0005 (linje 55)'],
  ['9031021001271553', '27', 'Ytterligare ett ID för linje 27'],
  ['9031021001002444', '1', '16-siffrigt ID med företags-ID 1002 (linje 1)'],
  ['9031021001003444', '2', '16-siffrigt ID med företags-ID 1003 (linje 2)'],
  ['9031021001004444', '3', '16-siffrigt ID med företags-ID 1004 (linje 3)'],
  ['9031021001005444', '4', '16-siffrigt ID med företags-ID 1005 (linje 4)'],
  ['9031021001010444', '10', '16-siffrigt ID med företags-ID 1010 (linje 10)'],
  ['9031021001011444', '11', '16-siffrigt ID med företags-ID 1011 (linje 11)'],
  ['9031021001012444', '12', '16-siffrigt ID med företags-ID 1012 (linje 12)'],
  ['9031021001015444', '15', '16-siffrigt ID med företags-ID 1015 (linje 15)'],
  ['44789612', '44', 'Kort ID där de första siffrorna är linjenumret'],
  ['789644', '44', 'Kort ID där de sista 2 siffrorna i de 6 sista är linjenumret'],
  ['100', '10', 'Mycket kort ID där de 2 första siffrorna är linjenumret'],
  ['123456', '12', 'Kort ID där de 2 första siffrorna i de 6 sista är linjenumret'],
  ['9031021099999999', '99', 'Okänt företags-ID men siffror som kan tolkas som linjenummer'],
  ['XTRF1234', '12', 'ID med bokstäver och siffror'],
  ['bus42', '42', 'ID med bokstäver och ett tydligt nummer'],
  ['XTR', 'Okänt', 'ID som inte innehåller något tydligt linjenummer']
];

// Kör testerna
console.log = originalConsoleLog; // Återställ konsol-logg för våra resultat
console.log('=== TESTER FÖR BUSSNUMMEREXTRAKTION ===');
console.log('Kör', testCases.length, 'testfall...\n');

let passed = 0;
let failed = 0;

// Håll reda på vilka mappningar som fungerar
const workingMappings = {};
const failedMappings = {};

testCases.forEach((testCase, index) => {
  const [vehicleId, expectedBusNumber, description] = testCase;
  
  try {
    const resultBusNumber = extractBusNumberFn(vehicleId);
    
    if (resultBusNumber === expectedBusNumber) {
      console.log(`✅ TEST ${index + 1} OK: ${vehicleId} -> ${resultBusNumber} (${description})`);
      passed++;
      
      // Spara i working mappings
      const key = vehicleId.length === 16 ? vehicleId.substring(6, 10) : 'annan';
      if (!workingMappings[key]) workingMappings[key] = [];
      workingMappings[key].push({vehicleId, busNumber: resultBusNumber});
    } else {
      console.log(`❌ TEST ${index + 1} MISSLYCKADES: ${vehicleId} -> ${resultBusNumber} (förväntade ${expectedBusNumber}) (${description})`);
      failed++;
      
      // Spara i failed mappings
      const key = vehicleId.length === 16 ? vehicleId.substring(6, 10) : 'annan';
      if (!failedMappings[key]) failedMappings[key] = [];
      failedMappings[key].push({vehicleId, actual: resultBusNumber, expected: expectedBusNumber});
    }
  } catch (error) {
    console.log(`❌ TEST ${index + 1} KRASCHADE: ${vehicleId} -> ${error.message} (${description})`);
    failed++;
  }
});

// Visa statistik
console.log('\n=== RESULTAT ===');
console.log(`Totalt antal test: ${testCases.length}`);
console.log(`Lyckades: ${passed} (${Math.round(passed / testCases.length * 100)}%)`);
console.log(`Misslyckades: ${failed} (${Math.round(failed / testCases.length * 100)}%)`);

// Visa operationella detaljer
console.log('\n=== FUNGERAR FÖR DESSA FÖRETAGS-ID ===');
Object.keys(workingMappings).forEach(key => {
  console.log(`${key}: ${workingMappings[key].map(m => m.busNumber).join(', ')}`);
});

if (Object.keys(failedMappings).length > 0) {
  console.log('\n=== PROBLEM MED DESSA FÖRETAGS-ID ===');
  Object.keys(failedMappings).forEach(key => {
    console.log(`${key}: ${failedMappings[key].map(m => `${m.vehicleId} -> fick ${m.actual}, förväntade ${m.expected}`).join(', ')}`);
  });
}

console.log('\nFör att förbättra algoritmens precision, uppdatera mappningen i extractBusNumber-funktionen i server.js');
