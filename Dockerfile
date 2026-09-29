FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY prisma.config.js ./
COPY prisma ./prisma
RUN npm run db:generate

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY prisma.config.js ./
COPY prisma ./prisma
COPY src ./src
COPY schemas ./schemas
USER node
CMD ["node", "src/index.js"]