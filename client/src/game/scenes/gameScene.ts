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
import { NetworkClient } from "../../networking/client";
import type {
  ServerMessage,
  SnapshotPlayer,
  WorldSnapshot,
} from "../../networking/message";

const MOVE_SPEED = 6.0;

type RemoteSnapshot = { time: number; x: number; z: number };

type PlayerState = {
  mesh: ReturnType<typeof MeshBuilder.CreateSphere>;
  snapshots: RemoteSnapshot[];
};

type GameState = {
  latestServerTime: number;
  clientRenderTime: number;
  pendingInputs: { seq: number; move_x: number; move_z: number; dt: number }[];
};

/**
 * This function initializes and returns a new Babylon.js Scene configured for the game. It sets up the scene's background color, creates a camera and environment, initializes data structures for players and game state, sets up network message handling and player input control, and starts the render loop. It also registers a cleanup handler that disposes of resources when the scene is disposed.
 */
export function createGameScene(
  engine: Engine | WebGPUEngine,
  canvas: HTMLCanvasElement,
  network: NetworkClient,
  localPlayerId: string | null,
): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.81, 0.89, 0.99, 1);

  const camera = createCamera(scene, canvas);
  createEnvironment(scene);

  const players = new Map<string, PlayerState>();
  const gameState: GameState = {
    latestServerTime: 0,
    clientRenderTime: 0,
    pendingInputs: [],
  };

  const offMessage = setupNetworkHandler(scene, network, players, localPlayerId, gameState);
  const controller = setupPlayerController();

  const renderLoop = setupRenderLoop(
    scene,
    engine,
    camera,
    players,
    controller,
    network,
    localPlayerId,
    gameState,
  );

  scene.onDisposeObservable.add(() => {
    controller.dispose();
    offMessage();
    scene.onBeforeRenderObservable.remove(renderLoop);
    for (const state of players.values()) {
      state.mesh.dispose();
    }
    players.clear();
  });

  return scene;
}

/**
 * Creates an ArcRotateCamera for the scene, attaches it to the provided canvas for user control, and disables default inputs to prevent unwanted camera movement.
 */
function createCamera(scene: Scene, canvas: HTMLCanvasElement) {
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
  return camera;
}

/**
 * Adds a hemispheric light to illuminate the scene and creates a ground box mesh positioned below the origin to serve as the floor.
 */
function createEnvironment(scene: Scene) {
  const light = new HemisphericLight("light", new Vector3(0, 1, 0.3), scene);
  light.intensity = 1;

  const ground = MeshBuilder.CreateBox(
    "ground",
    { width: 30, height: 1, depth: 10 },
    scene,
  );
  ground.position.y = -0.5;
}

/**
 * Sets up an event listener for network messages from the server. When a WorldSnapshot message is received, it processes the snapshot by updating the latest server time, ensuring all players from the snapshot are represented in the scene (creating or updating meshes), reconciling the local player's position with server state, updating remote players' snapshots, and removing meshes for disconnected players.
 */
function setupNetworkHandler(
  scene: Scene,
  network: NetworkClient,
  players: Map<string, PlayerState>,
  localPlayerId: string | null,
  gameState: GameState,
) {
  return network.onMessage((message: ServerMessage) => {
    const snapshot = readWorldSnapshot(message);
    if (!snapshot) return;

    gameState.latestServerTime = Math.max(gameState.latestServerTime, snapshot.server_time);
    const liveIds = new Set<string>();

    for (const snapshotPlayer of snapshot.players) {
      liveIds.add(snapshotPlayer.id);
      const state = upsertPlayerMesh(scene, players, snapshotPlayer);

      if (snapshotPlayer.id === localPlayerId) {
        reconcileLocalPlayer(state, snapshotPlayer, gameState.pendingInputs);
      } else {
        updateRemotePlayerSnapshots(state, snapshot);
      }
    }

    cleanupDisconnectedPlayers(players, liveIds);
  });
}

