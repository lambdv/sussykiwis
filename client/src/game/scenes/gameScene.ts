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
  camera.inputs.clear();

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

  const disposeControls = setupPlayerController(scene, engine, player);
  scene.onDisposeObservable.add(disposeControls);

  return scene;
}

function setupPlayerController(
  scene: Scene,
  engine: Engine | WebGPUEngine,
  player: ReturnType<typeof MeshBuilder.CreateSphere>,
): () => void {
  const keys = new Set<string>();
  const joy = { x: 0, y: 0 };
  const speed = 10;
  const cam = scene.activeCamera as ArcRotateCamera;

  const onKeyDown = (e: KeyboardEvent) => keys.add(e.key);
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const joyZone = document.getElementById("joystickZone") as HTMLDivElement | null;
  if (joyZone) joyZone.classList.add("is-active");
  let activePointerId: number | null = null;
  let activeTouchId: number | null = null;

  // Use static mode: nipple always visible at the zone center.
  const jm = joyZone
    ? nipplejs.create({
        zone: joyZone,
        mode: "static",
        position: { left: "50%", top: "50%" },
        size: 130,
        threshold: 0.1,
        color: "white",
        restOpacity: 0.65,
      })
    : null;

  // Extract a normalized movement vector from nipple data.
  const updateJoy = (_: unknown, data: any) => {
    if (!data) return;

    // Prefer data.vector: nipplejs emits this as normalized axis values.
    const vx = data?.vector?.x;
    const vy = data?.vector?.y;
    if (typeof vx === "number" && typeof vy === "number") {
      joy.x = Math.max(-1, Math.min(1, vx));
      joy.y = Math.max(-1, Math.min(1, vy));
      return;
    }

    // Fallback to angle/force for compatibility with alternate payload shapes.
    const a = data?.angle?.radian;
    const f = typeof data?.force === "number" ? data.force : 0;
    if (typeof a === "number") {
      const s = Math.max(0, Math.min(1, f));
      joy.x = Math.cos(a) * s;
      joy.y = Math.sin(a) * s;
    }
  };

  // Use loose typing because nipplejs TS overloads are incomplete.
  (jm as any)?.on("move", updateJoy);
  (jm as any)?.on("start", updateJoy);
  (jm as any)?.on("end", () => { joy.x = 0; joy.y = 0; });

  // Compute joystick axis from pointer position as a reliable fallback.
  const updateJoyFromPointer = (clientX: number, clientY: number) => {
    if (!joyZone) return;
    const rect = joyZone.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const rx = rect.width / 2;
    const ry = rect.height / 2;
    const dx = rx > 0 ? (clientX - cx) / rx : 0;
    const dy = ry > 0 ? (cy - clientY) / ry : 0;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      joy.x = dx / len;
      joy.y = dy / len;
      return;
    }
    joy.x = dx;
    joy.y = dy;
  };

  // Track one active pointer so drag input behaves like a virtual stick.
  const onPointerDown = (e: PointerEvent) => {
    activePointerId = e.pointerId;
    updateJoyFromPointer(e.clientX, e.clientY);
    joyZone?.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  // Update movement while dragging the active pointer.
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== activePointerId) return;
    updateJoyFromPointer(e.clientX, e.clientY);
    e.preventDefault();
  };

  // Reset movement when drag ends or is cancelled.
  const onPointerEnd = (e: PointerEvent) => {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    joy.x = 0;
    joy.y = 0;
    e.preventDefault();
  };

  joyZone?.addEventListener("pointerdown", onPointerDown);
  joyZone?.addEventListener("pointermove", onPointerMove);
  joyZone?.addEventListener("pointerup", onPointerEnd);
  joyZone?.addEventListener("pointercancel", onPointerEnd);

  // Support browsers that still rely on touch events instead of pointer events.
  const onTouchStart = (e: TouchEvent) => {
    const t = e.changedTouches[0];
    if (!t || activeTouchId !== null) return;
    activeTouchId = t.identifier;
    updateJoyFromPointer(t.clientX, t.clientY);
    e.preventDefault();
  };

  // Continue tracking the active touch as joystick input.
  const onTouchMove = (e: TouchEvent) => {
    if (activeTouchId === null) return;
    const t = Array.from(e.changedTouches).find((touch) => touch.identifier === activeTouchId);
    if (!t) return;
    updateJoyFromPointer(t.clientX, t.clientY);
    e.preventDefault();
  };

  // Clear joystick input when the active touch ends.
  const onTouchEnd = (e: TouchEvent) => {
    if (activeTouchId === null) return;
    const t = Array.from(e.changedTouches).find((touch) => touch.identifier === activeTouchId);
    if (!t) return;
    activeTouchId = null;
    joy.x = 0;
    joy.y = 0;
    e.preventDefault();
  };

  joyZone?.addEventListener("touchstart", onTouchStart, { passive: false });
  joyZone?.addEventListener("touchmove", onTouchMove, { passive: false });
  joyZone?.addEventListener("touchend", onTouchEnd, { passive: false });
  joyZone?.addEventListener("touchcancel", onTouchEnd, { passive: false });

  const ob = scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000;
    const kx = (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0);
    const kz = (keys.has("ArrowUp") ? 1 : 0) - (keys.has("ArrowDown") ? 1 : 0);
    // Combine and clamp per-axis to [-1, 1] so diagonal stays fast but doesn't exceed speed.
    const ix = Math.max(-1, Math.min(1, kx + joy.x));
    const iz = Math.max(-1, Math.min(1, kz + joy.y));
    player.position.x += ix * speed * dt;
    player.position.z += iz * speed * dt;
    cam.position.set(player.position.x, 18, player.position.z - 18);
    cam.setTarget(player.position);
  });

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    joyZone?.removeEventListener("pointerdown", onPointerDown);
    joyZone?.removeEventListener("pointermove", onPointerMove);
    joyZone?.removeEventListener("pointerup", onPointerEnd);
    joyZone?.removeEventListener("pointercancel", onPointerEnd);
    joyZone?.removeEventListener("touchstart", onTouchStart);
    joyZone?.removeEventListener("touchmove", onTouchMove);
    joyZone?.removeEventListener("touchend", onTouchEnd);
    joyZone?.removeEventListener("touchcancel", onTouchEnd);
    scene.onBeforeRenderObservable.remove(ob);
    jm?.destroy();
    joyZone?.classList.remove("is-active");
  };
}
