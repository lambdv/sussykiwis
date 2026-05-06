import { Color4, Engine, Scene, WebGPUEngine } from "@babylonjs/core";
import { NetworkClient } from "../../networking/client";

export function createWinScene(
  engine: Engine | WebGPUEngine,
  _canvas: HTMLCanvasElement,
  _network: NetworkClient,
  _localPlayerId: string | null,
  callbacks: { onDone: () => void },
): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.08, 0.08, 0.1, 1);
  const root = document.createElement("div");
  root.textContent = "Win screen";
  document.body.appendChild(root);
  setTimeout(() => callbacks.onDone(), 4000);
  scene.onDisposeObservable.add(() => root.remove());
  return scene;
}