/**
 * Reconciles the local player's position with the server's authoritative state. It removes processed inputs from the pending list, reapplies unprocessed inputs to compute the expected position, and corrects the mesh position if the discrepancy is significant to prevent drift.
 */
function reconcileLocalPlayer(
  state: PlayerState,
  snapshotPlayer: SnapshotPlayer,
  pendingInputs: GameState["pendingInputs"],
) {
  let targetX = snapshotPlayer.x;
  let targetZ = snapshotPlayer.z;

  while (pendingInputs.length > 0 && pendingInputs[0].seq <= snapshotPlayer.last_processed_seq) {
    pendingInputs.shift();
  }

  for (const input of pendingInputs) {
    targetX += input.move_x * MOVE_SPEED * input.dt;
    targetZ += input.move_z * MOVE_SPEED * input.dt;
  }

  const diffX = targetX - state.mesh.position.x;
  const diffZ = targetZ - state.mesh.position.z;
  const distSq = diffX * diffX + diffZ * diffZ;

  // If error is significant (> ~0.3 units), snap to correct drift.
  // Otherwise, allow the slight discrepancy to stay to prevent micro-stutters.
  if (distSq > 0.1) {
    state.mesh.position.x = targetX;
    state.mesh.position.z = targetZ;
  }
}

/**
 * For a remote player, finds the corresponding snapshot player in the world snapshot, adds a new snapshot entry with the current server time and position, and maintains a maximum of 10 snapshots by removing the oldest if exceeded.
 */
function updateRemotePlayerSnapshots(state: PlayerState, snapshot: WorldSnapshot) {
  const snapshotPlayer = snapshot.players.find(p => `player-${p.id}` === state.mesh.name);
  if (!snapshotPlayer) return;

  state.snapshots.push({
    time: snapshot.server_time,
    x: snapshotPlayer.x,
    z: snapshotPlayer.z,
  });

  if (state.snapshots.length > 10) {
    state.snapshots.shift();
  }
}

/**
 * Iterates through all players, and for any player not present in the current live IDs set, disposes of their mesh and removes them from the players map.
 */
function cleanupDisconnectedPlayers(players: Map<string, PlayerState>, liveIds: Set<string>) {
  for (const [id, state] of players) {
    if (liveIds.has(id)) continue;
    state.mesh.dispose();
    players.delete(id);
  }
}

/**
 * Registers a before-render callback that handles local player movement based on input, updates the client render time for interpolation, and interpolates remote players' positions.
 */
function setupRenderLoop(
  scene: Scene,
  engine: Engine | WebGPUEngine,
  camera: ArcRotateCamera,
  players: Map<string, PlayerState>,
  controller: ReturnType<typeof setupPlayerController>,
  network: NetworkClient,
  localPlayerId: string | null,
  gameState: GameState,
) {
  let seq = 0;

  return scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000.0;
    
    handleLocalPlayerMovement(
      camera,
      players,
      controller,
      network,
      localPlayerId,
      gameState,
      dt,
      seq,
    );
    seq += 1;

    updateRenderTime(gameState, dt);
    interpolateRemotePlayers(players, localPlayerId, gameState.clientRenderTime);
  });
}

/**
 * Processes input from the controller, moves the local player's mesh accordingly, updates the camera to follow the player, sends the input to the server, and stores the input in pending inputs for reconciliation.
 */
function handleLocalPlayerMovement(
  camera: ArcRotateCamera,
  players: Map<string, PlayerState>,
  controller: ReturnType<typeof setupPlayerController>,
  network: NetworkClient,
  localPlayerId: string | null,
  gameState: GameState,
  dt: number,
  seq: number,
) {
  const input = controller.getInput();
  const ix = input.x;
  const iz = input.z;

  const localState = localPlayerId ? players.get(localPlayerId) : undefined;
  if (localPlayerId && localState) {
    localState.mesh.position.x += ix * MOVE_SPEED * dt;
    localState.mesh.position.z += iz * MOVE_SPEED * dt;

    camera.position.set(localState.mesh.position.x, 18, localState.mesh.position.z - 18);
    camera.setTarget(localState.mesh.position);

    network.sendMessage({
      Input: {
        seq,
        move_x: ix,
        move_y: iz,
      },
    });

    gameState.pendingInputs.push({ seq, move_x: ix, move_z: iz, dt });
  }
}

