import { Engine, Scene, WebGPUEngine } from "@babylonjs/core";
import { createMenuScene } from "../game/scenes/mainMenuScene";
import { createGameScene } from "../game/scenes/gameScene";
import { NetworkClient } from "../networking/client";
import { createQueueScene } from "../game/scenes/queueScene";

export type AppState = "menu" | "queue" | "game";

export class App {
  private router: Router;

  constructor(engine: Engine | WebGPUEngine, canvas: HTMLCanvasElement) {
    // Keep a single router instance that owns state transitions.
    this.router = new Router(engine, canvas);
  }

  start() {
    // Start the app at the main menu scene.
    this.router.goTo("menu");
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

  constructor(
    private engine: Engine | WebGPUEngine,
    private canvas: HTMLCanvasElement,
  ) {}

  goTo(key: AppState) {
    // Bump the token so stale async work from prior routes is ignored.
    this.transitionToken += 1;
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

      case "game":
        this.currentScene = createGameScene(this.engine, this.canvas);
        break;
    }
  }

  private async joinAndEnterGame(token: number) {
    try {
      // Open WS connection to the Rust server before joining.
      await this.network.connect();

      // If route changed while connecting, stop this stale transition.
      if (token !== this.transitionToken || this.state !== "queue") return;

      // Send the server join request and immediately continue to game.
      this.network.sendMessage({ type: "join" });
      this.goTo("game");
    } catch (error) {
      // On handshake failure, return user to menu safely.
      console.error("Failed to join game:", error);
      if (token === this.transitionToken && this.state === "queue") {
        this.goTo("menu");
      }
    }
  }

  render() {
    // Draw the active scene if one exists.
    this.currentScene?.render();
  }
}
