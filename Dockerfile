# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22.14.0

FROM node:${NODE_VERSION}-bookworm-slim AS build-deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts && \
    npm rebuild esbuild sharp

# Keep the large upstream Codex Desktop download in a layer that is invalidated
# only when the preparation scripts, assets, or patches change.
FROM build-deps AS webview

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      patch \
      unzip \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/prepare scripts/prepare_asar ./scripts/
COPY assets ./assets
COPY patches ./patches
RUN PATH="/app/node_modules/.bin:${PATH}" ./scripts/prepare

FROM build-deps AS builder

COPY --from=webview /app/scratch ./scratch
COPY src ./src
COPY vite.browser.config.ts ./

RUN npm run build:browser && npm run build:auth-css && npm run build:server

# Install only production dependencies in a separate stage. Build tools stay
# out of the final image even if a native module has to compile from source.
FROM node:${NODE_VERSION}-bookworm-slim AS production-deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      g++ \
      make \
      python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG CODEX_VERSION=0.153.2

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      openssh-client \
      ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}"

ENV NODE_ENV=production \
    CODEX_HOME=/home/node/.codex \
    CODEX_CLI_PATH=/usr/local/bin/codex \
    CODEX_AUTH_CLI_PATH=/usr/local/bin/codex

RUN mkdir -p /opt/codex-web /home/node/.codex /var/lib/codex-web /workspace \
    && chown -R node:node /home/node/.codex /var/lib/codex-web /workspace

COPY --from=production-deps --chown=node:node /app/node_modules /opt/codex-web/node_modules
COPY --from=builder --chown=node:node /app/package.json /opt/codex-web/package.json
COPY --from=builder --chown=node:node /app/src/server /opt/codex-web/src/server
COPY --from=builder --chown=node:node /app/scratch/asar /opt/codex-web/scratch/asar

USER node
WORKDIR /workspace

EXPOSE 8214

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8214/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/opt/codex-web/src/server/main.js"]
CMD ["--host", "0.0.0.0", "--port", "8214"]
