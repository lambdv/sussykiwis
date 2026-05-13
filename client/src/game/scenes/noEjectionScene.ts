import { Color4, Engine, FreeCamera, Scene, Vector3, WebGPUEngine } from "@babylonjs/core";
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

  // Give the transition scene a real active camera so Babylon can render safely.
  const camera = new FreeCamera("no-ejection-camera", new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;

  const root = document.createElement("div");
  root.textContent = "No one was ejected";
  document.body.appendChild(root);
  setTimeout(() => callbacks.onDone(), 2500);
  scene.onDisposeObservable.add(() => root.remove());
  return scene;
}
