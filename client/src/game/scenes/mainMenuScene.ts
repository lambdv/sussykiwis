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
  StackPanel,
  TextBlock,
  Button,
  Control,
} from "@babylonjs/gui";

type MenuSceneOptions = {
  onPlay: () => void;
};

export function createMenuScene(
  engine: Engine | WebGPUEngine,
  options: MenuSceneOptions,
): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.1, 0.15, 0.25, 1);

  const camera = new FreeCamera("menuCamera", new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero());
  scene.activeCamera = camera;

  const gui = AdvancedDynamicTexture.CreateFullscreenUI("MenuUI", true, scene);

  const panel = new StackPanel();
  panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  gui.addControl(panel);

  const title = new TextBlock();
  title.text = "SUSSY KIWIS";
  title.color = "#ebb0ff";
  title.fontSize = 72;
  title.height = "110px";
  panel.addControl(title);

  const subtitle = new TextBlock();
  subtitle.text = "Catch the imposter!";
  subtitle.color = "white";
  subtitle.fontSize = 24;
  subtitle.height = "50px";
  panel.addControl(subtitle);

  const playButton = Button.CreateSimpleButton("playButton", "PLAY");
  playButton.width = "220px";
  playButton.height = "70px";
  playButton.color = "white";
  playButton.background = "#ef4444";
  playButton.cornerRadius = 12;
  playButton.fontSize = 32;
  playButton.thickness = 0;

  playButton.onPointerClickObservable.add(() => {
    options.onPlay();
  });

  panel.addControl(playButton);

  return scene;
}
