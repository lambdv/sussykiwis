# Docker

## What You Get

- Single container
- Nginx serves the built client at `/`
- Nginx proxies the Rust server at `/api/*`

## Run

Build and run with compose:

```sh
docker compose up --build
```

Then open:

- `http://localhost:8080/`

The server is available through nginx at:

- `http://localhost:8080/api/health`
- websocket: `ws://localhost:8080/api/ws`
