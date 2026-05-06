import {
  ArcRotateCamera,
  Camera,
  Color3,
  Color4,
  Engine,
  HemisphericLight,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
  WebGPUEngine,
} from "@babylonjs/core";
import { AdvancedDynamicTexture, Control, Rectangle, StackPanel, TextBlock } from "@babylonjs/gui";
import type { WinSceneData } from "./gameScene";

type WinSceneCallbacks = {
  onDone: () => void;
};

export function createWinScene(
  engine: Engine | WebGPUEngine,
  canvas: HTMLCanvasElement,
  data: WinSceneData | null,
  callbacks: WinSceneCallbacks,
): Scene {
  const scene = new Scene(engine);
  const winningFaction = data?.winner ?? "crew";

  scene.clearColor = winningFaction === "crew" ? new Color4(0.1, 0.18, 0.16, 1) : new Color4(0.18, 0.1, 0.12, 1);

  const camera = new ArcRotateCamera("win-camera", -Math.PI / 4, 0.92, 44, Vector3.Zero(), scene);
  camera.mode = Camera.PERSPECTIVE_CAMERA;
  camera.lowerBetaLimit = camera.upperBetaLimit = camera.beta;
  camera.lowerAlphaLimit = camera.upperAlphaLimit = camera.alpha;
  camera.attachControl(canvas, true);
  camera.inputs.clear();

  const light = new HemisphericLight("win-light", new Vector3(0, 1, 0.2), scene);
  light.intensity = 1.2;

  const ground = MeshBuilder.CreateGround("win-ground", { width: 64, height: 64 }, scene);
  const groundMaterial = new StandardMaterial("win-ground-material", scene);
  groundMaterial.diffuseColor = winningFaction === "crew" ? Color3.FromHexString("#17372f") : Color3.FromHexString("#3b1820");
  ground.material = groundMaterial;

  const lineup = data?.snapshot.players.filter((player) => {
    return winningFaction === "crew" ? player.role !== "imposter" : player.role === "imposter";
  }) ?? [];
  const title = winningFaction === "crew" ? "CREW MATES WON" : "IMPOSTERS WON";

  createWinFigures(scene, lineup, winningFaction);

  const ui = AdvancedDynamicTexture.CreateFullscreenUI("WinUI", true, scene);
  const root = new Rectangle("win-root");
  root.width = "100%";
  root.height = "100%";
  root.thickness = 0;
  root.background = "rgba(0,0,0,0.08)";
  ui.addControl(root);

  const panel = new StackPanel();
  panel.width = "min(92vw, 560px)";
  panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  panel.paddingBottom = "32px";
  root.addControl(panel);

  const titleBlock = new TextBlock();
  titleBlock.text = title;
  titleBlock.color = "white";
  titleBlock.fontSize = 44;
  titleBlock.height = "58px";
  panel.addControl(titleBlock);

  const reasonBlock = new TextBlock();
  reasonBlock.text = data ? data.reason.replaceAll("_", " ") : "Round complete";
  reasonBlock.color = "#dbeafe";
  reasonBlock.fontSize = 20;
  reasonBlock.height = "34px";
  panel.addControl(reasonBlock);

  const hintBlock = new TextBlock();
  hintBlock.text = "Tap screen or press back to lobby";
  hintBlock.color = "#cbd5e1";
  hintBlock.fontSize = 18;
  hintBlock.height = "30px";
  panel.addControl(hintBlock);

  const button = document.createElement("button");
  button.textContent = "Back to lobby";
  button.style.position = "fixed";
  button.style.left = "50%";
  button.style.bottom = "18px";
  button.style.transform = "translateX(-50%)";
  button.style.zIndex = "40";
  button.style.padding = "0.9rem 1.2rem";
  button.style.borderRadius = "999px";
  button.style.border = "0";
  button.style.background = "#ffffff";
  button.style.color = "#111827";
  button.style.fontWeight = "800";
  button.onclick = () => callbacks.onDone();
  document.body.appendChild(button);

  const advance = () => callbacks.onDone();
  scene.onPointerDown = advance;
  window.addEventListener("keydown", advance);

  scene.onDisposeObservable.add(() => {
    button.remove();
    window.removeEventListener("keydown", advance);
    ui.dispose();
    ground.dispose();
  });

  return scene;
}

function createWinFigures(scene: Scene, players: { name: string; color: string; role: string }[], winner: "crew" | "imposters") {
  const baseX = -((players.length - 1) * 3) / 2;
  const y = 2;
  const z = winner === "crew" ? 4 : -4;

  players.forEach((player, index) => {
    const mesh = MeshBuilder.CreateCapsule(`win-player-${index}`, { height: 2.4, radius: 0.85 }, scene);
    mesh.position.set(baseX + index * 3, y, z + Math.sin(index) * 0.3);

    const material = new StandardMaterial(`win-player-material-${index}`, scene);
    material.diffuseColor = Color3.FromHexString(player.color);
    mesh.material = material;
  });
}
