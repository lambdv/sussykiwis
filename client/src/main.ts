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
  engine.runRenderLoop(() => {
    const deltaSeconds = engine.getDeltaTime() / 1000;

    // Flatten camera forward direction onto XZ so movement stays on the ground plane.
    const forward = camera.getForwardRay().direction;
    forward.y = 0;
    forward.normalize();

    // Build a right vector from forward and transform joystick input into world-space movement.
    const right = new Vector3(forward.z, 0, -forward.x);
    const moveWorldX = right.x * moveInput.x + forward.x * moveInput.y;
    const moveWorldZ = right.z * moveInput.x + forward.z * moveInput.y;
    const moveLength = Math.hypot(moveWorldX, moveWorldZ);
    const moveScale = moveLength > 1 ? 1 / moveLength : 1;

    player.position.x += moveWorldX * moveScale * moveSpeed * deltaSeconds;
    player.position.z += moveWorldZ * moveScale * moveSpeed * deltaSeconds;

    camera.setTarget(player.position);
    scene.render();
  });
  window.addEventListener("resize", () => {
    engine.resize();
  });
}

await bootstrap();

await net.sendMessage({ type: "join" });
