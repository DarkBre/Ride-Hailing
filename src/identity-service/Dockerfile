FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY config.js db.js auth.js routes.js index.js ./

EXPOSE 8001

CMD ["node", "index.js"]
