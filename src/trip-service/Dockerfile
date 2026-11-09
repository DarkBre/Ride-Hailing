FROM node:22-alpine

WORKDIR /app/src/trip-service

COPY src/trip-service/package.json ./
RUN npm install --omit=dev
COPY src/trip-service/*.js ./
COPY services/_shared/amqp.js /app/services/_shared/amqp.js

ENV PORT=8003
ENV NODE_ENV=production

EXPOSE 8003

CMD ["node", "index.js"]
