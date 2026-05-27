# Agents
project code name: 'sussy kiwis' is a among us clone video game where you can play on a mobile phones through web browsers

## Code Map

- `client/`: BabylonJS + TypeScript view layer.
- `server/`: Rust + Axum authoritative game server.
- `docs/spec/`: game rules and vertical slice notes.
- `docker/`: nginx and compose setup.

## Main Flow

- `client/src/main.ts`: boots engine and chooses WebGPU/WebGL.
- `client/src/app/app.ts`: scene router and app state transitions.
- `client/src/game/scenes/`: menu, queue, match, meeting, win, and observer scenes.
- `client/src/game/puzzles/`: task interactions and puzzle scenes.
- `client/src/networking/`: client transport and message types.
- `server/src/main.rs`: loads env and starts the server.
- `server/src/server.rs`: HTTP routes, websocket handling, and game loop wiring.
- `server/src/lobby/`: authoritative simulation, lobby state, and protocol models.

## What Things Do

- Client scenes render UI and send player input.
- Server simulation validates input and broadcasts state changes.
- Websocket messages connect the two and carry game events.
- don't use docker, use locally cargo and bun to do things not docker

## Coding guidelines:
- document all code you make with inline comments for unit blocks explaining what it does
- don't be verbose: write minimal amount of code and clean code
- modules must be deep, not shallow modules
- don't create new target folders in rust server, if its being blocked still don't make a new compiled target
- code must be server side and authaotive to the server, client is just a view
