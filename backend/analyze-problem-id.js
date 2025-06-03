/**
 * Simple test for problematic vehicle ID
 */
const specificVehicleId = '9031021000557753';

// Analyze vehicle ID structure
console.log(`Testing vehicle ID: ${specificVehicleId}`);
console.log(`Length: ${specificVehicleId.length}`);

if (specificVehicleId.length === 16) {
  const prefix = specificVehicleId.substring(0, 6);
  const companyId = specificVehicleId.substring(6, 10);
  const suffix = specificVehicleId.substring(10);
  
  console.log(`Prefix: ${prefix}`);
  console.log(`Company ID: ${companyId}`);
  console.log(`Suffix: ${suffix}`);
  
  console.log(`First two digits of suffix: ${suffix.substring(0, 2)}`);
  console.log(`Last two digits of company ID: ${companyId.substring(2)}`);
}

// The problem appears to be that company ID 0005 should map to line 55
console.log("\nConclusion: This vehicle with ID 9031021000557753 has company ID 0005 and should be mapped to line 55.");
