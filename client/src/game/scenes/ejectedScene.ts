import { Color4, Engine, Scene, WebGPUEngine } from "@babylonjs/core";
import { NetworkClient } from "../../networking/client";

export function createEjectedScene(
  engine: Engine | WebGPUEngine,
  _canvas: HTMLCanvasElement,
  _network: NetworkClient,
  _localPlayerId: string | null,
  callbacks: { onDone: () => void },
): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.35, 0.14, 0.12, 1);
  const root = document.createElement("div");
  root.textContent = "A player was ejected";
  document.body.appendChild(root);
  setTimeout(() => callbacks.onDone(), 2500);
  scene.onDisposeObservable.add(() => root.remove());
  return scene;
}
