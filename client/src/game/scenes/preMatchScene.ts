import nipplejs from "nipplejs";
import {
  ArcRotateCamera,
  Camera,
  Color3,
  Color4,
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
  WebGPUEngine,
} from "@babylonjs/core";
import { NetworkClient } from "../../networking/client";
import type { ServerMessage, SnapshotPlayer, WorldSnapshot } from "../../networking/message";

const MOVE_SPEED = 6.0;
const MAP_HALF_EXTENT = 60;

type RemoteSnapshot = { time: number; x: number; z: number };

type PlayerMeshState = {
  mesh: Mesh;
  material: StandardMaterial;
  snapshots: RemoteSnapshot[];
};

type PendingInput = { seq: number; moveX: number; moveZ: number; dt: number };

type SessionState = {
  latestServerTime: number;
  clientRenderTime: number;
  pendingInputs: PendingInput[];
  latestSnapshot: WorldSnapshot | null;
  notice: string;
};

type PreMatchHud = {
  root: HTMLDivElement;
  status: HTMLDivElement;
};

export async function createPreMatchScene(
  engine: Engine | WebGPUEngine,
  canvas: HTMLCanvasElement,
  network: NetworkClient,
  localPlayerId: string | null,
  callbacks: { onMatchReady: () => void },
): Promise<Scene> {
  // Build a dedicated pre-match scene with a different world look.
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.6, 0.8, 0.95, 1);

  const camera = createCamera(scene, canvas);
  createEnvironment(scene);

  const players = new Map<string, PlayerMeshState>();
  const controller = setupPlayerController();
  const hud = createPreMatchHud();
  const session: SessionState = {
    latestServerTime: 0,
    clientRenderTime: 0,
    pendingInputs: [],
    latestSnapshot: null,
    notice: "Waiting for players",
  };

  const offMessage = network.onMessage((message) => {
    // Keep this scene in sync with world snapshots and auto-enter match when ready.
    handleServerMessage(scene, players, message, localPlayerId, session, callbacks);
    updatePreMatchHud(hud, session);
  });

  const renderLoop = scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000.0;
    handleLocalPlayerMovement(camera, players, controller, network, localPlayerId, session, dt);
    updateRenderTime(session, dt);
    interpolateRemotePlayers(players, localPlayerId, session.clientRenderTime);
    updatePreMatchHud(hud, session);
  });

  scene.onDisposeObservable.add(() => {
    // Tear down listeners and meshes owned by this temporary scene.
    controller.dispose();
    offMessage();
    scene.onBeforeRenderObservable.remove(renderLoop);
    hud.root.remove();
    for (const player of players.values()) {
      player.mesh.dispose();
      player.material.dispose();
    }
    players.clear();
  });

  return scene;
}

function createCamera(scene: Scene, canvas: HTMLCanvasElement) {
  // Reuse the same fixed gameplay camera angle with orthographic projection.
  const camera = new ArcRotateCamera("prematch-camera", -Math.PI / 4, 0.95, 52, Vector3.Zero(), scene);
  camera.lowerAlphaLimit = camera.upperAlphaLimit = camera.alpha;
  camera.lowerBetaLimit = camera.upperBetaLimit = camera.beta;
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  scene.onBeforeRenderObservable.add(() => {
    // Keep ortho bounds aligned with canvas aspect so scale is stable.
    const engine = scene.getEngine();
    const width = Math.max(1, engine.getRenderWidth());
    const height = Math.max(1, engine.getRenderHeight());
    const aspect = width / height;
    const halfHeight = 28;
    const halfWidth = halfHeight * aspect;
    camera.orthoLeft = -halfWidth;
    camera.orthoRight = halfWidth;
    camera.orthoBottom = -halfHeight;
    camera.orthoTop = halfHeight;
  });
  camera.attachControl(canvas, true);
  camera.inputs.clear();
  return camera;
}

