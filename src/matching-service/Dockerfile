FROM node:22-bookworm-slim AS build
WORKDIR /service
COPY package*.json ./
RUN npm install
COPY *.ts ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /service
COPY --from=build /service/node_modules ./node_modules
COPY --from=build /service/dist ./dist
COPY schema.sql ./
USER node
EXPOSE 8004
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:'+(process.env.MATCHING_SERVICE_PORT || 8004)+'/ready').then(r=>process.exit(+!r.ok)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
