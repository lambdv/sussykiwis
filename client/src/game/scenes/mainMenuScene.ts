import {
  Engine,
  Scene,
  Color4,
  HemisphericLight,
  Vector3,
  MeshBuilder,
  StandardMaterial,
  Color3,
  WebGPUEngine,
  FreeCamera,
} from "@babylonjs/core";
import {
  AdvancedDynamicTexture,
  StackPanel,
  TextBlock,
  Button,
  Control,
} from "@babylonjs/gui";
import { gameState } from "../../state";
import { net } from "../../main";

export function createMenuScene(engine: Engine | WebGPUEngine): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.1, 0.15, 0.25, 1);

  const camera = new FreeCamera("menuCamera", new Vector3(0, 0, -10), scene);

  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;

  // Basic lighting
  const light = new HemisphericLight("light", new Vector3(0, 1, 0), scene);
  light.intensity = 0.8;

  // Simple ground plane
  const ground = MeshBuilder.CreateGround(
    "ground",
    { width: 50, height: 50 },
    scene,
  );
  const groundMat = new StandardMaterial("groundMat", scene);
  groundMat.diffuseColor = Color3.FromHexString("#1a1a2e");
  groundMat.specularColor = Color3.Black();
  ground.material = groundMat;
  ground.position.y = -2;

  // Full-screen GUI
  const gui = AdvancedDynamicTexture.CreateFullscreenUI("MenuUI");

  // Main container
  const mainPanel = new StackPanel();
  mainPanel.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  mainPanel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  gui.addControl(mainPanel);

  // Title
  const title = new TextBlock();
  title.text = "SUSSY KIWIS";
  title.color = "#ebb0ff";
  title.fontSize = 80;
  title.height = "120px";
  title.shadowColor = "#000";
  title.shadowBlur = 10;
  mainPanel.addControl(title);

  // Subtitle
  const subtitle = new TextBlock();
  subtitle.text = "Catch the imposter!";
  subtitle.color = "#ffffff";
  subtitle.fontSize = 24;
  subtitle.height = "40px";
  mainPanel.addControl(subtitle);

  // Spacing
  const spacer = new TextBlock();
  spacer.height = "60px";
  mainPanel.addControl(spacer);

  // Play Button
  const playBtn = Button.CreateSimpleButton("playBtn", "PLAY");
  playBtn.width = "220px";
  playBtn.height = "70px";
  playBtn.color = "white";
  playBtn.cornerRadius = 15;
  playBtn.background = "linear-gradient(145deg, #f97316, #ef4444)";
  playBtn.fontSize = 32;
  playBtn.thickness = 0;
  playBtn.onPointerClickObservable.add(() => {
    net.sendMessage({ type: "join" });
    gameState.set("QUEUE");
  });
  mainPanel.addControl(playBtn);

  // Queue overlay (hidden initially)
  const queueOverlay = new StackPanel();
  queueOverlay.isVisible = false;
  queueOverlay.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  queueOverlay.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  queueOverlay.background = "rgba(0, 0, 0, 0.7)";
  gui.addControl(queueOverlay);

  const queueText = new TextBlock();
  queueText.text = "Searching...";
  queueText.color = "white";
  queueText.fontSize = 48;
  queueOverlay.addControl(queueText);

  const queueSubtext = new TextBlock();
  queueSubtext.text = "Waiting for players...";
  queueSubtext.color = "#cccccc";
  queueSubtext.fontSize = 20;
  queueSubtext.height = "40px";
  queueOverlay.addControl(queueSubtext);

  // Subscribe to state changes
  gameState.onChange((state) => {
    if (state === "QUEUE") {
      queueOverlay.isVisible = true;
      playBtn.isEnabled = false;
    } else {
      queueOverlay.isVisible = false;
      playBtn.isEnabled = true;
    }
  });

  return scene;
}