function createEnvironment(scene: Scene) {
  // Light the map brightly so edge walls are always readable on mobile.
  const light = new HemisphericLight("prematch-light", new Vector3(0, 1, 0.2), scene);
  light.intensity = 1.1;

  // Create the requested square world plane for pre-match movement.
  const groundSize = MAP_HALF_EXTENT * 2;
  const ground = MeshBuilder.CreateGround("prematch-ground", { width: groundSize, height: groundSize }, scene);
  const groundMaterial = new StandardMaterial("prematch-ground-material", scene);
  groundMaterial.diffuseColor = Color3.FromHexString("#4f7d5c");
  ground.material = groundMaterial;

  // Add visible collision walls around the plane perimeter.
  const wallMaterial = new StandardMaterial("prematch-wall-material", scene);
  wallMaterial.diffuseColor = Color3.FromHexString("#ffd166");
  const wallThickness = 1.2;
  const wallHeight = 3.5;
  const edge = MAP_HALF_EXTENT + wallThickness / 2;
  const full = MAP_HALF_EXTENT * 2 + wallThickness;

  const north = MeshBuilder.CreateBox("prematch-wall-north", { width: full, height: wallHeight, depth: wallThickness }, scene);
  north.position.set(0, wallHeight / 2, edge);
  north.material = wallMaterial;

  const south = MeshBuilder.CreateBox("prematch-wall-south", { width: full, height: wallHeight, depth: wallThickness }, scene);
  south.position.set(0, wallHeight / 2, -edge);
  south.material = wallMaterial;

  const east = MeshBuilder.CreateBox("prematch-wall-east", { width: wallThickness, height: wallHeight, depth: full }, scene);
  east.position.set(edge, wallHeight / 2, 0);
  east.material = wallMaterial;

  const west = MeshBuilder.CreateBox("prematch-wall-west", { width: wallThickness, height: wallHeight, depth: full }, scene);
  west.position.set(-edge, wallHeight / 2, 0);
  west.material = wallMaterial;
}

function handleServerMessage(
  scene: Scene,
  players: Map<string, PlayerMeshState>,
  message: ServerMessage,
  localPlayerId: string | null,
  session: SessionState,
  callbacks: { onMatchReady: () => void },
) {
  // Respond only to live world snapshots while in pre-match.
  if (message.type !== "world_snapshot") {
    return;
  }

  handleSnapshot(scene, players, message.snapshot, localPlayerId, session);

  // Promote the client into the main game scene once server flips sub-state.
  if (message.snapshot.subState === "in_game") {
    callbacks.onMatchReady();
  }
}

function handleSnapshot(
  scene: Scene,
  players: Map<string, PlayerMeshState>,
  snapshot: WorldSnapshot,
  localPlayerId: string | null,
  session: SessionState,
) {
  session.latestSnapshot = snapshot;
  session.latestServerTime = Math.max(session.latestServerTime, snapshot.serverTime);
  session.notice = `Waiting for players: ${snapshot.joinedPlayers} / ${snapshot.expectedPlayers}`;

  const livePlayerIds = new Set<string>();
  for (const snapshotPlayer of snapshot.players) {
    livePlayerIds.add(snapshotPlayer.id);
    const state = upsertPlayerMesh(scene, players, snapshotPlayer);

    if (snapshotPlayer.id === localPlayerId) {
      reconcileLocalPlayer(state, snapshotPlayer, session.pendingInputs);
    } else {
      state.snapshots.push({
        time: snapshot.serverTime,
        x: snapshotPlayer.x,
        z: snapshotPlayer.z,
      });

      if (state.snapshots.length > 10) {
        state.snapshots.shift();
      }
    }

    state.mesh.position.y = snapshotPlayer.state === "ghost" ? 3 : 2;
  }

  cleanupDisconnectedPlayers(players, livePlayerIds);
}

function handleLocalPlayerMovement(
  camera: ArcRotateCamera,
  players: Map<string, PlayerMeshState>,
  controller: ReturnType<typeof setupPlayerController>,
  network: NetworkClient,
  localPlayerId: string | null,
  session: SessionState,
  dt: number,
) {
  // Apply local prediction in pre-match so movement feels responsive.
  const input = controller.getInput();
  const ix = input.x;
  const iz = input.z;
  const localState = localPlayerId ? players.get(localPlayerId) : undefined;

  if (localPlayerId && localState) {
    localState.mesh.position.x = clampToMap(localState.mesh.position.x + ix * MOVE_SPEED * dt);
    localState.mesh.position.z = clampToMap(localState.mesh.position.z + iz * MOVE_SPEED * dt);
    session.pendingInputs.push({ seq: input.seq, moveX: ix, moveZ: iz, dt });
  }

  if (localState) {
    // Keep the camera centered on the local player without changing the angle.
    camera.setTarget(localState.mesh.position);
  }

  network.sendMessage({
    type: "input",
    seq: input.seq,
    moveX: ix,
    moveY: iz,
  });
}

function clampToMap(value: number) {
  // Match local clamping with server authority bounds for smoother edges.
  return Math.max(-MAP_HALF_EXTENT, Math.min(MAP_HALF_EXTENT, value));
}

