/**
 * trafikverket.js — Hämtar tågpositioner från Trafikverkets öppna API
 *
 * Primär källa (kräver TrainPosition-prenumeration i API-kontot):
 *   TrainPosition — faktiska GPS-koordinater i SWEREF99TM, uppdateras i realtid.
 *   Bbox-filter använder SWEREF99TM (meter) för exakt geografisk filtrering.
 *
 * Fallback (alltid tillgänglig med gratisnyckeln):
 *   TrainAnnouncement + TrainStation — interpolerad position längs segmentet
 *   [senast bekräftad avgång → nästa väntad ankomst].
 *
 * Aktivera TrainPosition: https://api.trafikinfo.trafikverket.se/Account
 * (lägg till "TrainPosition" under Data subscriptions)
 */

const fetch  = require('node-fetch');
const path   = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const API_KEY = process.env.TRAFIKVERKET_API_KEY;
const API_URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json';

// ── Geografisk avgränsning (SWEREF99TM, meter) ──────────────────
// Täcker Gävleborg + angränsande järnväg med marginal
const BBOX_SWEREF = { minE: 250000, minN: 6560000, maxE: 800000, maxN: 7010000 };
// WGS84-motsvarighet (för stationsladdning och debugging)
const BBOX_WGS84 = '14.5 59.5, 19.0 62.8';

// ── Stationskoordinat-cache ─────────────────────────────────────
let stationCoords  = {};
let stationsLoaded = false;

// ── TrainPosition-tillgänglighet ────────────────────────────────
// Sätt till true när "TrainPosition" är aktiverad i DataCache-prenumerationen:
//   https://data.trafikverket.se  →  Mina prenumerationer  →  TrainPosition
// Tills dess används interpolationsfallbacken.
let gpsAvailable = false;

// ── Positionscache ──────────────────────────────────────────────
const CACHE_TTL = 20000; // 20 s (GPS behöver tätare uppdatering än interpolation)
let _cache = { trains: null, timestamp: 0 };

// ── Hjälpfunktioner ─────────────────────────────────────────────

/** POST-förfrågan till Trafikverkets API. Kastar Error med .tvCode vid API-fel. */
async function tvRequest(xml) {
  const res = await fetch(API_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/xml' },
    body:    xml,
    timeout: 10000,
  });
  const data = await res.json();
  const err  = data?.RESPONSE?.RESULT?.[0]?.ERROR;
  if (err) {
    const msg   = err.MESSAGE || JSON.stringify(err);
    const error = new Error(`Trafikverket: ${msg}`);
    error.tvMessage = msg;
    throw error;
  }
  return data;
}

