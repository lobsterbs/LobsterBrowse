# Scramjet proxy instance for LobsterBrowse.
# Builds the upstream MercuryWorkshop/Scramjet-App (AGPL) with a single
# patched file (public/index.js) that adds ?url= embedding support.
FROM node:22-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/MercuryWorkshop/Scramjet-App.git /app
WORKDIR /app
COPY public/index.js ./public/index.js
RUN corepack enable && pnpm install --no-frozen-lockfile
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/index.js"]
