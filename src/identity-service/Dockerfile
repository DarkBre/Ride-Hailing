FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY . .
RUN mkdir -p /app/data && chown node:node /app/data && chmod 0700 /app/data
USER node

ENV PORT=8001
ENV NODE_ENV=production

EXPOSE 8001

CMD ["node", "index.js"]
