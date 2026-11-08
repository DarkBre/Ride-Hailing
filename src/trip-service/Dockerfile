FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY . .

ENV PORT=8003
ENV NODE_ENV=production

EXPOSE 8003

CMD ["node", "index.js"]
