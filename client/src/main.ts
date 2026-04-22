import "./style.css";
import type { ServerMessage } from "./networking/message";
import {
  Engine,
  Scene,
  WebGPUEngine,
} from "@babylonjs/core";

import { createMenuScene } from "./game/scenes/mainMenuScene";
import { createGameScene } from "./game/scenes/gameScene";
import { NetworkClient } from "./networking/client";
import { gameState } from "./state";

export const net = new NetworkClient();

let engine: Engine | WebGPUEngine;
let activeScene: Scene;
let gameSceneResult: ReturnType<typeof createGameScene> | null = null;
let joystickZone: HTMLDivElement;

async function bootstrap() {
  await net.connect();

  const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement | null;
  const joystickZoneEl = document.getElementById("joystickZone") as HTMLDivElement | null;

  if (!canvas || !joystickZoneEl) {
    throw new Error("Missing required canvas or joystick container");
  }
  joystickZone = joystickZoneEl;

  if (await WebGPUEngine.IsSupportedAsync) {
    const webgpuEngine = new WebGPUEngine(canvas, {
      stencil: true,
      antialias: true,
    });
    await webgpuEngine.initAsync();
    engine = webgpuEngine;
  } else {
    engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: true,
      antialias: true,
    });
  }

  const menuScene = createMenuScene(engine);
  activeScene = menuScene;

  engine.runRenderLoop(() => {
    activeScene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });

  net.onMessage((msg: ServerMessage) => {
    if (msg.type === "match") {
      gameState.set("GAME");
    }
  });

  gameState.onChange((state) => {
    switch (state) {
      case "MENU":
        if (gameSceneResult) {
          gameSceneResult.stop();
          gameSceneResult = null;
        }
        activeScene = menuScene;
        joystickZone.style.display = "none";
        break;

      case "QUEUE":
        joystickZone.style.display = "none";
        break;

      case "GAME":
        if (!gameSceneResult) {
          gameSceneResult = createGameScene(engine, joystickZone);
        }
        gameSceneResult.start();
        activeScene = gameSceneResult.scene;
        joystickZone.style.display = "block";
        break;

      case "GAME_END":
        if (gameSceneResult) {
          gameSceneResult.stop();
        }
        activeScene = menuScene;
        joystickZone.style.display = "none";
        gameState.set("MENU");
        break;
    }
  });
}

await bootstrap();

net.sendMessage({ type: "join" });