import {
  Engine,
  Scene,
  Color4,
  Vector3,
  FreeCamera,
  WebGPUEngine,
} from "@babylonjs/core";

import {
  AdvancedDynamicTexture,
  Control,
  StackPanel,
  TextBlock,
} from "@babylonjs/gui";

type QueueSceneOptions = {
  onEnter: () => void;
};

export function createQueueScene(
  engine: Engine | WebGPUEngine,
  options: QueueSceneOptions,
): Scene {
  // Build a lightweight intermediate scene used only during join handshake.
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.07, 0.12, 1);

  // Add a simple fixed camera so Babylon can render this transition scene.
  const camera = new FreeCamera("queueCamera", new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;

  // Create minimal UI to show the player we are joining a game.
  const gui = AdvancedDynamicTexture.CreateFullscreenUI("QueueUI", true, scene);
  const panel = new StackPanel();
  panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  gui.addControl(panel);

  const title = new TextBlock();
  title.text = "Joining game...";
  title.color = "white";
  title.fontSize = 56;
  title.height = "90px";
  panel.addControl(title);

  const subtitle = new TextBlock();
  subtitle.text = "Syncing with server";
  subtitle.color = "#cccccc";
  subtitle.fontSize = 22;
  subtitle.height = "50px";
  panel.addControl(subtitle);

  // Schedule the join callback after scene creation so routing stays centralized.
  let isDisposed = false;
  scene.onDisposeObservable.add(() => {
    isDisposed = true;
  });

  queueMicrotask(() => {
    if (!isDisposed) {
      options.onEnter();
    }
  });

  return scene;
}
