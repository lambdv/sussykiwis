import { Color4, Engine, Scene, WebGPUEngine } from "@babylonjs/core";
import { NetworkClient } from "../../networking/client";

export function createNoEjectionScene(
  engine: Engine | WebGPUEngine,
  _canvas: HTMLCanvasElement,
  _network: NetworkClient,
  _localPlayerId: string | null,
  callbacks: { onDone: () => void },
): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.16, 0.16, 0.18, 1);
  const root = document.createElement("div");
  root.textContent = "No one was ejected";
  document.body.appendChild(root);
  setTimeout(() => callbacks.onDone(), 2500);
  scene.onDisposeObservable.add(() => root.remove());
  return scene;
}
