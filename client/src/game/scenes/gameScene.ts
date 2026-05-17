import nipplejs from "nipplejs";
import {
  AbstractMesh,
  ArcRotateCamera,
  Color4,
  Engine,
  Mesh,
  PointerEventTypes,
  Scene,
  TransformNode,
  WebGPUEngine,
} from "@babylonjs/core";
import { NetworkClient } from "../../networking/client";
import { Logger, LOG_SCOPES } from "../../logger";
import type {
  GamePhase,
  PlayerRole,
  PlayerState,
  PuzzleProjectionState,
  PuzzleStationSnapshot,
  ServerMessage,
  SnapshotDeadBody,
  SnapshotPlayer,
  WorldSnapshot,
} from "../../networking/message";
import { createPuzzleModal } from "../puzzles/puzzleModal";
import { drawTimerPuzzleScene } from "../puzzles/timerPuzzleScene";
import { drawWiresPuzzleScene } from "../puzzles/wiresPuzzleScene";
import { cameraRelativeMovement } from "../cameraMovement";
import { createPlayerTag, type PlayerTagState } from "../playerTag";
import {
  applyPlayerFacing,
  applyGrayPlayerTint,
  applyWorldTheme,
  clampPositionToPhaseBounds,
  createSharedWorldArena,
  createSharedWorldCamera,
  createWorldBodyMesh,
  createWorldLight,
  createWorldPuzzleStationMesh,
  createWorldPlayerMesh,
  DEFAULT_MAP_HALF_EXTENT,
  getFacingYawFromMovement,
  getSnapshotMapHalfExtent,
  lerpAngle,
  setMeshHeight,
  type WorldPuzzleStationMesh,
} from "../world";

export type WinSceneData = {
  snapshot: WorldSnapshot;
  winner: "crew" | "imposters";
  reason: string;
};

const BODY_INTERACTION_RANGE_SQ = 16;
const KILL_INTERACTION_RANGE_SQ = 36;
const PUZZLE_INTERACTION_RANGE_SQ = 20.25;
const CAMERA_ORTHO_HALF_HEIGHT = 28;

type RemoteSnapshot = { time: number; x: number; z: number; facingYaw: number };

type PlayerMeshState = {
  mesh: TransformNode;
  tag: PlayerTagState;
  snapshots: RemoteSnapshot[];
};

type BodyMeshState = {
  mesh: Mesh;
};

type PuzzleStationMeshState = WorldPuzzleStationMesh;

type PendingInput = { seq: number; moveX: number; moveZ: number; dt: number; facingYaw: number | null };

type SessionState = {
  latestServerTime: number;
  clientRenderTime: number;
  pendingInputs: PendingInput[];
  moveSpeed: number;
  localRole: PlayerRole | null;
  phase: GamePhase;
  latestSnapshot: WorldSnapshot | null;
  notice: string;
};

type HudState = {
  root: HTMLDivElement;
  status: HTMLDivElement;
  actions: HTMLDivElement;
  meeting: HTMLDivElement;
  reportButton: HudButtonState;
  killButton: HudButtonState;
  lightsButton: HudButtonState;
  grayButton: HudButtonState;
  puzzleButton: HudButtonState;
};

type HudButtonState = {
  button: HTMLButtonElement;
  setEnabled: (enabled: boolean) => void;
  setLabel: (label: string) => void;
  setAction: (action: (() => void) | null) => void;
};

