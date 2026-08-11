# Single-container relay. Not built in this environment (no Docker available) —
# see DECISIONS.md. Node 22+ is required for the built-in node:sqlite module.
FROM node:22-slim AS build
WORKDIR /app
COPY shared ./shared
COPY relay ./relay
COPY package.json ./
WORKDIR /app/shared
RUN npm install && npm run build
WORKDIR /app/relay
RUN npm install && npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/relay/dist ./relay/dist
COPY --from=build /app/relay/package.json ./relay/package.json
WORKDIR /app/relay
RUN npm install --omit=dev
ENV NODE_ENV=production
ENV PORT=8787
ENV RELAY_DB_PATH=/data/relay.sqlite
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "dist/index.js"]
