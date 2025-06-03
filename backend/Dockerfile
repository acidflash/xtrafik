FROM node:14

WORKDIR /app

COPY package.json ./
RUN npm install

# Kopiera .env-filen om den existerar i byggnadskontext
COPY .env* ./
# Kopiera övriga filer
COPY . .

# Skapa och se till att datakatalogen finns för GTFS-data
RUN mkdir -p /app/backend/gtfs-data && chown -R node:node /app

EXPOSE 3000
CMD ["npm", "start"]
