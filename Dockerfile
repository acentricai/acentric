# The Acentric server.
#
#   docker build -t acentric-server .
#   docker run -p 4000:4000 -v acentric-data:/data \
#     -e ACENTRIC_ADMIN_KEY=<24 characters or more> \
#     -e ACENTRIC_SECRET_KEY=<32 bytes, as 64 hex characters or as base64> \
#     acentric-server
#
# It keeps everything it has in /data: mount a volume there, or it is gone with the container.
# ACENTRIC_ADMIN_KEY is the API key that may do everything, which other keys are made with.
# Without it, a server that has no key yet makes one and prints it once. ACENTRIC_SECRET_KEY
# is what agents' secrets are sealed with: without it the server keeps no secrets. Every
# setting is in apps/server/src/settings.ts.
#
# The image is built on Debian, not Alpine: agents' code runs in workerd, which has no build
# for Alpine's C library.

# The machine program: what is installed on a computer actors' commands run on. One file for
# each system a machine may be, all built here, on whatever this image is built on: zig links
# for the others. The Linux ones are static, and run on any distribution.
FROM rust:1.97-slim AS machine
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir --break-system-packages --resume-retries 5 \
         cargo-zigbuild==0.24.0 ziglang==0.16.0
WORKDIR /repo
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
RUN rustup target add \
      x86_64-unknown-linux-musl aarch64-unknown-linux-musl \
      x86_64-apple-darwin aarch64-apple-darwin
COPY apps/machine apps/machine
RUN cargo zigbuild --release --locked --package acentric-machine \
      --target x86_64-unknown-linux-musl --target aarch64-unknown-linux-musl \
      --target x86_64-apple-darwin --target aarch64-apple-darwin \
    && mkdir /out \
    && cp target/x86_64-unknown-linux-musl/release/acentric-machine /out/linux-x64 \
    && cp target/aarch64-unknown-linux-musl/release/acentric-machine /out/linux-arm64 \
    && cp target/x86_64-apple-darwin/release/acentric-machine /out/darwin-x64 \
    && cp target/aarch64-apple-darwin/release/acentric-machine /out/darwin-arm64

FROM node:26-slim AS build
WORKDIR /repo
RUN npm install --global pnpm@12.15.0

# The packages' own files first, so that what they depend on is fetched once and kept.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/agent/package.json packages/agent/
COPY packages/ai/package.json packages/ai/
COPY packages/client/package.json packages/client/
COPY packages/core/package.json packages/core/
COPY packages/store/package.json packages/store/
COPY packages/executor/package.json packages/executor/
COPY packages/sandbox/package.json packages/sandbox/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps apps
COPY scripts scripts
RUN pnpm build

# The server alone, with what it needs to run and nothing it was built with.
RUN pnpm --filter @acentric/server deploy --prod --legacy /out

FROM node:26-slim
ENV NODE_ENV=production \
    ACENTRIC_HOST=0.0.0.0 \
    ACENTRIC_PORT=4000 \
    ACENTRIC_DATA=/data \
    ACENTRIC_DOWNLOADS=/app/downloads
# What workerd checks the sites agents' code calls against: the slim image has none.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out .
# The acentric command of this build, which the server hands out at /install-cli.sh.
COPY --from=build /repo/apps/cli/install.sh downloads/install-cli.sh
COPY --from=build /repo/apps/cli/dist/acentric.mjs downloads/
# The machine program of this build, which the server hands out at /install.sh.
COPY --from=build /repo/apps/machine/install.sh downloads/install.sh
COPY --from=machine /out downloads/machine/
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 4000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.ACENTRIC_PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/bin.js"]
