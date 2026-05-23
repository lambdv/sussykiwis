FROM oven/bun:1.3.10 AS client-build

WORKDIR /work

# Install client deps first for better caching.
COPY client/package.json client/bun.lock ./client/
RUN cd client && bun install --frozen-lockfile

# Build the Vite client that nginx will serve.
COPY client ./client
RUN cd client && bun run build


FROM rust:1.88-slim AS server-build

WORKDIR /work

# Build the authoritative Rust server in release mode.
COPY server/Cargo.toml server/Cargo.lock ./server/
COPY server/src ./server/src
COPY client/public/assets ./client/public/assets
RUN cargo build --release --manifest-path server/Cargo.toml


FROM nginx:stable AS runtime

WORKDIR /app

# Copy the server binary and built client into the runtime image.
COPY --from=server-build /work/server/target/release/myserver /app/myserver
COPY --from=client-build /work/client/dist /usr/share/nginx/html

# Nginx fronts the Rust server and serves the SPA assets.
COPY container/nginx.conf /etc/nginx/nginx.conf
COPY container/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Rust listens internally on 3000; nginx is the public port in-container.
ENV PORT=3000
EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