/** Parsa Trafikverkets geometriformat: "POINT (lon lat)" eller "POINT (east north)" */
function parsePoint(str) {
  const m = (str || '').match(/POINT \(([0-9.]+) ([0-9.]+)\)/);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

/** Parsa WGS84-punkt: returnerar { lon, lat } */
function parseWgs84(wgs84) {
  const p = parsePoint(wgs84);
  if (!p) return null;
  return { lon: p.x, lat: p.y };
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
  const dLon = (to.lon - from.lon) * Math.PI / 180;
  const lat1 = from.lat * Math.PI / 180;
  const lat2 = to.lat   * Math.PI / 180;
  const y    = Math.sin(dLon) * Math.cos(lat2);
  const x    = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

/** Välj bästa tidpunkt för en annonsering */
function eventTime(ann) {
  return ann.TimeAtLocation
      || ann.EstimatedTimeAtLocation
      || ann.AdvertisedTimeAtLocation;
}

// ── Stationshämtning (för interpolationsfallback) ───────────────

/**
 * Hämta och cacha alla stationer inom regionen.
 * Används av interpolationsfallbacken (TrainAnnouncement).
 */
async function initStations() {
  if (!API_KEY) return;
  try {
    const data = await tvRequest(`<?xml version="1.0" encoding="UTF-8"?>
<REQUEST>
  <LOGIN authenticationkey="${API_KEY}"/>
  <QUERY objecttype="TrainStation" schemaversion="1" limit="500">
    <FILTER>
      <WITHIN name="Geometry.WGS84" shape="box" value="${BBOX_WGS84}"/>
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

// ── Primär: GPS-positioner via TrainPosition ────────────────────

/**
 * Hämta faktiska GPS-positioner från TrainPosition-API:t.
 * Använder SWEREF99TM bbox-filter för exakt geografisk avgränsning.
 *
 * Kräver att "TrainPosition" är aktiverat under Data subscriptions på
 * https://api.trafikinfo.trafikverket.se/Account
 *
 * @returns {Array|null}  Tågobjekt, eller null om prenumeration saknas.
 */
async function fetchGpsTrainPositions() {
  if (!API_KEY || !gpsAvailable) return null;

  const { minE, minN, maxE, maxN } = BBOX_SWEREF;

  try {
    const data = await tvRequest(`<?xml version="1.0" encoding="UTF-8"?>
<REQUEST>
  <LOGIN authenticationkey="${API_KEY}"/>
  <QUERY objecttype="TrainPosition" schemaversion="1.1" limit="200">
    <FILTER>
      <AND>
        <EQ name="Deleted" value="false"/>
        <WITHIN name="Position.SWEREF99TM" shape="box" value="${minE} ${minN}, ${maxE} ${maxN}"/>
      </AND>
    </FILTER>
    <INCLUDE>Train.AdvertisedTrainNumber</INCLUDE>
    <INCLUDE>Train.Operator</INCLUDE>
    <INCLUDE>Train.PlannedDepartureDateTimeAtOrigin</INCLUDE>
    <INCLUDE>Position.WGS84</INCLUDE>
    <INCLUDE>Position.SWEREF99TM</INCLUDE>
    <INCLUDE>Speed</INCLUDE>
    <INCLUDE>Bearing</INCLUDE>
    <INCLUDE>TimeStamp</INCLUDE>
    <INCLUDE>Deleted</INCLUDE>
  </QUERY>
</REQUEST>`);

    const positions = data?.RESPONSE?.RESULT?.[0]?.TrainPosition || [];
    console.log(`Trafikverket GPS: ${positions.length} tåg mottagna`);

    const nowMs = Date.now();
    const trains = [];

    positions.forEach(p => {
      if (p.Deleted) return;

      const wgs84 = parseWgs84(p?.Position?.WGS84 || p?.['Position.WGS84']);
      if (!wgs84) return;

      const trainNum = p?.Train?.AdvertisedTrainNumber || p?.Train?.OperationalTrainNumber || null;
      const trainId  = trainNum || `${wgs84.lat.toFixed(4)},${wgs84.lon.toFixed(4)}`;

      const tsStr   = p.TimeStamp;
      const tsMs    = tsStr ? new Date(tsStr).getTime() : nowMs;
      const bearing = typeof p.Bearing === 'number' ? p.Bearing : 0;
      const speedKmh = typeof p.Speed === 'number' ? Math.round(p.Speed) : 0;
      const operator = p?.Train?.Operator || null;

      trains.push({
        id:      trainId,
        vehicle: { id: trainId },
        position: {
          latitude:  wgs84.lat,
          longitude: wgs84.lon,
          bearing,
          speed: speedKmh,
        },
        timestamp:    { low: Math.floor(tsMs / 1000) },
        lineName:     'Tåg',     // ProductInformation ej tillgänglig i TrainPosition
        routeLongName: null,
        operator,
        type: 'train',
        source: 'gps',
      });
    });

    return trains;

  } catch (e) {
    if (e.tvMessage && (
      e.tvMessage.includes('does not exists') ||
      e.tvMessage.includes('not subscribed') ||
      e.tvMessage.includes('access') ||
      e.tvMessage.includes('Invalid query attribute')
    )) {
      if (gpsAvailable) {
        console.log('Trafikverket GPS: TrainPosition ej tillgänglig — faller tillbaka på interpolation.');
        console.log('  Prenumerera på: https://data.trafikverket.se → Mina prenumerationer → TrainPosition');
        gpsAvailable = false;
      }
      return null;
    }
    console.error('Trafikverket GPS-fel:', e.message);
    return null;
  }
}

// ── Fallback: interpolerade positioner via TrainAnnouncement ────

/**
 * Beräkna interpolerade positioner baserat på avgångs-/ankomsttider.
 * Används när TrainPosition-prenumeration saknas.
 */
async function fetchInterpolatedTrainPositions() {
  if (!stationsLoaded) await initStations();
  const sigs = Object.keys(stationCoords);
  if (sigs.length === 0) return [];

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
  console.log(`Trafikverket interpolation: ${announcements.length} aviseringar`);

  const byTrain = {};
  announcements.forEach(ann => {
    const id = ann.AdvertisedTrainIdent;
    if (!id) return;
    if (!byTrain[id]) byTrain[id] = [];
    byTrain[id].push(ann);
  });

  const nowMs = Date.now();
  const trains = [];

  Object.entries(byTrain).forEach(([trainId, anns]) => {
    anns.sort((a, b) => new Date(eventTime(a)) - new Date(eventTime(b)));

    const departed = anns
      .filter(a => a.ActivityType === 'Avgang' && a.TimeAtLocation)
      .at(-1);
    if (!departed) return;

    const nextArr = anns.find(
      a => a.ActivityType === 'Ankomst'
        && !a.TimeAtLocation
        && new Date(eventTime(a)) > new Date(departed.TimeAtLocation)
    );
    if (!nextArr) return;

    const fromCoord = stationCoords[departed.LocationSignature];
    const toCoord   = stationCoords[nextArr.LocationSignature];
    if (!fromCoord || !toCoord) return;
    if (departed.LocationSignature === nextArr.LocationSignature) return;

    const depMs = new Date(departed.TimeAtLocation).getTime();
    const arrMs = new Date(eventTime(nextArr)).getTime();
    if (arrMs <= depMs) return;

    const fraction = (nowMs - depMs) / (arrMs - depMs);
    if (fraction < -0.05 || fraction > 1.1) return;

    const pos  = interpolate(fromCoord, toCoord, fraction);
    const bear = calcBearing(fromCoord, toCoord);

    const products = [].concat(departed.ProductInformation || []);
    const lineName = products
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
      source:        'interpolated',
    });
  });

  console.log(`Trafikverket interpolation: ${trains.length} aktiva tåg`);
  return trains;
}

// ── Exporterad huvudfunktion ────────────────────────────────────

/**
 * Hämta tågpositioner — försöker GPS (TrainPosition) först, sedan interpolation.
 * Resultatcache: 20 s för GPS, 30 s för interpolation.
 */
async function fetchTrainPositions() {
  if (!API_KEY) return [];

  const now = Date.now();
  const ttl = gpsAvailable ? CACHE_TTL : 30000;
  if (_cache.trains && (now - _cache.timestamp) < ttl) return _cache.trains;

  try {
    // Försök GPS-källan om prenumeration kan vara aktiv
    const gpsTrains = await fetchGpsTrainPositions();
    if (gpsTrains !== null) {
      _cache = { trains: gpsTrains, timestamp: Date.now() };
      return gpsTrains;
    }

    // Fallback: interpolerade positioner
    const trains = await fetchInterpolatedTrainPositions();
    _cache = { trains, timestamp: Date.now() };
    return trains;

  } catch (e) {
    console.error('Trafikverket fetch-fel:', e.message);
    return _cache.trains || [];
  }
}

module.exports = { initStations, fetchTrainPositions };
