FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
ENV PORT=8006
ENV NOTIFICATION_SERVICE_PORT=8006

EXPOSE 8006

CMD ["node", "index.js"]
