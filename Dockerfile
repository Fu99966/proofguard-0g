# Optional, non-recommended container build. The recommended installation uses npm locally.
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
COPY sdk ./sdk
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production PORT=8080
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY sdk ./sdk
COPY examples/rebalancer/short-acceptance.js examples/rebalancer/rejection.js ./examples/rebalancer/
RUN install -d -o node -g node -m 700 /app/var
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080

CMD ["node", "server/index.js"]

