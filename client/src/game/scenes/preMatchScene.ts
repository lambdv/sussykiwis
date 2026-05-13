import nipplejs from "nipplejs";
import {
  ArcRotateCamera,
  Color4,
  Engine,
  Mesh,
  Scene,
  StandardMaterial,
  WebGPUEngine,
} from "@babylonjs/core";
import { NetworkClient } from "../../networking/client";
import type { PlayerRole, ServerMessage, SnapshotPlayer, WorldSnapshot } from "../../networking/message";
import { cameraRelativeMovement } from "../cameraMovement";
import { createPlayerTag, type PlayerTagState } from "../playerTag";
import {
  applyWorldTheme,
  clampPositionToPhaseBounds,
  createSharedWorldArena,
  createSharedWorldCamera,
  createWorldLight,
  createWorldPlayerMesh,
  DEFAULT_MAP_HALF_EXTENT,
  getSnapshotMapHalfExtent,
  setMeshHeight,
} from "../world";

type RemoteSnapshot = { time: number; x: number; z: number };

type PlayerMeshState = {
  mesh: Mesh;
  material: StandardMaterial;
  tag: PlayerTagState;
  snapshots: RemoteSnapshot[];
};

type PendingInput = { seq: number; moveX: number; moveZ: number; dt: number };

