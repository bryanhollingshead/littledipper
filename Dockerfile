# Little Dipper: one image, API + web app. Data lives in /data (mount a volume).
FROM node:22-alpine AS build
# Compilers for better-sqlite3, in case no prebuilt binary matches. Build stage only.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4000 LD_DATA_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# `docker exec little-dipper little-dipper claim-link`
RUN chmod +x server/dist/cli.js && ln -s /app/server/dist/cli.js /usr/local/bin/little-dipper
VOLUME /data
EXPOSE 4000
HEALTHCHECK CMD wget -qO- http://localhost:4000/api/v1/node/status || exit 1
CMD ["node", "server/dist/server.js"]