export async function createGameScene(
  engine: Engine | WebGPUEngine,
  canvas: HTMLCanvasElement,
  network: NetworkClient,
  localPlayerId: string | null,
  initialRole: PlayerRole | null,
  callbacks?: {
    onPhase: (phase: "meeting" | "ejected" | "noEjection") => void;
    onWin: (data: WinSceneData) => void;
  },
): Promise<Scene> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.81, 0.89, 0.99, 1);

  const { camera } = createSharedWorldCamera(scene, { name: "camera", canvas, halfHeight: CAMERA_ORTHO_HALF_HEIGHT });
  const arena = createEnvironment(scene);
  applyWorldTheme(scene, arena, "playing", []);

  const players = new Map<string, PlayerMeshState>();
  const bodies = new Map<string, BodyMeshState>();
  const puzzleStations = new Map<string, PuzzleStationMeshState>();
  const controller = setupPlayerController();
  const hud = createHud();
  const puzzleModal = createPuzzleModal(network);
  const session: SessionState = {
    latestServerTime: 0,
    clientRenderTime: 0,
    pendingInputs: [],
    moveSpeed: network.getMoveSpeed(),
    localRole: initialRole,
    phase: "lobby",
    latestSnapshot: null,
    notice: initialRole ? `Role: ${initialRole}` : "Waiting for match start...",
  };

  const offPuzzlePointer = setupPuzzlePointerInteraction(scene, canvas, network, localPlayerId, session, puzzleStations);

  const offMessage = network.onMessage((message) => {
    handleServerMessage(scene, arena, players, bodies, puzzleStations, message, localPlayerId, session, callbacks);
    updateHud(hud, session, localPlayerId, network);
  });

  const renderLoop = scene.onBeforeRenderObservable.add(() => {
    const dt = engine.getDeltaTime() / 1000.0;
    handleLocalPlayerMovement(
      camera,
      players,
      controller,
      network,
      localPlayerId,
      session,
      dt,
    );

    updateRenderTime(session, dt);
    interpolateRemotePlayers(players, localPlayerId, session.clientRenderTime);
    applySabotageVisuals(scene, arena, players, session.latestSnapshot);
    updateHud(hud, session, localPlayerId, network);
    updatePuzzleModal(puzzleModal, session.latestSnapshot, localPlayerId);
  });

  scene.onDisposeObservable.add(() => {
    controller.dispose();
    offMessage();
    offPuzzlePointer();
    scene.onBeforeRenderObservable.remove(renderLoop);
    hud.root.remove();
    puzzleModal.dispose();
    for (const player of players.values()) {
      player.mesh.dispose();
    }
    for (const body of bodies.values()) {
      body.mesh.dispose();
    }
    for (const station of puzzleStations.values()) {
      station.mesh.dispose();
      station.material.dispose();
      station.projectionMesh.dispose();
      station.projectionMaterial.dispose();
      station.projectionTexture.dispose();
    }
    players.clear();
    bodies.clear();
    puzzleStations.clear();
  });

  return scene;
}

function createEnvironment(scene: Scene) {
  createWorldLight(scene);
  return createSharedWorldArena(scene, {
    prefix: "game",
    groundColor: "#243b55",
    wallColor: "#8bb4ff",
    initialMapHalfExtent: DEFAULT_MAP_HALF_EXTENT,
  });
}

function handleServerMessage(
  scene: Scene,
  arena: ReturnType<typeof createEnvironment>,
  players: Map<string, PlayerMeshState>,
  bodies: Map<string, BodyMeshState>,
  puzzleStations: Map<string, PuzzleStationMeshState>,
  message: ServerMessage,
  localPlayerId: string | null,
  session: SessionState,
  callbacks?: {
    onPhase: (phase: "meeting" | "ejected" | "noEjection") => void;
    onWin: (data: WinSceneData) => void;
  },
) {
  switch (message.type) {
    case "welcome":
      session.notice = `Connected as ${message.name}`;
      Logger.info(LOG_SCOPES.GAME, "CLIENT: connected to game server", {
        name: message.name,
      });
      break;
    case "game_started":
      session.localRole = message.role;
      session.notice = `Role: ${message.role}`;
      Logger.info(LOG_SCOPES.STATE, "CLIENT: game started", {
        role: message.role,
      });
      break;
    case "meeting_started":
      session.notice = `Meeting started for body ${message.reportedBodyId.slice(0, 6)}`;
      Logger.info(LOG_SCOPES.STATE, "CLIENT: meeting started", {
        bodyId: message.reportedBodyId,
      });
      callbacks?.onPhase("meeting");
      break;
    case "vote_update":
      session.notice = `Votes: ${message.votesCast}/${message.totalVoters}`;
      break;
    case "ejection_result":
      session.notice = message.playerId
        ? `${message.playerId.slice(0, 6)} ejected${message.wasImposter ? " (imposter)" : ""}`
        : "No one was ejected";
      Logger.info(LOG_SCOPES.STATE, "CLIENT: ejection result", {
        ejectedId: message.playerId,
        wasImposter: message.wasImposter,
      });
      callbacks?.onPhase(message.playerId ? "ejected" : "noEjection");
      break;
    case "win":
      session.notice = `${message.winner} win: ${message.reason}`;
      Logger.info(LOG_SCOPES.STATE, "CLIENT: game ended", {
        winner: message.winner,
        reason: message.reason,
      });
      if (callbacks && session.latestSnapshot) {
        callbacks.onWin({
          snapshot: session.latestSnapshot,
          winner: message.winner,
          reason: message.reason,
        });
      }
      break;
    case "world_snapshot":
      // Late joiners may miss the initial role packet, so derive it from the authoritative snapshot.
      if (!session.localRole && localPlayerId) {
        const localPlayer = message.snapshot.players.find((player) => player.id === localPlayerId);
        if (localPlayer) {
          session.localRole = localPlayer.role;
          session.notice = `Role: ${localPlayer.role}`;
        }
      }
      handleSnapshot(scene, arena, players, bodies, puzzleStations, message.snapshot, localPlayerId, session, callbacks);
      break;
  }
}

