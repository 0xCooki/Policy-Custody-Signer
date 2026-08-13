FROM node:25-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    softhsm2 \
    opensc \
    ca-certificates \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN npm install -g pnpm@11.18.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN chmod +x scripts/init-softhsm.sh scripts/docker-entrypoint.sh \
  && pnpm build

ENV SIGNER_BACKEND=softhsm \
    SOFTHSM_DATA_DIR=/data/softhsm \
    SOFTHSM_PIN=1234 \
    SOFTHSM_KEY_LABEL=custody-eth \
    DATABASE_PATH=/data/custody.db \
    PORT=3000

VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["node", "dist/api/index.js"]