function reconcileLocalPlayer(state: PlayerMeshState, snapshotPlayer: SnapshotPlayer, pendingInputs: PendingInput[]) {
  // Reconcile local prediction against authoritative server input acknowledgements.
  let targetX = snapshotPlayer.x;
  let targetZ = snapshotPlayer.z;

  while (pendingInputs.length > 0 && pendingInputs[0].seq <= snapshotPlayer.lastProcessedSeq) {
    pendingInputs.shift();
  }

  for (const input of pendingInputs) {
    targetX += input.moveX * MOVE_SPEED * input.dt;
    targetZ += input.moveZ * MOVE_SPEED * input.dt;
  }

  const clampedX = clampToMap(targetX);
  const clampedZ = clampToMap(targetZ);
  const dx = clampedX - state.mesh.position.x;
  const dz = clampedZ - state.mesh.position.z;

  // Snap only when drift is meaningful to avoid visible lobby jitter.
  if (dx * dx + dz * dz > 0.1) {
    state.mesh.position.x = clampedX;
    state.mesh.position.z = clampedZ;
  }
}

function updateRenderTime(session: SessionState, dt: number) {
  // Keep remote interpolation delayed slightly to hide network jitter.
  const interpolationDelay = 100;

  if (session.clientRenderTime === 0 && session.latestServerTime > 0) {
    session.clientRenderTime = session.latestServerTime - interpolationDelay;
  } else if (session.latestServerTime > 0) {
    session.clientRenderTime += dt * 1000;
    const targetRenderTime = session.latestServerTime - interpolationDelay;
    const diff = targetRenderTime - session.clientRenderTime;
    session.clientRenderTime += diff * 0.1;
  }
}

function interpolateRemotePlayers(
  players: Map<string, PlayerMeshState>,
  localPlayerId: string | null,
  clientRenderTime: number,
) {
  // Interpolate other players from snapshot history to keep motion smooth.
  for (const [id, state] of players) {
    if (id === localPlayerId) continue;
    const snaps = state.snapshots;
    if (snaps.length === 0) continue;

    if (clientRenderTime > snaps[snaps.length - 1].time) {
      const last = snaps[snaps.length - 1];
      state.mesh.position.x = last.x;
      state.mesh.position.z = last.z;
    } else if (clientRenderTime < snaps[0].time) {
      state.mesh.position.x = snaps[0].x;
      state.mesh.position.z = snaps[0].z;
    } else {
      let prev = snaps[0];
      let next = snaps[0];

      for (let i = 0; i < snaps.length - 1; i += 1) {
        if (snaps[i].time <= clientRenderTime && snaps[i + 1].time >= clientRenderTime) {
          prev = snaps[i];
          next = snaps[i + 1];
          break;
        }
      }

      const timeDiff = next.time - prev.time;
      const alpha = timeDiff > 0 ? (clientRenderTime - prev.time) / timeDiff : 0;
      state.mesh.position.x = prev.x + (next.x - prev.x) * alpha;
      state.mesh.position.z = prev.z + (next.z - prev.z) * alpha;
    }
  }
}

function upsertPlayerMesh(
  scene: Scene,
  players: Map<string, PlayerMeshState>,
  snapshotPlayer: SnapshotPlayer,
): PlayerMeshState {
  // Lazily create each player mesh the first time we see that player id.
  const existing = players.get(snapshotPlayer.id);
  if (existing) {
    return existing;
  }

  const mesh = MeshBuilder.CreateSphere(`prematch-player-${snapshotPlayer.id}`, { diameter: 2.6 }, scene);
  const material = new StandardMaterial(`prematch-player-material-${snapshotPlayer.id}`, scene);
  material.diffuseColor = Color3.FromHexString(snapshotPlayer.color);
  mesh.material = material;
  mesh.position.set(snapshotPlayer.x, 2, snapshotPlayer.z);

  const playerState = { mesh, material, snapshots: [] };
  players.set(snapshotPlayer.id, playerState);
  return playerState;
}

function cleanupDisconnectedPlayers(players: Map<string, PlayerMeshState>, liveIds: Set<string>) {
  // Remove meshes for players no longer present in authoritative snapshots.
  for (const [id, state] of players) {
    if (liveIds.has(id)) continue;
    state.mesh.dispose();
    state.material.dispose();
    players.delete(id);
  }
}

function createPreMatchHud(): PreMatchHud {
  // Render waiting status as a lightweight HTML overlay.
  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.top = "16px";
  root.style.left = "16px";
  root.style.zIndex = "20";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "8px";
  root.style.pointerEvents = "none";

  const status = document.createElement("div");
  status.style.background = "rgba(10, 18, 22, 0.82)";
  status.style.border = "1px solid rgba(255, 209, 102, 0.7)";
  status.style.color = "#f8fbff";
  status.style.padding = "10px 14px";
  status.style.borderRadius = "10px";
  status.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";
  status.style.fontSize = "14px";
  status.style.fontWeight = "700";

  root.append(status);
  document.body.append(root);

  return { root, status };
}

