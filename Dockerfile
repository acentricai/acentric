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
#
# It is built for amd64 and arm64 alike. What is the same for both (the machine program for
# every system, the TypeScript, the dashboard and the command) is built once, on the system
# that builds, and only what the server runs with is installed for the system it is for:
#
#   docker buildx build --platform linux/amd64,linux/arm64 .

# The machine program: what is installed on a computer actors' commands run on. One file for
# each system a machine may be, all built here, on whatever this image is built on: zig links
# for the others. The Linux ones are static, and run on any distribution.
FROM --platform=$BUILDPLATFORM rust:1.97-slim AS machine
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

# The machine program for the system an image is built for, and no other.
FROM machine AS machine-here
ARG TARGETARCH
RUN cp "/out/linux-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH")" /machine

# A sandbox: what a server makes machines from at Docker. It is not part of the server's
# image, and is built by naming it:
#
#   docker build --target sandbox -t acentric-sandbox .
#
# and given to the server as ACENTRIC_DOCKER_IMAGE. It is a small Debian with the machine
# program, which enrols with what the server puts in the sandbox, and connects. An image of
# your own does as well, built FROM this one, or any that has a user `user` of ID 1000 whose
# home is /home/user, the machine program as `acentric-machine`, and this start-up.
FROM debian:stable-slim AS sandbox
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash user
COPY --from=machine-here --chmod=755 /machine /usr/local/bin/acentric-machine
COPY --chmod=755 deploy/sandbox/boot /usr/local/lib/acentric/boot
USER user
ENV HOME=/home/user
WORKDIR /home/user
CMD ["/usr/local/lib/acentric/boot"]

# The TypeScript, the dashboard and the command: the same files whatever the image is for.
FROM --platform=$BUILDPLATFORM node:26-slim AS build
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
COPY apps/dashboard/package.json apps/dashboard/
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps apps
COPY scripts scripts
RUN pnpm build && pnpm --filter @acentric/dashboard build

# What was built, without what it was built with: the packages are installed again below, for
# the system the image is for.
RUN mkdir /built \
    && for dir in packages/* apps/*; do \
         mkdir -p "/built/$dir" && tar --exclude=node_modules -C "$dir" -cf - . | tar -xf - -C "/built/$dir"; \
       done

# The server alone, with what it needs to run and nothing it was built with. Installed for the
# system the image is for: workerd and esbuild are a binary of that system's.
FROM node:26-slim AS deploy
WORKDIR /repo
RUN npm install --global pnpm@12.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /built .
RUN pnpm --filter @acentric/server deploy --prod --legacy /out

FROM node:26-slim AS server
ENV NODE_ENV=production \
    ACENTRIC_HOST=0.0.0.0 \
    ACENTRIC_PORT=4000 \
    ACENTRIC_DATA=/data \
    ACENTRIC_DOWNLOADS=/app/downloads \
    ACENTRIC_DASHBOARD=/app/dashboard
# What workerd checks the sites agents' code calls against: the slim image has none.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deploy /out .
# The dashboard of this build, which the server serves beside the API.
COPY --from=build /repo/apps/dashboard/dist dashboard/
# The acentric command of this build, which the server hands out at /install-cli.sh.
COPY --from=build /repo/apps/cli/install.sh downloads/install-cli.sh
COPY --from=build /repo/apps/cli/dist/acentric.mjs downloads/
# The machine program of this build, which the server hands out at /install.sh.
COPY --from=build /repo/apps/machine/install.sh downloads/install.sh
COPY --from=machine /out downloads/machine/
# The server's program by its name, for its commands: `acentric-server backup`, `restore` and
# `reset-link`, run in the container beside the server.
RUN chmod +x dist/bin.js && ln -s /app/dist/bin.js /usr/local/bin/acentric-server
# /data is what the server keeps. /backups is for its backups, when a volume of their own is put
# there (ACENTRIC_BACKUP_DIR=/backups): a volume Docker makes is owned as the folder it is on.
RUN mkdir /data /backups && chown node:node /data /backups
VOLUME /data
EXPOSE 4000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.ACENTRIC_PORT + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/bin.js"]