type SessionState = {
  latestServerTime: number;
  clientRenderTime: number;
  pendingInputs: PendingInput[];
  moveSpeed: number;
  latestSnapshot: WorldSnapshot | null;
  localPlayerId: string | null;
  localRole: PlayerRole | null;
  notice: string;
  countdownEndsAt: number | null;
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

  const { camera } = createSharedWorldCamera(scene, { name: "prematch-camera", canvas, halfHeight: 28 });
  const arena = createEnvironment(scene);
  applyWorldTheme(scene, arena, "lobby", []);

  const players = new Map<string, PlayerMeshState>();
  const controller = setupPlayerController();
  const hud = createPreMatchHud();
  const session: SessionState = {
    latestServerTime: 0,
    clientRenderTime: 0,
    pendingInputs: [],
    moveSpeed: network.getMoveSpeed(),
    latestSnapshot: null,
    localPlayerId,
    localRole: null,
    notice: "Waiting for players",
    countdownEndsAt: null,
  };

  const offMessage = network.onMessage((message) => {
    // Keep this scene in sync with world snapshots and auto-enter match when ready.
    handleServerMessage(scene, arena, players, message, localPlayerId, session, callbacks);
    updatePreMatchHud(hud, session);
  });

  const renderLoop = scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000.0;
    // Keep movement responsive until the authoritative match scene takes over.
    handleLocalPlayerMovement(camera, players, controller, network, localPlayerId, session, dt);
    updateRenderTime(session, dt);
    interpolateRemotePlayers(players, localPlayerId, session.clientRenderTime);
    updateCountdown(session);
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

function createEnvironment(scene: Scene) {
  createWorldLight(scene);
  return createSharedWorldArena(scene, {
    prefix: "prematch",
    groundColor: "#4f7d5c",
    wallColor: "#ffd166",
    initialMapHalfExtent: DEFAULT_MAP_HALF_EXTENT,
  });
}

function handleServerMessage(
  scene: Scene,
  arena: ReturnType<typeof createEnvironment>,
  players: Map<string, PlayerMeshState>,
  message: ServerMessage,
  localPlayerId: string | null,
  session: SessionState,
  callbacks: { onMatchReady: () => void },
) {
  if (message.type === "game_started") {
    session.localRole = message.role;
    session.notice = `Role assigned: ${formatRoleName(message.role)}`;
    return;
  }

  // Respond only to live world snapshots while in pre-match.
  if (message.type !== "world_snapshot") {
    return;
  }

  handleSnapshot(scene, arena, players, message.snapshot, localPlayerId, session);

  // Switch scenes as soon as the authoritative server says the round is live.
  if (message.snapshot.subState === "in_game") {
    cancelCountdown(session);
    callbacks.onMatchReady();
    return;
  }

  syncCountdown(session, message.snapshot);
}

function handleSnapshot(
  scene: Scene,
  arena: ReturnType<typeof createEnvironment>,
  players: Map<string, PlayerMeshState>,
  snapshot: WorldSnapshot,
  localPlayerId: string | null,
  session: SessionState,
) {
  session.latestSnapshot = snapshot;
  session.latestServerTime = Math.max(session.latestServerTime, snapshot.serverTime);
  arena.updateBounds(snapshot.mapHalfExtent, snapshot.phase);
  applyWorldTheme(scene, arena, snapshot.phase, snapshot.activeSabotages);

  if (!session.localRole && session.localPlayerId) {
    const localPlayer = snapshot.players.find((player) => player.id === session.localPlayerId);
    if (localPlayer) {
      session.localRole = localPlayer.role;
      session.notice = `Role assigned: ${formatRoleName(localPlayer.role)}`;
    }
  }

  if (session.countdownEndsAt === null && !session.localRole) {
    session.notice = `Game starts when ${snapshot.expectedPlayers - snapshot.joinedPlayers} more players join`;
  }

  const livePlayerIds = new Set<string>();
  for (const snapshotPlayer of snapshot.players) {
    livePlayerIds.add(snapshotPlayer.id);
    const state = upsertPlayerMesh(scene, players, snapshotPlayer);

    if (snapshotPlayer.id === localPlayerId) {
      reconcileLocalPlayer(state, snapshotPlayer, session.pendingInputs, session.moveSpeed, snapshot.mapHalfExtent);
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

    setMeshHeight(state.mesh, snapshotPlayer.state);
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
  const seq = network.nextInputSeq();
  const movement = cameraRelativeMovement(input.x, input.z, camera.alpha);
  const ix = movement.x;
  const iz = movement.z;
  const localState = localPlayerId ? players.get(localPlayerId) : undefined;

  if (localPlayerId && localState) {
    const mapHalfExtent = getSnapshotMapHalfExtent(session.latestSnapshot);
    const clamped = clampPositionToPhaseBounds(
      localState.mesh.position.x + ix * session.moveSpeed * dt,
      localState.mesh.position.z + iz * session.moveSpeed * dt,
      mapHalfExtent,
      "lobby",
    );
    localState.mesh.position.x = clamped.x;
    localState.mesh.position.z = clamped.z;
    session.pendingInputs.push({ seq, moveX: ix, moveZ: iz, dt });
    if (session.pendingInputs.length > 120) {
      session.pendingInputs.shift();
    }
  }

  if (localState) {
    // Keep the camera centered on the local player without changing the angle.
    camera.setTarget(localState.mesh.position);
  }

  network.sendMessage({
    type: "input",
    seq,
    moveX: ix,
    moveY: iz,
  });
}

function reconcileLocalPlayer(
  state: PlayerMeshState,
  snapshotPlayer: SnapshotPlayer,
  pendingInputs: PendingInput[],
  moveSpeed: number,
  mapHalfExtent: number,
) {
  // Reconcile local prediction against authoritative server input acknowledgements.
  let targetX = snapshotPlayer.x;
  let targetZ = snapshotPlayer.z;

  while (pendingInputs.length > 0 && pendingInputs[0].seq <= snapshotPlayer.lastProcessedSeq) {
    pendingInputs.shift();
  }

  for (const input of pendingInputs) {
    targetX += input.moveX * moveSpeed * input.dt;
    targetZ += input.moveZ * moveSpeed * input.dt;
  }

  const clamped = clampPositionToPhaseBounds(targetX, targetZ, mapHalfExtent, "lobby");
  const clampedX = clamped.x;
  const clampedZ = clamped.z;
  const dx = clampedX - state.mesh.position.x;
  const dz = clampedZ - state.mesh.position.z;
  const distSq = dx * dx + dz * dz;

  // Snap the local player unless the correction is tiny, which avoids spawn jitter.
  if (distSq > 0.1) {
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

  const { mesh, material } = createWorldPlayerMesh(scene, `prematch-player-${snapshotPlayer.id}`, snapshotPlayer.color);
  mesh.position.set(snapshotPlayer.x, 2, snapshotPlayer.z);

  const tag = createPlayerTag(scene, snapshotPlayer.id, snapshotPlayer.name);
  tag.mesh.parent = mesh;

  const playerState = { mesh, material, tag, snapshots: [] };
  players.set(snapshotPlayer.id, playerState);
  return playerState;
}

function cleanupDisconnectedPlayers(players: Map<string, PlayerMeshState>, liveIds: Set<string>) {
  // Remove meshes for players no longer present in authoritative snapshots.
  for (const [id, state] of players) {
    if (liveIds.has(id)) continue;
    state.mesh.dispose();
    state.material.dispose();
    state.tag.mesh.dispose();
    state.tag.material.dispose();
    state.tag.texture.dispose();
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

function cancelCountdown(session: SessionState) {
  // Stop the countdown if the lobby is no longer full.
  session.countdownEndsAt = null;
  const snapshot = session.latestSnapshot;
  session.notice = snapshot
    ? `Game starts when ${snapshot.expectedPlayers - snapshot.joinedPlayers} more players join`
    : "Waiting for players";
}

function syncCountdown(session: SessionState, snapshot: WorldSnapshot) {
  // Mirror the server-owned lobby countdown so every client sees the same start time.
  if (snapshot.lobbyCountdownEndsAt === null) {
    cancelCountdown(session);
    return;
  }

  session.countdownEndsAt = snapshot.lobbyCountdownEndsAt;
  updateCountdown(session);
}

function formatRoleName(role: PlayerRole) {
  // Convert internal role ids into player-facing labels.
  return role === "imposter" ? "Imposter" : role === "sheriff" ? "Sheriff" : "View Mate";
}

function updateCountdown(session: SessionState) {
  // Refresh the displayed countdown every frame so it stays in sync.
  if (session.countdownEndsAt === null) return;

  const serverTime = session.latestSnapshot?.serverTime ?? session.latestServerTime;
  const secondsLeft = Math.max(0, Math.ceil((session.countdownEndsAt - serverTime) / 1000));
  session.notice = `Match starting in ${secondsLeft}`;
}

function setupPlayerController() {
  // Merge keyboard and joystick movement into one normalized input vector.
  const keys = new Set<string>();
  const joy = { x: 0, y: 0 };

  const onKeyDown = (event: KeyboardEvent) => keys.add(event.key);
  const onKeyUp = (event: KeyboardEvent) => keys.delete(event.key);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const joyZone = document.getElementById("joystickZone") as HTMLDivElement | null;
  if (joyZone) {
    joyZone.innerHTML = "";
    joyZone.classList.add("is-active");
  }
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

      return { x: inputX, z: inputZ };
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
