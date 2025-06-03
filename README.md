# X-trafik GTFS Realtime Map

En webapplikation som visar realtidspositioner för X-trafiks kollektivtrafikfordon på en interaktiv karta.

## Funktioner

- Visar fordon i realtid på en interaktiv karta
- Extraherar och visar busslinje-/tågnummer baserat på fordons-ID
- Färgkodning av ikoner baserat på GTFS-ruttsdata (återspeglar X-trafiks officiella färger)
- Visning av riktningsindikatorer för fordon i rörelse
- Filtrering av fordon baserat på linjenummer
- Automatisk uppdatering av positioner var 15:e sekund
- Informationsrutor med detaljer om varje fordon inklusive rutt, linjenummer och destination

## Teknik

- **Backend**: Node.js med Express
- **Fordonsinformation**: GTFS Realtime Protobuf via X-trafik API
- **Frontend**: HTML, JavaScript, Leaflet.js för kartan
- **Driftsättning**: Docker och Docker Compose
- **GTFS-data**: Integration med Samtrafikens statiska GTFS-dataAPI

## Kör projektet

1. Skapa en `.env`-fil i projektets rotkatalog med dina API-nycklar:
   ```
   API_KEY=din_xtrafik_realtids_api_nyckel_här
   GTFS_API_KEY=din_gtfs_statiska_data_api_nyckel_här
   ```
   
   Notera att du behöver två olika API-nycklar:
   - `API_KEY` används för realtidsdata (VehiclePositions.pb)
   - `GTFS_API_KEY` används för den statiska GTFS-datan (xt.zip) som laddas ner veckovis

2. Starta applikationen med Docker Compose:
   ```
   docker-compose up --build
   ```

3. Besök `http://localhost:3000` i din webbläsare

## Fordons-ID och bussnummer

Applikationen använder flera metoder för att visa korrekta bussnummer:

1. **Statisk GTFS-data integration**: Applikationen laddar ner och parsar statisk GTFS-data från X-trafik för att få exakta mappningar mellan route_id, trip_id, block_id och bussnummer.

2. **Fallback med fordons-ID-analys**: Om GTFS-data inte kan användas, analyseras fordons-ID för att extrahera bussnummer. X-trafiks fordons-ID kan ha olika format:
   - För kortare ID (≤8 tecken): Använder de första två siffrorna som linjenummer
   - För längre ID (>10 tecken): Extraherar linjenummer från mittendelen av ID:t (position 8-10)
   - Fallback: Använder de första två siffrorna från de sista 6 siffrorna i ID:t

## GTFS Data Integration

Systemet använder statisk GTFS-data från Samtrafiken för att korrekt mappa mellan fordons-ID och bussnummer samt för att visa korrekt färgkodning:

- **Automatisk nedladdning**: Data laddas automatiskt från `https://opendata.samtrafiken.se/gtfs/xt/xt.zip`
- **Veckovis uppdatering**: GTFS-data uppdateras automatiskt var 7:e dag för att hålla under API-gränsen på 50 anrop/månad
- **Datastruktur**: Systemet parsar `routes.txt` och `trips.txt` för att skapa mappningar
- **Färg & stilinformation**: Systemet använder `route_color` och `route_text_color` från GTFS-data för att visa fordon med korrekta X-trafik färger
- **Detaljerad ruttinformation**: Information från GTFS-data visas i fordonsinfo-popups
- **API-användningshantering**: Spårar API-användning för att inte överstiga gränserna
- **Diagnostik**: Besök `/status` för att se status på GTFS-datan och API-användning
- **Manuell uppdatering**: Besök `/admin/refresh-gtfs` för att tvinga en omedelbar uppdatering av GTFS-data (varning: använder ett API-anrop)

### Testning av GTFS-data

För att testa GTFS-dataintegrationen, kör:
```
node backend/test-gtfs-loader.js
```

### Utvecklarläge och mockdata
Om du inte har tillgång till en giltig API-nyckel, kan systemet generera simulerad GTFS-data för utveckling och testning. 
Detta aktiveras automatiskt om ingen giltig API-nyckel finns eller API-anrop misslyckas.

## API Reference

Systemet erbjuder följande API-endpoints för integration och utveckling:

### `/api/vehicles`

- **Beskrivning**: Hämtar realtidsdata om alla fordon som för närvarande är i trafik
- **Metod**: GET
- **Resultatformat**: JSON-array med fordonsobjekt
- **Exempelrespons**:
  ```json
  [
    {
      "position": {
        "latitude": 60.674,
        "longitude": 17.141,
        "bearing": 153,
        "speed": 7.5
      },
      "timestamp": "1748886319",
      "vehicle": {
        "id": "9031021001271563"
      },
      "trip": {
        "tripId": "217990000039612547",
        "scheduleRelationship": "SCHEDULED"
      },
      "busNumber": "12",
      "routeId": "9011021001200000",
      "routeColor": "#772233",
      "routeTextColor": "#FFFFFF",
      "routeLongName": "Centrum - Stigslund",
      "routeInfo": {
        "shortName": "12",
        "longName": "Centrum - Stigslund",
        "agency": "xtrafik",
        "type": 3,
        "color": "772233",
        "textColor": "FFFFFF"
      }
    }
  ]
  ```

### `/api/gtfs-status`

- **Beskrivning**: Returnerar statusinformation om GTFS-data
- **Metod**: GET
- **Resultatformat**: JSON-objekt med statusinformation
- **Exempelrespons**:
  ```json
  {
    "loaded": true,
    "stats": {
      "routes": 96,
      "trips": 7255,
      "blocks": 0
    },
    "examples": {
      "routes": [
        {
          "id": "9011021001900000",
          "busNumber": "19",
          "color": "#000000",
          "textColor": "#FFFFFF",
          "longName": ""
        }
      ]
    },
    "downloadMetadata": {
      "lastUpdateTime": 1748887091552,
      "downloadCount": 6,
      "lastDownload": "2025-06-02T17:58:12.139Z",
      "monthlyLimit": 50,
      "nextScheduledUpdate": "2025-06-09T17:58:11.552Z"
    },
    "usingMockData": false
  }
  ```

### `/admin/refresh-gtfs`

- **Beskrivning**: Tvingar en manuell uppdatering av GTFS-data
- **Metod**: GET
- **Anmärkning**: Använder ett av dina månatliga API-anrop mot Samtrafiken
- **Resultatformat**: JSON-objekt med statusinformation
- **Exempelrespons**:
  ```json
  {
    "status": "success",
    "message": "GTFS-data uppdaterad"
  }
  ```

## Övervaka API-användning

För att övervaka API-användning och kontrollera att veckogränsen respekteras:

1. Besök statusportalen på `http://localhost:3000/status`
2. Kontrollera `API-anrop hittills` och `Nästa schemalagda nedladdning`
3. Metadata lagras i `backend/gtfs-metadata.json`

## Optimeringsförslag för framtida utveckling
- Implementera markerkluster för bättre prestanda med många fordon
- Lagra tidigare fordonspositioner för att visa rutter
- Implementera sökfunktion för specifika områden eller hållplatser
- Visa information om nästa hållplats och avgångstid från statisk GTFS-data
- Integrera tidtabellsdata från GTFS för att visa förseningar
