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

export default function GameScene(
  engine: Engine | WebGPUEngine,
  joystickZone: HTMLDivElement,
) {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.81, 0.89, 0.99, 1);

  const camera = new ArcRotateCamera(
    "camera",
    Math.PI / 4,
    Math.PI / 3,
    50,
    Vector3.Zero(),
    scene,
  );

  const light = new HemisphericLight("light", new Vector3(0, 1, 0.3), scene);
  light.intensity = 1;

  const ground = MeshBuilder.CreateBox(
    "ground",
    { width: 30, height: 1, depth: 10 },
    scene,
  );
  ground.position.y = -0.5;

  const player = MeshBuilder.CreateSphere("sphere", { diameter: 2 }, scene);

  const playerMat = new StandardMaterial("playerMat", scene);
  playerMat.diffuseColor = Color3.FromHexString("#ebb0ff");
  player.material = playerMat;
  player.position.y = 2;

  const moveInput = {
    x: 0,
    y: 0,
  };

  let joystickManager: ReturnType<typeof nipplejs.create> | null = null;
  joystickZone.classList.add("is-active");

  joystickManager = nipplejs.create({
    zone: joystickZone,
    mode: "static",
    position: { left: "50%", top: "50%" },
    size: 130,
    threshold: 0.08,
    color: {
      back: "rgba(255, 255, 255, 0.5)",
      front: "linear-gradient(145deg, #f97316, #ef4444)",
    },
    restOpacity: 0.65,
    fadeTime: 140,
  });

  // Capture joystick vector each frame so movement can be applied in the render loop.
  joystickManager.on("move", (event) => {
    moveInput.x = event.data.vector.x;
    moveInput.y = event.data.vector.y;
  });

  // Reset movement when the thumb is released.
  joystickManager.on("end", () => {
    moveInput.x = 0;
    moveInput.y = 0;
  });

  const moveSpeed = 10;

  window.addEventListener("beforeunload", () => {
    joystickManager?.destroy();
  });

  return scene;
}
