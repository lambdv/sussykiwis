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

export interface GameSceneResult {
  scene: Scene;
  start: () => void;
  stop: () => void;
}

export function createGameScene(
  engine: Engine | WebGPUEngine,
  joystickZone: HTMLDivElement,
): GameSceneResult {
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

  const moveInput = { x: 0, y: 0 };
  const moveSpeed = 10;

  let joystickManager: ReturnType<typeof nipplejs.create> | null = null;

  function initJoystick() {
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

    joystickManager.on("move", (event) => {
      moveInput.x = event.data.vector.x;
      moveInput.y = event.data.vector.y;
    });

    joystickManager.on("end", () => {
      moveInput.x = 0;
      moveInput.y = 0;
    });
  }

  function destroyJoystick() {
    if (joystickManager) {
      joystickManager.destroy();
      joystickManager = null;
    }
    joystickZone.classList.remove("is-active");
  }

  function start() {
    initJoystick();

    engine.runRenderLoop(() => {
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
      scene.render();
    });
  }

  function stop() {
    engine.stopRenderLoop();
    destroyJoystick();
    player.position.set(0, 2, 0);
  }

  return {
    scene,
    start,
    stop,
  };
}