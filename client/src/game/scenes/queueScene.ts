import {
  Engine,
  WebGPUEngine,
  Scene,
  Color4,
  Vector3,
  FreeCamera,
} from "@babylonjs/core";

import {
  AdvancedDynamicTexture,
  StackPanel,
  TextBlock,
  Button,
  Control,
} from "@babylonjs/gui";

import { NetworkClient } from "../../networking/client";

type QueueSceneOptions = {
  network: NetworkClient;
  onMatchFound: () => void;
  onCancel: () => void;
};

export function createQueueScene(
  engine: Engine | WebGPUEngine,
  options: QueueSceneOptions,
): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.07, 0.12, 1);

  // camera
  const camera = new FreeCamera("queueCamera", new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;

  // UI
  const gui = AdvancedDynamicTexture.CreateFullscreenUI("QueueUI", true, scene);

  const panel = new StackPanel();
  panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  gui.addControl(panel);

  const title = new TextBlock();
  title.text = "Searching...";
  title.color = "white";
  title.fontSize = 56;
  title.height = "90px";
  panel.addControl(title);

  const subtitle = new TextBlock();
  subtitle.text = "Waiting for players...";
  subtitle.color = "#cccccc";
  subtitle.fontSize = 22;
  subtitle.height = "50px";
  panel.addControl(subtitle);

  const cancelButton = Button.CreateSimpleButton("cancelButton", "CANCEL");
  cancelButton.width = "220px";
  cancelButton.height = "64px";
  cancelButton.color = "white";
  cancelButton.background = "#374151";
  cancelButton.cornerRadius = 12;
  cancelButton.fontSize = 26;
  cancelButton.thickness = 0;
  panel.addControl(cancelButton);

  const net = options.network;

  // --- LIFECYCLE ---

  // connect + join queue
  net.connect();
  net.sendMessage({ type: "join_queue" });

  // message handler
  const handleMessage = (msg: any) => {
    if (msg.type === "match_found") {
      options.onMatchFound();
    }
  };

  net.onMessage(handleMessage);

  // cancel button
  cancelButton.onPointerClickObservable.add(() => {
    net.sendMessage({ type: "leave_queue" });
    options.onCancel();
  });

  // cleanup when scene is destroyed
  scene.onDisposeObservable.add(() => {
    net.sendMessage({ type: "leave_queue" });
    net.offMessage?.(handleMessage);
  });

  return scene;
}
