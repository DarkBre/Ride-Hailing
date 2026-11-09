FROM node:22-bookworm-slim
WORKDIR /app/src/payment-service
COPY src/payment-service/package.json ./
RUN npm install --omit=dev
COPY src/payment-service/index.js src/payment-service/schema.sql ./
COPY services/_shared/amqp.js /app/services/_shared/amqp.js
USER node
EXPOSE 8005
CMD ["node", "index.js"]
