FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY config.js db.js geo.js pricing-engine.js outbox.js saga-coordinator.js routes.js index.js ./

EXPOSE 8003

CMD ["node", "index.js"]