function updatePreMatchHud(hud: PreMatchHud, session: SessionState) {
  // Keep waiting copy synced with latest server snapshot counters.
  hud.status.textContent = session.notice;
}

function setupPlayerController() {
  // Merge keyboard and joystick movement into one normalized input vector.
  const keys = new Set<string>();
  const joy = { x: 0, y: 0 };
  let seq = 0;

  const onKeyDown = (event: KeyboardEvent) => keys.add(event.key);
  const onKeyUp = (event: KeyboardEvent) => keys.delete(event.key);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const joyZone = document.getElementById("joystickZone") as HTMLDivElement | null;
  if (joyZone) joyZone.classList.add("is-active");
  let activePointerId: number | null = null;
  let activeTouchId: number | null = null;

  const manager = joyZone
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

  const updateJoy = (_: unknown, data: any) => {
    if (!data) return;
    const vectorX = data?.vector?.x;
    const vectorY = data?.vector?.y;

    if (typeof vectorX === "number" && typeof vectorY === "number") {
      joy.x = Math.max(-1, Math.min(1, vectorX));
      joy.y = Math.max(-1, Math.min(1, vectorY));
      return;
    }

    const angle = data?.angle?.radian;
    const force = typeof data?.force === "number" ? data.force : 0;
    if (typeof angle === "number") {
      const scale = Math.max(0, Math.min(1, force));
      joy.x = Math.cos(angle) * scale;
      joy.y = Math.sin(angle) * scale;
    }
  };

  (manager as any)?.on("move", updateJoy);
  (manager as any)?.on("start", updateJoy);
  (manager as any)?.on("end", () => {
    joy.x = 0;
    joy.y = 0;
  });

  const updateJoyFromPointer = (clientX: number, clientY: number) => {
    if (!joyZone) return;

    const rect = joyZone.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const radiusX = rect.width / 2;
    const radiusY = rect.height / 2;
    const dx = radiusX > 0 ? (clientX - centerX) / radiusX : 0;
    const dy = radiusY > 0 ? (centerY - clientY) / radiusY : 0;
    const len = Math.hypot(dx, dy);

    if (len > 1) {
      joy.x = dx / len;
      joy.y = dy / len;
      return;
    }

    joy.x = dx;
    joy.y = dy;
  };

  const onPointerDown = (event: PointerEvent) => {
    activePointerId = event.pointerId;
    updateJoyFromPointer(event.clientX, event.clientY);
    joyZone?.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) return;
    updateJoyFromPointer(event.clientX, event.clientY);
    event.preventDefault();
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    joy.x = 0;
    joy.y = 0;
    event.preventDefault();
  };

  joyZone?.addEventListener("pointerdown", onPointerDown);
  joyZone?.addEventListener("pointermove", onPointerMove);
  joyZone?.addEventListener("pointerup", onPointerEnd);
  joyZone?.addEventListener("pointercancel", onPointerEnd);

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    if (!touch || activeTouchId !== null) return;
    activeTouchId = touch.identifier;
    updateJoyFromPointer(touch.clientX, touch.clientY);
    event.preventDefault();
  };

  const onTouchMove = (event: TouchEvent) => {
    if (activeTouchId === null) return;
    const touch = Array.from(event.changedTouches).find((entry) => entry.identifier === activeTouchId);
    if (!touch) return;
    updateJoyFromPointer(touch.clientX, touch.clientY);
    event.preventDefault();
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (activeTouchId === null) return;
    const touch = Array.from(event.changedTouches).find((entry) => entry.identifier === activeTouchId);
    if (!touch) return;
    activeTouchId = null;
    joy.x = 0;
    joy.y = 0;
    event.preventDefault();
  };

  joyZone?.addEventListener("touchstart", onTouchStart, { passive: false });
  joyZone?.addEventListener("touchmove", onTouchMove, { passive: false });
  joyZone?.addEventListener("touchend", onTouchEnd, { passive: false });
  joyZone?.addEventListener("touchcancel", onTouchEnd, { passive: false });

  return {
    getInput() {
      const keyboardX = (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0);
      const keyboardZ = (keys.has("ArrowUp") ? 1 : 0) - (keys.has("ArrowDown") ? 1 : 0);
      let inputX = keyboardX + joy.x;
      let inputZ = keyboardZ + joy.y;

      const lengthSq = inputX * inputX + inputZ * inputZ;
      if (lengthSq > 1) {
        const length = Math.sqrt(lengthSq);
        inputX /= length;
        inputZ /= length;
      } else if (lengthSq === 0) {
        inputX = 0;
        inputZ = 0;
      }

      seq += 1;
      return { x: inputX, z: inputZ, seq };
    },
    dispose() {
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
      manager?.destroy();
      joyZone?.classList.remove("is-active");
    },
  };
}
