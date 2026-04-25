import nipplejs from "nipplejs";
import {
  ArcRotateCamera,
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

export function createGameScene(
  engine: Engine | WebGPUEngine,
  canvas: HTMLCanvasElement,
): Scene {
  // Build the main gameplay scene with camera, lighting, and player mesh.
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
  camera.attachControl(canvas, true);

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

  // Track directional joystick input so we can move the player every frame.
  const moveInput = { x: 0, y: 0 };
  const moveSpeed = 10;

  // Try to attach the mobile joystick if the zone is present in DOM.
  const joystickZone = document.getElementById("joystickZone") as
    | HTMLDivElement
    | null;
  let joystickManager: ReturnType<typeof nipplejs.create> | null = null;

  if (joystickZone) {
    joystickZone.classList.add("is-active");

    joystickManager = nipplejs.create({
      zone: joystickZone,
      mode: "static",
      position: { left: "50%", top: "50%" },
      size: 130,
      threshold: 0.08,
      color: "white",
      restOpacity: 0.65,
      fadeTime: 140,
    });

    // Use loose event typing because nipplejs' TS event overloads are incomplete.
    (joystickManager as any).on("move", (_event: unknown, data: any) => {
      const vector = data?.vector;
      if (!vector) return;
      moveInput.x = vector.x;
      moveInput.y = vector.y;
    });

    (joystickManager as any).on("end", () => {
      moveInput.x = 0;
      moveInput.y = 0;
    });
  }

  // Update player movement in the scene render lifecycle.
  scene.onBeforeRenderObservable.add(() => {
    const deltaSeconds = engine.getDeltaTime() / 1000;

    const forward = camera.getForwardRay().direction;
    forward.y = 0;
    forward.normalize();

    const right = new Vector3(forward.z, 0, -forward.x);
    const moveWorldX = right.x * moveInput.x + forward.x * moveInput.y;
    const moveWorldZ = right.z * moveInput.x + forward.z * moveInput.y;
    const moveLength = Math.hypot(moveWorldX, moveWorldZ);
    const moveScale = moveLength > 1 ? 1 / moveLength : 1;

    player.position.x += moveWorldX * moveScale * moveSpeed * deltaSeconds;
    player.position.z += moveWorldZ * moveScale * moveSpeed * deltaSeconds;

    camera.setTarget(player.position);
  });

  // Release joystick resources when leaving the game scene.
  scene.onDisposeObservable.add(() => {
    joystickManager?.destroy();
    joystickManager = null;
    joystickZone?.classList.remove("is-active");
  });

  return scene;
}