/**
 * Manages the client render time to lag behind server time by an interpolation delay. Initializes it when the first snapshot arrives, then advances it towards the target render time with smoothing.
 */
function updateRenderTime(gameState: GameState, dt: number) {
  const INTERPOLATION_DELAY = 100;
  if (gameState.clientRenderTime === 0 && gameState.latestServerTime > 0) {
    gameState.clientRenderTime = gameState.latestServerTime - INTERPOLATION_DELAY;
  } else if (gameState.latestServerTime > 0) {
    gameState.clientRenderTime += dt * 1000;
    const targetRenderTime = gameState.latestServerTime - INTERPOLATION_DELAY;
    const diff = targetRenderTime - gameState.clientRenderTime;
    gameState.clientRenderTime += diff * 0.1;
  }
}

/**
 * For each remote player, determines whether to extrapolate forward, snap to the earliest snapshot, or interpolate between snapshots based on the current render time relative to available snapshots.
 */
function interpolateRemotePlayers(
  players: Map<string, PlayerState>,
  localPlayerId: string | null,
  clientRenderTime: number,
) {
  for (const [id, state] of players) {
    if (id === localPlayerId) continue;
    const snaps = state.snapshots;
    if (snaps.length === 0) continue;

    if (clientRenderTime > snaps[snaps.length - 1].time) {
      extrapolateRemotePlayer(state, snaps, clientRenderTime);
    } else if (clientRenderTime < snaps[0].time) {
      state.mesh.position.x = snaps[0].x;
      state.mesh.position.z = snaps[0].z;
    } else {
      interpolateBetweenSnapshots(state, snaps, clientRenderTime);
    }
  }
}

/**
 * Estimates the player's position beyond the latest snapshot by calculating velocity from the last two snapshots and applying it for a limited time to avoid excessive extrapolation.
 */
function extrapolateRemotePlayer(state: PlayerState, snaps: RemoteSnapshot[], clientRenderTime: number) {
  const last = snaps[snaps.length - 1];
  let velocityX = 0;
  let velocityZ = 0;
  
  if (snaps.length > 1) {
    const secondLast = snaps[snaps.length - 2];
    const dtSnap = Math.max(1, last.time - secondLast.time);
    velocityX = (last.x - secondLast.x) / dtSnap;
    velocityZ = (last.z - secondLast.z) / dtSnap;
  }

  const overTime = clientRenderTime - last.time;
  if (overTime < 150) {
    state.mesh.position.x = last.x + velocityX * overTime;
    state.mesh.position.z = last.z + velocityZ * overTime;
  } else {
    state.mesh.position.x = last.x;
    state.mesh.position.z = last.z;
  }
}

/**
 * Finds the two snapshots that bracket the current render time, calculates the interpolation factor, and sets the mesh position as a linear interpolation between those snapshots.
 */
