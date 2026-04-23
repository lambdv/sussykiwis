import "./style.css";
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

export async function createWorldScene(engine: Engine | WebGPUEngine): Scene {
  const canvas = document.getElementById(
    "renderCanvas",
  ) as HTMLCanvasElement | null;
  const joystickZone = document.getElementById(
    "joystickZone",
  ) as HTMLDivElement | null;

  if (!canvas || !joystickZone) {
    throw new Error("Missing required canvas or joystick container");
  }

  //let engine: Engine | WebGPUEngine;

  if (await WebGPUEngine.IsSupportedAsync) {
    const webgpuEngine = new WebGPUEngine(canvas, {
      stencil: true,
      antialias: true,
    });
    await webgpuEngine.initAsync();
    engine = webgpuEngine;
  } else {
    engine = new Engine(canvas, true, {
      preserveDrawingBuffer: false,
      stencil: true,
      antialias: true,
    });
  }

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

  engine.runRenderLoop(() => {
    const deltaSeconds = engine.getDeltaTime() / 1000;

    // Flatten camera forward direction onto XZ so movement stays on the ground plane.
    const forward = camera.getForwardRay().direction;
    forward.y = 0;
    forward.normalize();

    // Build a right vector from forward and transform joystick input into world-space movement.
    const right = new Vector3(forward.z, 0, -forward.x);
    const moveWorldX = right.x * moveInput.x + forward.x * moveInput.y;
    const moveWorldZ = right.z * moveInput.x + forward.z * moveInput.y;
    const moveLength = Math.hypot(moveWorldX, moveWorldZ);
    const moveScale = moveLength > 1 ? 1 / moveLength : 1;

    player.position.x += moveWorldX * moveScale * moveSpeed * deltaSeconds;
    player.position.z += moveWorldZ * moveScale * moveSpeed * deltaSeconds;

    camera.setTarget(player.position);
    scene.render();
  });

  window.addEventListener("resize", () => {
    engine.resize();
  });

  window.addEventListener("beforeunload", () => {
    joystickManager?.destroy();
  });
  const scene = new Scene(engine);

  return scene;
}
