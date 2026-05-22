FROM node:20

WORKDIR /app

COPY package.json ./
RUN npm install

# Kopiera .env-filen om den existerar i byggnadskontext
COPY .env* ./
# Kopiera övriga filer
COPY . .

# Skapa och se till att datakatalogen finns för GTFS-data
RUN mkdir -p /app/backend/gtfs-data && chown -R node:node /app

# Injicera byggtid som versionsstämpel
RUN echo "{\"version\":\"$(date -u '+%Y-%m-%d %H:%M UTC')\"}" > /app/version.json

EXPOSE 3000
CMD ["npm", "start"]
