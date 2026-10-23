# Hosted build of the server (`acctd`) with the web app embedded, plus Litestream for continuous
# backup (ADR 008). Used by fly.toml (production) and fly.staging.toml.

FROM node:24-bookworm-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/types/package.json packages/types/
RUN pnpm install --frozen-lockfile
COPY apps/web apps/web
COPY packages/types packages/types
COPY config.env* ./
# Each fly config passes these, so staging and production get their own address. An unset one is
# dropped, so a local config.env still applies.
ARG SITE_URL=""
ARG SITE_GATE=""
RUN if [ -z "$SITE_URL" ]; then unset SITE_URL; fi; \
    if [ -z "$SITE_GATE" ]; then unset SITE_GATE; fi; \
    pnpm --filter web build

FROM rust:1-bookworm AS server
WORKDIR /src
COPY . .
COPY --from=web /src/apps/web/dist apps/web/dist
RUN cargo build --release --locked -p acct-server --bin acctd --features embed-web

# Litestream's official image, pinned. Its binary is static, so it runs on the slim image below.
FROM litestream/litestream:0.5.17 AS litestream

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=server /src/target/release/acctd /usr/local/bin/acctd
COPY litestream.yml /etc/litestream.yml
COPY scripts/fly-entrypoint.sh /usr/local/bin/fly-entrypoint
# Strip Windows line endings in case the script was checked out on Windows.
RUN sed -i 's/\r$//' /usr/local/bin/fly-entrypoint /etc/litestream.yml \
    && chmod +x /usr/local/bin/fly-entrypoint
ENV ACCT_BIND=0.0.0.0:8080 ACCT_DB=/data/acct.db
EXPOSE 8080
CMD ["fly-entrypoint"]
