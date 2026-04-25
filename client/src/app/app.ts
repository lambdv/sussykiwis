import { Engine, WebGPUEngine, Scene } from "@babylonjs/core";
import { createMenuScene } from "../game/scenes/mainMenuScene";
import { createGameScene } from "../game/scenes/gameScene";
import { NetworkClient } from "../networking/client";
import { createQueueScene } from "../game/scenes/queueScene";

export type AppState = "title" | "queue" | "game" | "menu";

export class App {
  router: Router;
  network: NetworkClient;
  constructor(_engine: Engine | WebGPUEngine, _canvas: HTMLCanvasElement) {
    this.router = new Router(_engine, _canvas);
    this.network = new NetworkClient();
  }
  start() {
    this.router.goTo("menu");
  }
  tick() {
    this.router.render();
  }
}

export class Router {
  private currentScene: Scene | null = null;
  constructor(
    private engine: Engine | WebGPUEngine,
    private canvas: HTMLCanvasElement,
  ) {}

  goTo(key: AppState) {
    this.currentScene?.dispose();

    switch (key) {
      case "menu":
        this.currentScene = createMenuScene(this.engine, {
          onPlay: () => this.goTo("queue"),
        });
        break;

      case "queue":
        this.currentScene = createQueueScene(this.engine, {
          onMatchFound: () => this.goTo("game"),
          onCancel: () => this.goTo("menu"),
        });
        break;

      case "game":
        this.currentScene = createGameScene(this.engine);
        break;
    }
  }

  render() {
    this.currentScene?.render();
  }
}