function handleSnapshot(
  scene: Scene,
  arena: ReturnType<typeof createEnvironment>,
  players: Map<string, PlayerMeshState>,
  bodies: Map<string, BodyMeshState>,
  puzzleStations: Map<string, PuzzleStationMeshState>,
  snapshot: WorldSnapshot,
  localPlayerId: string | null,
  session: SessionState,
  callbacks?: {
    onPhase: (phase: "meeting" | "ejected" | "noEjection") => void;
    onWin: (data: WinSceneData) => void;
  },
) {
  session.latestSnapshot = snapshot;
  const prevPhase = session.phase;
  session.phase = snapshot.phase;
  session.latestServerTime = Math.max(session.latestServerTime, snapshot.serverTime);

  if (prevPhase !== snapshot.phase) {
    Logger.info(LOG_SCOPES.STATE, "CLIENT: phase change", {
      from: prevPhase,
      to: snapshot.phase,
    });
  }

  arena.updateBounds(snapshot.mapHalfExtent, snapshot.phase);

  if (snapshot.phase === "win" && snapshot.win) {
    callbacks?.onWin({ snapshot, winner: snapshot.win.winner, reason: snapshot.win.reason });
  }

  const livePlayerIds = new Set<string>();
  for (const snapshotPlayer of snapshot.players) {
    livePlayerIds.add(snapshotPlayer.id);
    const state = upsertPlayerMesh(scene, players, snapshotPlayer);
    updatePlayerTagColor(state.tag, snapshotPlayer.role, session.localRole);
    // Ghosts still move, but they should not render in the normal player view.
    const isGhost = snapshotPlayer.state === "ghost";
    state.mesh.isVisible = !isGhost;
    state.tag.mesh.isVisible = !isGhost;

    if (snapshotPlayer.id === localPlayerId) {
      reconcileLocalPlayer(state, snapshotPlayer, session.pendingInputs, session.moveSpeed, snapshot.mapHalfExtent, snapshot.phase);
    } else {
      state.snapshots.push({
        time: snapshot.serverTime,
        x: snapshotPlayer.x,
        z: snapshotPlayer.z,
        facingYaw: snapshotPlayer.facingYaw,
      });

      if (state.snapshots.length > 10) {
        state.snapshots.shift();
      }
    }

    setMeshHeight(state.mesh, snapshotPlayer.state);
    if (snapshotPlayer.id !== localPlayerId) {
      applyPlayerFacing(state.mesh, snapshotPlayer.facingYaw);
    }
  }

  cleanupDisconnectedPlayers(players, livePlayerIds);

  const liveBodyIds = new Set<string>();
  for (const body of snapshot.deadBodies) {
    liveBodyIds.add(body.id);
    const bodyState = upsertBodyMesh(scene, bodies, body);
    bodyState.mesh.position.x = body.x;
    bodyState.mesh.position.z = body.z;
    // Keep bodies visible for consistency even after reported state flips.
    bodyState.mesh.isVisible = true;
  }

  cleanupDisconnectedBodies(bodies, liveBodyIds);
  syncPuzzleStations(scene, puzzleStations, snapshot, localPlayerId);
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
  const input = controller.getInput();
  const seq = network.nextInputSeq();
  const movement = cameraRelativeMovement(input.x, input.z, camera.alpha);
  const ix = movement.x;
  const iz = movement.z;
  const facingYaw = (ix * ix) + (iz * iz) > 0 ? getFacingYawFromMovement(ix, iz) : null;

  const localState = localPlayerId ? players.get(localPlayerId) : undefined;
  const localPlayer = localPlayerId ? session.latestSnapshot?.players.find((player) => player.id === localPlayerId) : undefined;

  if (localPlayerId && localState && localPlayer && canLocallyMove(session.phase, localPlayer.state)) {
    const mapHalfExtent = getSnapshotMapHalfExtent(session.latestSnapshot);
    const clamped = clampPositionToPhaseBounds(
      localState.mesh.position.x + ix * session.moveSpeed * dt,
      localState.mesh.position.z + iz * session.moveSpeed * dt,
      mapHalfExtent,
      session.phase,
    );
    localState.mesh.position.x = clamped.x;
    localState.mesh.position.z = clamped.z;
    if (facingYaw !== null) {
      // Keep predicted facing aligned with the latest movement input.
      applyPlayerFacing(localState.mesh, facingYaw);
    }
    session.pendingInputs.push({ seq, moveX: ix, moveZ: iz, dt, facingYaw });
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

function canLocallyMove(phase: GamePhase, state: PlayerState) {
  return phase === "playing" && (state === "alive" || state === "ghost");
}

function reconcileLocalPlayer(
  state: PlayerMeshState,
  snapshotPlayer: SnapshotPlayer,
  pendingInputs: PendingInput[],
  moveSpeed: number,
  mapHalfExtent: number,
  phase: GamePhase,
) {
  let targetX = snapshotPlayer.x;
  let targetZ = snapshotPlayer.z;
  let targetFacingYaw = snapshotPlayer.facingYaw;

  while (pendingInputs.length > 0 && pendingInputs[0].seq <= snapshotPlayer.lastProcessedSeq) {
    pendingInputs.shift();
  }

  for (const input of pendingInputs) {
    targetX += input.moveX * moveSpeed * input.dt;
    targetZ += input.moveZ * moveSpeed * input.dt;
    if (input.facingYaw !== null) {
      targetFacingYaw = input.facingYaw;
    }
  }

  const clamped = clampPositionToPhaseBounds(targetX, targetZ, mapHalfExtent, phase);
  targetX = clamped.x;
  targetZ = clamped.z;

  const diffX = targetX - state.mesh.position.x;
  const diffZ = targetZ - state.mesh.position.z;
  const distSq = diffX * diffX + diffZ * diffZ;

  if (distSq > 0.1) {
    state.mesh.position.x = targetX;
    state.mesh.position.z = targetZ;
  }

  applyPlayerFacing(state.mesh, targetFacingYaw);
}

function updateRenderTime(session: SessionState, dt: number) {
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
  for (const [id, state] of players) {
    if (id === localPlayerId) continue;
    const snaps = state.snapshots;
    if (snaps.length === 0) continue;

    if (clientRenderTime > snaps[snaps.length - 1].time) {
      extrapolateRemotePlayer(state, snaps, clientRenderTime);
    } else if (clientRenderTime < snaps[0].time) {
      state.mesh.position.x = snaps[0].x;
      state.mesh.position.z = snaps[0].z;
      applyPlayerFacing(state.mesh, snaps[0].facingYaw);
    } else {
      interpolateBetweenSnapshots(state, snaps, clientRenderTime);
    }
  }
}

function extrapolateRemotePlayer(state: PlayerMeshState, snaps: RemoteSnapshot[], clientRenderTime: number) {
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

  applyPlayerFacing(state.mesh, last.facingYaw);
}

function interpolateBetweenSnapshots(state: PlayerMeshState, snaps: RemoteSnapshot[], clientRenderTime: number) {
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
  applyPlayerFacing(state.mesh, lerpAngle(prev.facingYaw, next.facingYaw, alpha));
}

function upsertPlayerMesh(
  scene: Scene,
  players: Map<string, PlayerMeshState>,
  snapshotPlayer: SnapshotPlayer,
): PlayerMeshState {
  const existing = players.get(snapshotPlayer.id);
  if (existing) {
    return existing;
  }

  const { mesh } = createWorldPlayerMesh(scene, `player-${snapshotPlayer.id}`, snapshotPlayer.color);
  mesh.position.set(snapshotPlayer.x, 2, snapshotPlayer.z);
  applyPlayerFacing(mesh, snapshotPlayer.facingYaw);

  const tag = createPlayerTag(scene, snapshotPlayer.id, snapshotPlayer.name);
  tag.mesh.parent = mesh;

  const playerState = { mesh, tag, snapshots: [] };
  players.set(snapshotPlayer.id, playerState);
  return playerState;
}

function updatePlayerTagColor(tag: PlayerTagState, playerRole: PlayerRole, localRole: PlayerRole | null) {
  // Only an impostor client gets the red impostor-name reveal.
  tag.setTextColor(localRole === "imposter" && playerRole === "imposter" ? "#ff4d4d" : "#ffffff");
}

function upsertBodyMesh(
  scene: Scene,
  bodies: Map<string, BodyMeshState>,
  body: SnapshotDeadBody,
): BodyMeshState {
  const existing = bodies.get(body.id);
  if (existing) {
    return existing;
  }

  // Represent dead bodies as short capsules lying on the ground.
  const { mesh } = createWorldBodyMesh(scene, `body-${body.id}`);

  const bodyState = { mesh };
  bodies.set(body.id, bodyState);
  return bodyState;
}

function cleanupDisconnectedPlayers(players: Map<string, PlayerMeshState>, liveIds: Set<string>) {
  for (const [id, state] of players) {
    if (liveIds.has(id)) continue;
    state.mesh.dispose();
    state.tag.mesh.dispose();
    state.tag.material.dispose();
    state.tag.texture.dispose();
    players.delete(id);
  }
}

function cleanupDisconnectedBodies(bodies: Map<string, BodyMeshState>, liveIds: Set<string>) {
  for (const [id, state] of bodies) {
    if (liveIds.has(id)) continue;
    state.mesh.dispose();
    bodies.delete(id);
  }
}

function syncPuzzleStations(
  scene: Scene,
  puzzleStations: Map<string, PuzzleStationMeshState>,
  snapshot: WorldSnapshot,
  localPlayerId: string | null,
) {
  // Keep one shared world station mesh per authoritative puzzle station.
  const liveIds = new Set<string>();
  for (const station of snapshot.puzzleStations) {
    liveIds.add(station.id);
    const meshState = upsertPuzzleStationMesh(scene, puzzleStations, station);
    meshState.mesh.position.x = station.x;
    meshState.mesh.position.z = station.z;
    meshState.setStatus(Boolean(localPlayerId && station.completedBy.includes(localPlayerId)), station.occupiedBy !== null);
    drawPuzzleProjection(meshState, station.projection);
  }

  for (const [id, state] of puzzleStations) {
    if (liveIds.has(id)) continue;
    state.mesh.dispose();
    state.material.dispose();
    state.projectionMaterial.dispose();
    state.projectionTexture.dispose();
    puzzleStations.delete(id);
  }
}

function upsertPuzzleStationMesh(
  scene: Scene,
  puzzleStations: Map<string, PuzzleStationMeshState>,
  station: PuzzleStationSnapshot,
) {
  const existing = puzzleStations.get(station.id);
  if (existing) {
    return existing;
  }

  // Reuse the same pedestal and hologram model in every world-facing scene.
  const meshState = createWorldPuzzleStationMesh(scene, `puzzle-station-${station.id}`, station.kind);
  puzzleStations.set(station.id, meshState);
  return meshState;
}

function drawPuzzleProjection(meshState: PuzzleStationMeshState, projection: PuzzleProjectionState | null) {
  const context = meshState.projectionTexture.getContext() as unknown as CanvasRenderingContext2D | null;
  if (!projection || !context) {
    meshState.projectionMesh.isVisible = false;
    return;
  }

  if (projection.kind === "timer") {
    drawTimerPuzzleScene(context, 1024, 1024, projection);
  } else {
    drawWiresPuzzleScene(context, 1024, 1024, projection, { fromIndex: null, pointerX: 0, pointerY: 0 });
  }

  meshState.projectionMesh.isVisible = true;
  meshState.projectionTexture.update(false);
}

function setupPuzzlePointerInteraction(
  scene: Scene,
  canvas: HTMLCanvasElement,
  network: NetworkClient,
  localPlayerId: string | null,
  session: SessionState,
  puzzleStations: Map<string, PuzzleStationMeshState>,
) {
  const observer = scene.onPointerObservable.add((pointerInfo) => {
    if (pointerInfo.type !== PointerEventTypes.POINTERDOWN || !session.latestSnapshot || !localPlayerId) {
      return;
    }

    const localPlayer = session.latestSnapshot.players.find((player) => player.id === localPlayerId);
    if (!localPlayer || !canPlayerWorkPuzzle(session.phase, localPlayer)) {
      return;
    }

    if (session.latestSnapshot.puzzleStations.some((station) => station.occupiedBy === localPlayerId)) {
      return;
    }

    const pointerEvent = pointerInfo.event as PointerEvent;
    const rect = canvas.getBoundingClientRect();
    const pickX = ((pointerEvent.clientX - rect.left) / Math.max(1, rect.width)) * scene.getEngine().getRenderWidth();
    const pickY = ((pointerEvent.clientY - rect.top) / Math.max(1, rect.height)) * scene.getEngine().getRenderHeight();
    const pick = scene.pick(pickX, pickY, (mesh) => {
      for (const state of puzzleStations.values()) {
        if (mesh === state.mesh) {
          return true;
        }
      }

      return false;
    });
    const stationId = pick?.pickedMesh ? findPuzzleStationIdByMesh(puzzleStations, pick.pickedMesh) : null;
    if (!stationId) {
      return;
    }

    const nearbyPuzzle = findNearbyPuzzle(localPlayer.x, localPlayer.z, localPlayer.id, session.latestSnapshot.puzzleStations);
    if (!nearbyPuzzle || nearbyPuzzle.id !== stationId) {
      return;
    }

    network.sendMessage({ type: "start_puzzle", stationId });
  });

  return () => {
    scene.onPointerObservable.remove(observer);
  };
}

function findPuzzleStationIdByMesh(
  puzzleStations: Map<string, PuzzleStationMeshState>,
  mesh: AbstractMesh,
) {
  for (const [id, state] of puzzleStations) {
    if (state.mesh === mesh) {
      return id;
    }
  }

  return null;
}

function updatePuzzleModal(
  puzzleModal: ReturnType<typeof createPuzzleModal>,
  snapshot: WorldSnapshot | null,
  localPlayerId: string | null,
) {
  if (!snapshot || !localPlayerId || snapshot.phase !== "playing") {
    puzzleModal.update({ station: null, player: null });
    return;
  }

  const player = snapshot.players.find((entry) => entry.id === localPlayerId) ?? null;
  const station = snapshot.puzzleStations.find((entry) => entry.occupiedBy === localPlayerId) ?? null;
  puzzleModal.update({ station, player });
}

function canPlayerWorkPuzzle(phase: GamePhase, player: SnapshotPlayer) {
  return phase === "playing"
    && (player.role === "crewmate" || player.role === "sheriff")
    && (player.state === "alive" || player.state === "ghost");
}

function findNearbyPuzzle(
  x: number,
  z: number,
  localPlayerId: string,
  puzzleStations: PuzzleStationSnapshot[],
) {
  let nearest: PuzzleStationSnapshot | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const station of puzzleStations) {
    if (station.occupiedBy !== null || station.completedBy.includes(localPlayerId)) {
      continue;
    }

    const dx = station.x - x;
    const dz = station.z - z;
    const distanceSq = (dx * dx) + (dz * dz);
    if (distanceSq > PUZZLE_INTERACTION_RANGE_SQ || distanceSq >= nearestDistance) {
      continue;
    }

    nearest = station;
    nearestDistance = distanceSq;
  }

  return nearest;
}

function applySabotageVisuals(
  scene: Scene,
  arena: ReturnType<typeof createEnvironment>,
  players: Map<string, PlayerMeshState>,
  snapshot: WorldSnapshot | null,
) {
  if (!snapshot) {
    return;
  }

  applyWorldTheme(scene, arena, snapshot.phase, snapshot.activeSabotages);
  applyGrayPlayerTint(players, snapshot.players, snapshot.activeSabotages);
}

function createHud(): HudState {
  const root = document.createElement("div");
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.pointerEvents = "none";
  root.style.zIndex = "20";
  root.style.fontFamily = "system-ui, sans-serif";

  const status = document.createElement("div");
  status.style.position = "absolute";
  status.style.top = "1rem";
  status.style.left = "1rem";
  status.style.maxWidth = "18rem";
  status.style.padding = "0.75rem 1rem";
  status.style.borderRadius = "0.75rem";
  status.style.background = "rgba(12, 18, 28, 0.85)";
  status.style.color = "#f4f8ff";
  status.style.fontSize = "0.95rem";
  status.style.pointerEvents = "auto";

  const actions = document.createElement("div");
  actions.style.position = "absolute";
  actions.style.right = "1rem";
  actions.style.bottom = "1rem";
  actions.style.display = "flex";
  actions.style.flexDirection = "column";
  actions.style.gap = "0.5rem";
  actions.style.pointerEvents = "auto";

  const meeting = document.createElement("div");
  meeting.style.position = "absolute";
  meeting.style.left = "50%";
  meeting.style.top = "50%";
  meeting.style.transform = "translate(-50%, -50%)";
  meeting.style.minWidth = "18rem";
  meeting.style.maxWidth = "min(90vw, 24rem)";
  meeting.style.padding = "1rem";
  meeting.style.borderRadius = "1rem";
  meeting.style.background = "rgba(12, 18, 28, 0.95)";
  meeting.style.color = "#f4f8ff";
  meeting.style.display = "none";
  meeting.style.pointerEvents = "auto";

  // Keep gameplay buttons mounted so pointer interactions survive render updates.
  const reportButton = createHudButton("Report");
  const killButton = createHudButton("Kill");
  const lightsButton = createHudButton("Lights");
  const grayButton = createHudButton("Gray");
  const puzzleButton = createHudButton("Puzzle");

  actions.append(
    reportButton.button,
    killButton.button,
    lightsButton.button,
    grayButton.button,
    puzzleButton.button,
  );

  root.append(status, actions, meeting);
  document.body.appendChild(root);
  return { root, status, actions, meeting, reportButton, killButton, lightsButton, grayButton, puzzleButton };
}

function updateHud(
  hud: HudState,
  session: SessionState,
  localPlayerId: string | null,
  network: NetworkClient,
) {
  const snapshot = session.latestSnapshot;
  const localPlayer = snapshot?.players.find((player) => player.id === localPlayerId) ?? null;
  // Use the server snapshot for interaction checks so prediction/interpolation never skews range.
  const localX = localPlayer?.x;
  const localZ = localPlayer?.z;
  const nearbyBody = snapshot && localPlayer && localX !== undefined && localZ !== undefined
    ? findNearbyBody(localX, localZ, snapshot.deadBodies)
    : null;
  const nearbyTarget = snapshot && localPlayer && localX !== undefined && localZ !== undefined
    ? findNearbyAliveTarget(localX, localZ, localPlayer.id, snapshot.players)
    : null;
  const nearbyPuzzle = snapshot && localPlayer && localX !== undefined && localZ !== undefined
    ? findNearbyPuzzle(localX, localZ, localPlayer.id, snapshot.puzzleStations)
    : null;
  const activePuzzle = snapshot?.puzzleStations.find((station) => station.occupiedBy === localPlayerId) ?? null;
  const isAlive = session.phase === "playing" && localPlayer?.state === "alive";
  const canWorkPuzzle = localPlayer ? canPlayerWorkPuzzle(session.phase, localPlayer) : false;
  const killCooldownRemainingMs = Math.max(0, (localPlayer?.killCooldownEndsAt ?? 0) - (snapshot?.serverTime ?? 0));
  const killCooldownRemainingSeconds = Math.ceil(killCooldownRemainingMs / 1000);
  const canReport = isAlive && nearbyBody !== null;
  const canKill = isAlive
    && killCooldownRemainingMs <= 0
    && nearbyTarget !== null
    && (session.localRole === "imposter" || session.localRole === "sheriff");
  const canSabotage = isAlive && session.localRole === "imposter";

  hud.status.innerHTML = [
    `<strong>Phase:</strong> ${session.phase}`,
    `<strong>Role:</strong> ${session.localRole ?? "pending"}`,
    localPlayer ? `<strong>Tasks:</strong> ${localPlayer.completedPuzzleCount}/${localPlayer.totalPuzzleCount}` : "",
    session.notice,
  ].filter(Boolean).join("<br />");

  // Only mutate button state so active presses are not interrupted by DOM replacement.
  hud.reportButton.setEnabled(canReport);
  hud.reportButton.setAction(nearbyBody ? () => {
    network.sendMessage({ type: "report_body", bodyId: nearbyBody.id });
  } : null);

  hud.killButton.setLabel(killCooldownRemainingSeconds > 0 ? `Kill (${killCooldownRemainingSeconds}s)` : "Kill");
  hud.killButton.setEnabled(canKill);
  hud.killButton.setAction(canKill && nearbyTarget ? () => {
    network.sendMessage({ type: "kill", targetId: nearbyTarget.id });
  } : null);

  hud.lightsButton.setEnabled(canSabotage);
  hud.lightsButton.setAction(canSabotage ? () => {
    network.sendMessage({ type: "sabotage", kind: "lights_off" });
  } : null);

  hud.grayButton.setEnabled(canSabotage);
  hud.grayButton.setAction(canSabotage ? () => {
    network.sendMessage({ type: "sabotage", kind: "gray_players" });
  } : null);

  hud.puzzleButton.setLabel(activePuzzle ? "Puzzle Active" : nearbyPuzzle ? `Use ${nearbyPuzzle.kind}` : "Puzzle");
  hud.puzzleButton.setEnabled(canWorkPuzzle && nearbyPuzzle !== null && activePuzzle === null);
  hud.puzzleButton.setAction(canWorkPuzzle && nearbyPuzzle && activePuzzle === null ? () => {
    network.sendMessage({ type: "start_puzzle", stationId: nearbyPuzzle.id });
  } : null);

  if (snapshot?.phase === "meeting" && localPlayer?.state === "alive") {
    hud.meeting.style.display = "block";
    renderMeetingHud(hud.meeting, snapshot, localPlayerId, network);
  } else {
    hud.meeting.style.display = "none";
    hud.meeting.replaceChildren();
  }
}

function createHudButton(label: string): HudButtonState {
  const button = document.createElement("button");
  let action: (() => void) | null = null;

  button.textContent = label;
  button.style.padding = "0.8rem 1rem";
  button.style.border = "0";
  button.style.borderRadius = "999px";
  button.style.background = "#6a7280";
  button.style.color = "white";
  button.style.fontWeight = "700";
  button.style.cursor = "not-allowed";
  button.style.opacity = "0.45";
  button.disabled = true;
  button.style.touchAction = "manipulation";

  // Fire on pointer down so taps are not lost to click synthesis on mobile.
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (button.disabled || !action) return;
    action();
  });

  return {
    button,
    setEnabled(enabled: boolean) {
      button.style.background = enabled ? "#f35f7d" : "#6a7280";
      button.style.cursor = enabled ? "pointer" : "not-allowed";
      button.style.opacity = enabled ? "1" : "0.45";
      button.disabled = !enabled;
    },
    setLabel(label: string) {
      button.textContent = label;
    },
    setAction(nextAction: (() => void) | null) {
      action = nextAction;
    },
  };
}

