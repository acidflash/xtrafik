/**
 * trafikverket.js — Hämtar tågpositioner från Trafikverkets öppna API
 *
 * Principen:
 *  1. Hämta stationskoordinater (WGS84) vid uppstart via TrainStation-API:t
 *  2. Poll TrainAnnouncement var 30:e sekund för avgångar/ankomster i regionen
 *  3. Beräkna interpolerad position: tåget rör sig linjärt längs
 *     segmentet [senast bekräftad avgång → nästa väntad ankomst]
 */

const fetch  = require('node-fetch');
const path   = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const API_KEY = process.env.TRAFIKVERKET_API_KEY;
const API_URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json';

// ── Stationskoordinat-cache ─────────────────────────────────────
// { [LocationSignature]: { lat, lon, name } }
let stationCoords   = {};
let stationsLoaded  = false;

// ── Tågpositions-cache ──────────────────────────────────────────
const CACHE_TTL = 30000; // 30 s
let _cache = { trains: null, timestamp: 0 };

// ── Hjälpfunktioner ─────────────────────────────────────────────

/** Skicka POST-förfrågan till Trafikverkets API */
async function tvRequest(xml) {
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/xml' },
    body:    xml,
    timeout: 10000,
  });
  const data = await res.json();
  const err  = data?.RESPONSE?.RESULT?.[0]?.ERROR;
  if (err) throw new Error(`Trafikverket: ${err.MESSAGE || JSON.stringify(err)}`);
  return data;
}

