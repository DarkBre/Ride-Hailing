FROM node:22-bookworm-slim AS build
WORKDIR /service
COPY package.json ./
RUN npm install
COPY index.ts reservations.ts ./
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /service
COPY --from=build /service/node_modules ./node_modules
COPY --from=build /service/dist ./dist
COPY schema.sql ./
USER node
EXPOSE 8002
CMD ["node", "dist/index.js"]
