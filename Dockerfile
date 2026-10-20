# Hosted build of the server (`acctd`) with the web app embedded. Used by fly.toml.

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
RUN pnpm --filter web build

FROM rust:1-bookworm AS server
WORKDIR /src
COPY . .
COPY --from=web /src/apps/web/dist apps/web/dist
RUN cargo build --release --locked -p acct-server --bin acctd --features embed-web

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=server /src/target/release/acctd /usr/local/bin/acctd
ENV ACCT_BIND=0.0.0.0:8080 ACCT_DB=/data/acct.db
EXPOSE 8080
CMD ["acctd"]