/** Parsa Trafikverkets WGS84-geometriformat: "POINT (lon lat)" */
function parseWgs84(wgs84) {
  const m = (wgs84 || '').match(/POINT \(([0-9.]+) ([0-9.]+)\)/);
  if (!m) return null;
  return { lon: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

/** Linjär interpolering mellan två stationer, fraction [0–1] */
function interpolate(from, to, fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  return {
    lat: from.lat + (to.lat - from.lat) * f,
    lon: from.lon + (to.lon - from.lon) * f,
  };
}

/** Beräkna bäring (grader, 0=N) från en punkt till en annan */
function calcBearing(from, to) {
  const dLon  = (to.lon - from.lon) * Math.PI / 180;
  const lat1  = from.lat * Math.PI / 180;
  const lat2  = to.lat   * Math.PI / 180;
  const y     = Math.sin(dLon) * Math.cos(lat2);
  const x     = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/** Välj bästa tidpunkt för en annonsering */
function eventTime(ann) {
  return ann.TimeAtLocation
      || ann.EstimatedTimeAtLocation
      || ann.AdvertisedTimeAtLocation;
}

// ── Stationshämtning ────────────────────────────────────────────

/**
 * Hämta och cacha alla stationer inom Gävleborg-regionen.
 * Bounding box täcker hela X-trafiks nät plus lite marginal.
 */
async function initStations() {
  if (!API_KEY) return;
  try {
    const data = await tvRequest(`<?xml version="1.0" encoding="UTF-8"?>
<REQUEST>
  <LOGIN authenticationkey="${API_KEY}"/>
  <QUERY objecttype="TrainStation" schemaversion="1" limit="500">
    <FILTER>
      <WITHIN name="Geometry.WGS84" shape="box" value="14.5 59.5, 19.0 62.8"/>
    </FILTER>
    <INCLUDE>LocationSignature</INCLUDE>
    <INCLUDE>AdvertisedLocationName</INCLUDE>
    <INCLUDE>Geometry.WGS84</INCLUDE>
  </QUERY>
</REQUEST>`);

    const stations = data?.RESPONSE?.RESULT?.[0]?.TrainStation || [];
    stations.forEach(s => {
      const geom = parseWgs84(s?.Geometry?.WGS84 || s?.['Geometry.WGS84']);
      if (geom && s.LocationSignature) {
        stationCoords[s.LocationSignature] = {
          lat:  geom.lat,
          lon:  geom.lon,
          name: s.AdvertisedLocationName || s.LocationSignature,
        };
      }
    });
    stationsLoaded = true;
    console.log(`Trafikverket: ${Object.keys(stationCoords).length} stationer laddade`);
  } catch (e) {
    console.error('Trafikverket stations-fel:', e.message);
  }
}

// ── Tågposition-hämtning ────────────────────────────────────────

async function fetchTrainPositions() {
  if (!API_KEY) return [];

  const now = Date.now();
  if (_cache.trains && (now - _cache.timestamp) < CACHE_TTL) return _cache.trains;

  // Ladda stationer vid behov
  if (!stationsLoaded) await initStations();
  const sigs = Object.keys(stationCoords);
  if (sigs.length === 0) return [];

  try {
    // Hämta aviseringar: 90 min bakåt + 75 min framåt för aktivt körande tåg
    const data = await tvRequest(`<?xml version="1.0" encoding="UTF-8"?>
<REQUEST>
  <LOGIN authenticationkey="${API_KEY}"/>
  <QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="1000" orderby="AdvertisedTimeAtLocation">
    <FILTER>
      <AND>
        <GT name="AdvertisedTimeAtLocation" value="$dateadd(-1:30:0)"/>
        <LT name="AdvertisedTimeAtLocation" value="$dateadd(1:15:0)"/>
        <IN name="LocationSignature" value="${sigs.join(',')}"/>
        <EQ name="Canceled" value="false"/>
      </AND>
    </FILTER>
    <INCLUDE>AdvertisedTrainIdent</INCLUDE>
    <INCLUDE>ActivityType</INCLUDE>
    <INCLUDE>TimeAtLocation</INCLUDE>
    <INCLUDE>AdvertisedTimeAtLocation</INCLUDE>
    <INCLUDE>EstimatedTimeAtLocation</INCLUDE>
    <INCLUDE>LocationSignature</INCLUDE>
    <INCLUDE>ProductInformation</INCLUDE>
    <INCLUDE>Operator</INCLUDE>
    <INCLUDE>ToLocation</INCLUDE>
  </QUERY>
</REQUEST>`);

    const announcements = data?.RESPONSE?.RESULT?.[0]?.TrainAnnouncement || [];
    console.log(`Trafikverket: ${announcements.length} aviseringar mottagna`);

    // Gruppera per tågnummer
    const byTrain = {};
    announcements.forEach(ann => {
      const id = ann.AdvertisedTrainIdent;
      if (!id) return;
      if (!byTrain[id]) byTrain[id] = [];
      byTrain[id].push(ann);
    });

    const nowMs  = Date.now();
    const trains = [];

    Object.entries(byTrain).forEach(([trainId, anns]) => {
      // Sortera kronologiskt
      anns.sort((a, b) => new Date(eventTime(a)) - new Date(eventTime(b)));

      // Senaste bekräftade avgång (tåget HAR lämnat stationen)
      const departed = anns
        .filter(a => a.ActivityType === 'Avgang' && a.TimeAtLocation)
        .at(-1);

      if (!departed) return; // Tåget har inte avgått i vår region än

      // Nästa väntade ankomst (tåget HAR INTE anlänt ännu)
      const nextArr = anns.find(
        a => a.ActivityType === 'Ankomst'
          && !a.TimeAtLocation
          && new Date(eventTime(a)) > new Date(departed.TimeAtLocation)
      );

      if (!nextArr) return; // Ingen kommande ankomst i regionen

      const fromCoord = stationCoords[departed.LocationSignature];
      const toCoord   = stationCoords[nextArr.LocationSignature];
      if (!fromCoord || !toCoord) return;

      // Stoppa om från och till är samma station
      if (departed.LocationSignature === nextArr.LocationSignature) return;

      const depMs = new Date(departed.TimeAtLocation).getTime();
      const arrMs = new Date(eventTime(nextArr)).getTime();
      if (arrMs <= depMs) return;

      const fraction = (nowMs - depMs) / (arrMs - depMs);

      // Tåget ska vara aktivt just nu (inte för tidigt, inte för sent)
      if (fraction < -0.05 || fraction > 1.1) return;

      const pos  = interpolate(fromCoord, toCoord, fraction);
      const bear = calcBearing(fromCoord, toCoord);

      // Linjenamn från ProductInformation
      const products = [].concat(departed.ProductInformation || []);
      const lineName  = products
        .flatMap(p => [p.Description, p.Code].filter(Boolean))
        .find(Boolean) || 'Tåg';

      trains.push({
        id:       trainId,
        vehicle:  { id: trainId },
        position: {
          latitude:  pos.lat,
          longitude: pos.lon,
          bearing:   bear,
          speed:     0,
        },
        timestamp:    { low: Math.floor(nowMs / 1000) },
        lineName,
        routeLongName: `${fromCoord.name} → ${toCoord.name}`,
        operator:      departed.Operator || null,
        type:          'train',
      });
    });

    console.log(`Trafikverket: ${trains.length} aktiva tåg beräknade`);
    _cache = { trains, timestamp: nowMs };
    return trains;

  } catch (e) {
    console.error('Trafikverket fetch-fel:', e.message);
    return _cache.trains || []; // Returnera gammal cache vid fel
  }
}

module.exports = { initStations, fetchTrainPositions };
