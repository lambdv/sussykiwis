import { Engine, Scene, WebGPUEngine } from "@babylonjs/core";
import { createMenuScene } from "../game/scenes/mainMenuScene";
import { createGameScene } from "../game/scenes/gameScene";
import { createPreMatchScene } from "../game/scenes/preMatchScene";
import { createServerViewScene } from "../game/scenes/serverViewScene";
import { createMeetingScene } from "../game/scenes/meetingScene";
import { createEjectedScene } from "../game/scenes/ejectedScene";
import { createNoEjectionScene } from "../game/scenes/noEjectionScene";
import { createWinScene } from "../game/scenes/winScene";
import { NetworkClient } from "../networking/client";
import type { PlayerRole } from "../networking/message";
import { createQueueScene } from "../game/scenes/queueScene";

export type AppState = "menu" | "queue" | "preMatch" | "game" | "meeting" | "ejected" | "noEjection" | "win" | "serverView";

export class App {
  private router: Router;

  constructor(
    engine: Engine | WebGPUEngine,
    canvas: HTMLCanvasElement,
    private initialState: AppState = "menu",
  ) {
    // Keep a single router instance that owns state transitions.
    this.router = new Router(engine, canvas);
  }

  async start() {
    // Start the app at the requested route.
    await this.router.goTo(this.initialState);
  }

  tick() {
    // Render the currently active scene each frame.
    this.router.render();
  }
}

export class Router {
  // Track the live Babylon scene so we can dispose it on transition.
  private currentScene: Scene | null = null;

  // Keep connection state local to the router so all scenes share one socket.
  private network = new NetworkClient();

  // Track the current route and transition token for async safety.
  private state: AppState = "menu";
  private transitionToken = 0;
  private localPlayerId: string | null = null;
  private localRole: PlayerRole | null = null;

  constructor(
    private engine: Engine | WebGPUEngine,
    private canvas: HTMLCanvasElement,
  ) {
    // Persist private session messages even when a scene-specific listener is not active.
    this.network.onMessage((message) => {
      if (message.type === "game_started") {
        this.localRole = message.role;
      }
    });
  }

  async goTo(key: AppState): Promise<void> {
    // Bump the token so stale async work from prior routes is ignored.
    this.transitionToken += 1;

    // Reset the shared socket when switching between player and spectator modes.
    if (this.state === "serverView" || key === "serverView") {
      this.network.disconnect();
    }

    this.state = key;

    // Dispose previous scene before constructing the new route scene.
    this.currentScene?.dispose();

    switch (key) {
      case "menu":
        this.currentScene = createMenuScene(this.engine, {
          onPlay: () => this.goTo("queue"),
        });
        break;

      case "queue":
        this.currentScene = createQueueScene(this.engine, {
          onEnter: () => {
            // Start the join handshake while queue scene is shown.
            void this.joinAndEnterGame(this.transitionToken);
          },
        });
        break;

      case "preMatch":
        this.currentScene = await createPreMatchScene(
          this.engine,
          this.canvas,
          this.network,
          this.localPlayerId,
          {
            onMatchReady: () => {
              // Enter the gameplay scene once server marks sub-state as in-game.
              if (this.state === "preMatch") {
                void this.goTo("game");
              }
            },
          },
        );
        break;

      case "game":
        this.currentScene = await createGameScene(
          this.engine,
          this.canvas,
          this.network,
          this.localPlayerId,
          this.localRole,
        );
        break;

      case "meeting":
        this.currentScene = await createMeetingScene(this.engine, this.canvas, this.network, this.localPlayerId, {
          onResolved: (next) => void this.goTo(next),
        });
        break;

      case "ejected":
        this.currentScene = createEjectedScene(this.engine, this.canvas, this.network, this.localPlayerId, {
          onDone: () => void this.goTo("game"),
        });
        break;

      case "noEjection":
        this.currentScene = createNoEjectionScene(this.engine, this.canvas, this.network, this.localPlayerId, {
          onDone: () => void this.goTo("game"),
        });
        break;

      case "win":
        this.currentScene = createWinScene(this.engine, this.canvas, this.network, this.localPlayerId, {
          onDone: () => void this.goTo("menu"),
        });
        break;

      case "serverView":
        this.currentScene = createServerViewScene(this.engine, this.network);
        void this.joinAndEnterServerView(this.transitionToken);
        break;
    }
  }

  private async joinAndEnterGame(token: number) {
    try {
      // If route changed while connecting, stop this stale transition.
      if (token !== this.transitionToken || this.state !== "queue") return;

      // Join the authoritative game as a player and capture the server identity.
      const welcome = await this.network.join();

      // If route changed while connecting, stop this stale transition.
      if (token !== this.transitionToken || this.state !== "queue") return;

      // Keep the player id for later world scenes.
      this.localPlayerId = welcome.playerId;
      await this.goTo("preMatch");
    } catch (error) {
      // On handshake failure, return user to menu safely.
      console.error("Failed to join game:", error);
      if (token === this.transitionToken && this.state === "queue") {
        this.goTo("menu");
      }
    }
  }

  private async joinAndEnterServerView(token: number) {
    try {
      // Join the projector session as a non-playing spectator.
      await this.network.join({ name: "Spectator", spectator: true });

      // Stop if the route changed before the welcome packet arrived.
      if (token !== this.transitionToken || this.state !== "serverView") return;
    } catch (error) {
      // Fall back to the menu if the observer handshake fails.
      console.error("Failed to join server view:", error);
      if (token === this.transitionToken && this.state === "serverView") {
        void this.goTo("menu");
      }
    }
  }

  render() {
    // Draw the active scene if one exists.
    this.currentScene?.render();
  }
}