function renderMeetingHud(
  root: HTMLDivElement,
  snapshot: WorldSnapshot,
  localPlayerId: string | null,
  network: NetworkClient,
) {
  root.replaceChildren();

  const title = document.createElement("div");
  title.innerHTML = `<strong>Meeting</strong><br />Votes: ${snapshot.meeting?.votesCast ?? 0}/${snapshot.meeting?.totalVoters ?? 0}`;
  title.style.marginBottom = "0.75rem";
  root.appendChild(title);

  for (const player of snapshot.players.filter((entry) => entry.state === "alive" && entry.id !== localPlayerId)) {
    root.appendChild(
      createMeetingButton(`Vote ${player.name}`, () => {
        network.sendMessage({ type: "vote", target: player.id });
      }),
    );
  }

  root.appendChild(
    createMeetingButton("Skip", () => {
      network.sendMessage({ type: "vote", target: "skip" });
    }),
  );
}

function createMeetingButton(label: string, onClick: () => void) {
  const state = createHudButton(label);
  state.setEnabled(true);
  state.setAction(onClick);
  return state.button;
}

function findNearbyBody(x: number, z: number, bodies: SnapshotDeadBody[]) {
  let best: SnapshotDeadBody | null = null;
  let bestDistSq = BODY_INTERACTION_RANGE_SQ;

  for (const body of bodies) {
    if (body.reported) continue;
    const distSq = distanceSq(x, z, body.x, body.z);
    if (distSq < bestDistSq) {
      best = body;
      bestDistSq = distSq;
    }
  }

  return best;
}

function findNearbyAliveTarget(x: number, z: number, playerId: string, players: SnapshotPlayer[]) {
  let best: SnapshotPlayer | null = null;
  let bestDistSq = KILL_INTERACTION_RANGE_SQ;

  for (const candidate of players) {
    if (candidate.id === playerId || candidate.state !== "alive") continue;
    const distSq = distanceSq(x, z, candidate.x, candidate.z);
    if (distSq < bestDistSq) {
      best = candidate;
      bestDistSq = distSq;
    }
  }

  return best;
}

function distanceSq(ax: number, az: number, bx: number, bz: number) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function setupPlayerController() {
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
