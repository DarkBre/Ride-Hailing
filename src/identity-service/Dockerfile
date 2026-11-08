FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY . .

ENV PORT=8001
ENV NODE_ENV=production

EXPOSE 8001

CMD ["node", "index.js"]
