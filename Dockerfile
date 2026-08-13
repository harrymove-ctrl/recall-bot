FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY drizzle.config.ts ./
COPY src/ ./src/
COPY tests/ ./tests/
COPY dashboard-web/ ./dashboard-web/
COPY public/ ./public/
COPY build-dashboard.mjs ./

RUN npm run build

FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/public/ ./public/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY package.json ./

EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "dist/server.js"]
