### Build client + server, run as one container behind nginx.

FROM oven/bun:1.3.10 AS client-build

WORKDIR /work

# Install deps first for better layer caching.
COPY client/package.json client/bun.lock ./client/
RUN cd client && bun install --frozen-lockfile

# Build the Vite app.
COPY client ./client

# Build-time env for the client so it can talk to the same-origin nginx `/api`.
# NOTE: Vite only exposes variables prefixed with `VITE_` to the client bundle.
ENV VITE_SERVER_URI=http://localhost/api/
RUN cd client && bun run build


FROM rust:1.87-slim AS server-build

WORKDIR /work

# Build the Rust server (release).
COPY server/Cargo.toml server/Cargo.lock ./server/
COPY server/src ./server/src
RUN cargo build --release --manifest-path server/Cargo.toml


FROM nginx:stable AS runtime

WORKDIR /app

# Server binary.
COPY --from=server-build /work/server/target/release/myserver /app/myserver

# Built client dist served by nginx.
COPY --from=client-build /work/client/dist /usr/share/nginx/html

# Nginx config + entrypoint.
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Rust server listens on `PORT` internally; nginx listens on 80.
ENV PORT=3000
EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