function interpolateBetweenSnapshots(state: PlayerState, snaps: RemoteSnapshot[], clientRenderTime: number) {
  let prev = snaps[0];
  let next = snaps[0];
  for (let i = 0; i < snaps.length - 1; i++) {
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

/**
 * Ensures a player mesh exists for the given snapshot player, creating one if necessary with a sphere geometry, positioning it, and assigning a material based on the player's color. Returns the player state.
 */
function upsertPlayerMesh(
  scene: Scene,
  players: Map<string, PlayerState>,
  snapshotPlayer: SnapshotPlayer,
): PlayerState {
  let playerState = players.get(snapshotPlayer.id);
  if (playerState) {
    return playerState;
  }

  const mesh = MeshBuilder.CreateSphere(`player-${snapshotPlayer.id}`, { diameter: 2 }, scene);
  mesh.position.y = 2;

  const material = new StandardMaterial(`player-mat-${snapshotPlayer.id}`, scene);
  material.diffuseColor = Color3.FromHexString(snapshotPlayer.color);
  mesh.material = material;

  playerState = { mesh, snapshots: [] };
  players.set(snapshotPlayer.id, playerState);
  return playerState;
}

/**
 * Checks if the server message contains a WorldSnapshot and returns it if so, otherwise returns null.
 */
function readWorldSnapshot(message: ServerMessage): WorldSnapshot | null {
  if (!("WorldSnapshot" in message)) {
    return null;
  }
  return message.WorldSnapshot as WorldSnapshot;
}

/**
 * Creates a player input controller that combines keyboard and joystick/touch inputs. It sets up event listeners for keyboard, nipplejs joystick if available, and pointer/touch events on the joystick zone. Provides a getInput method that normalizes and combines inputs, and a dispose method to clean up listeners.
 */
function setupPlayerController() {
  const keys = new Set<string>();
  const joy = { x: 0, y: 0 };

  const onKeyDown = (e: KeyboardEvent) => keys.add(e.key);
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const joyZone = document.getElementById("joystickZone") as HTMLDivElement | null;
  if (joyZone) joyZone.classList.add("is-active");
  let activePointerId: number | null = null;
  let activeTouchId: number | null = null;

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

  const updateJoy = (_: unknown, data: any) => {
    if (!data) return;
    const vx = data?.vector?.x;
    const vy = data?.vector?.y;
    if (typeof vx === "number" && typeof vy === "number") {
      joy.x = Math.max(-1, Math.min(1, vx));
      joy.y = Math.max(-1, Math.min(1, vy));
      return;
    }
    const a = data?.angle?.radian;
    const f = typeof data?.force === "number" ? data.force : 0;
    if (typeof a === "number") {
      const s = Math.max(0, Math.min(1, f));
      joy.x = Math.cos(a) * s;
      joy.y = Math.sin(a) * s;
    }
  };

  (jm as any)?.on("move", updateJoy);
  (jm as any)?.on("start", updateJoy);
  (jm as any)?.on("end", () => { joy.x = 0; joy.y = 0; });

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

  const onPointerDown = (e: PointerEvent) => {
    activePointerId = e.pointerId;
    updateJoyFromPointer(e.clientX, e.clientY);
    joyZone?.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerId !== activePointerId) return;
    updateJoyFromPointer(e.clientX, e.clientY);
    e.preventDefault();
  };

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

  const onTouchStart = (e: TouchEvent) => {
    const t = e.changedTouches[0];
    if (!t || activeTouchId !== null) return;
    activeTouchId = t.identifier;
    updateJoyFromPointer(t.clientX, t.clientY);
    e.preventDefault();
  };

  const onTouchMove = (e: TouchEvent) => {
    if (activeTouchId === null) return;
    const t = Array.from(e.changedTouches).find((touch) => touch.identifier === activeTouchId);
    if (!t) return;
    updateJoyFromPointer(t.clientX, t.clientY);
    e.preventDefault();
  };

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

  return {
    getInput() {
      const kx = (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0);
      const kz = (keys.has("ArrowUp") ? 1 : 0) - (keys.has("ArrowDown") ? 1 : 0);
      let ix = kx + joy.x;
      let iz = kz + joy.y;

      const lengthSq = ix * ix + iz * iz;
      if (lengthSq > 1.0) {
        const length = Math.sqrt(lengthSq);
        ix /= length;
        iz /= length;
      } else if (lengthSq === 0) {
        ix = 0;
        iz = 0;
      }
      return { x: ix, z: iz };
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
      jm?.destroy();
      joyZone?.classList.remove("is-active");
    }
  };
}
