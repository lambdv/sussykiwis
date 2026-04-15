import "./style.css";
import nipplejs from "nipplejs";
import {
  Engine,
  Scene,
  ArcRotateCamera,
  Vector3,
  Color4,
  HemisphericLight,
  MeshBuilder,
  WebGPUEngine,
  StandardMaterial,
  Color3,
} from "@babylonjs/core";
import GameScene from "./game/scenes/gameScene";
import { NetworkClient } from "./networking/client";

const net = new NetworkClient();

type SceneType = "game" | "mainMenu";

const currentScene = "mainMenu";

async function bootstrap() {
  await net.connect();
  const canvas = document.getElementById(
    "renderCanvas",
  ) as HTMLCanvasElement | null;

  const joystickZone = document.getElementById(
    "joystickZone",
  ) as HTMLDivElement | null;

  if (!canvas || !joystickZone) {
    throw new Error("Missing required canvas or joystick container");
  }

  let engine: Engine | WebGPUEngine;

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

  const gameScene = GameScene(engine, joystickZone);

  window.addEventListener("resize", () => {
    engine.resize();
  });
}

await bootstrap();

await net.sendMessage({ type: "join" });
