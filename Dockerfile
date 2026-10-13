FROM node:24-bookworm-slim AS hdr-tools
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git cmake ninja-build build-essential nasm perl
COPY native/hdr-avif /build/native/hdr-avif
COPY external/libavif /build/external/libavif
COPY scripts/generate-hdr-profile.js /build/scripts/generate-hdr-profile.js
COPY src/hdr-profile.js /build/src/hdr-profile.js
COPY package.json /build/package.json
RUN cmake -S /build/native/hdr-avif -B /build/output -G Ninja -DCMAKE_BUILD_TYPE=Release \
	&& cmake --build /build/output --target renobot_hdr --parallel 2 \
	&& mkdir -p /opt/hdr/bin \
	&& cp /build/output/discord_hdr /opt/hdr/bin/discord_hdr

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY prisma.config.js ./
COPY prisma ./prisma
RUN npm run db:generate

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HDR_CONVERTER_PATH=/opt/hdr/bin/discord_hdr
WORKDIR /app
COPY --from=hdr-tools /opt/hdr/bin/discord_hdr /opt/hdr/bin/discord_hdr
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY prisma.config.js ./
COPY prisma ./prisma
COPY src ./src
COPY schemas ./schemas
USER node
CMD ["node", "src/index.js"]