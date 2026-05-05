import nipplejs from "nipplejs";
import {
  ArcRotateCamera,
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
import type {
  GamePhase,
  PlayerRole,
  PlayerState,
  ServerMessage,
  SnapshotDeadBody,
  SnapshotPlayer,
  WorldSnapshot,
} from "../../networking/message";

const MOVE_SPEED = 6.0;

type RemoteSnapshot = { time: number; x: number; z: number };

type PlayerMeshState = {
  mesh: Mesh;
  material: StandardMaterial;
  snapshots: RemoteSnapshot[];
};

type BodyMeshState = {
  mesh: Mesh;
};

type PendingInput = { seq: number; moveX: number; moveZ: number; dt: number };

type SessionState = {
  latestServerTime: number;
  clientRenderTime: number;
  pendingInputs: PendingInput[];
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
};

export async function createGameScene(
  engine: Engine | WebGPUEngine,
  canvas: HTMLCanvasElement,
  network: NetworkClient,
  localPlayerId: string | null,
  initialRole: PlayerRole | null,
): Promise<Scene> {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.81, 0.89, 0.99, 1);

  const camera = createCamera(scene, canvas);
  createEnvironment(scene);

  const players = new Map<string, PlayerMeshState>();
  const bodies = new Map<string, BodyMeshState>();
  const controller = setupPlayerController();
  const hud = createHud();
  const session: SessionState = {
    latestServerTime: 0,
    clientRenderTime: 0,
    pendingInputs: [],
    localRole: initialRole,
    phase: "lobby",
    latestSnapshot: null,
    notice: initialRole ? `Role: ${initialRole}` : "Waiting for match start...",
  };

  const offMessage = network.onMessage((message) => {
    handleServerMessage(scene, players, bodies, message, localPlayerId, session);
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
    applySabotageVisuals(scene, players, session.latestSnapshot);
    updateHud(hud, session, localPlayerId, network);
  });

  scene.onDisposeObservable.add(() => {
    controller.dispose();
    offMessage();
    scene.onBeforeRenderObservable.remove(renderLoop);
    hud.root.remove();
    for (const player of players.values()) {
      player.mesh.dispose();
      player.material.dispose();
    }
    for (const body of bodies.values()) {
      body.mesh.dispose();
    }
    players.clear();
    bodies.clear();
  });

  return scene;
}

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

function createEnvironment(scene: Scene) {
  const light = new HemisphericLight("light", new Vector3(0, 1, 0.3), scene);
  light.intensity = 1;

  const ground = MeshBuilder.CreateGround("ground", { width: 140, height: 140 }, scene);
  const material = new StandardMaterial("ground-material", scene);
  material.diffuseColor = Color3.FromHexString("#243b55");
  ground.material = material;
}

function handleServerMessage(
  scene: Scene,
  players: Map<string, PlayerMeshState>,
  bodies: Map<string, BodyMeshState>,
  message: ServerMessage,
  localPlayerId: string | null,
  session: SessionState,
) {
  switch (message.type) {
    case "welcome":
      session.notice = `Connected as ${message.name}`;
      break;
    case "game_started":
      session.localRole = message.role;
      session.notice = `Role: ${message.role}`;
      break;
    case "meeting_started":
      session.notice = `Meeting started for body ${message.reportedBodyId.slice(0, 6)}`;
      break;
    case "vote_update":
      session.notice = `Votes: ${message.votesCast}/${message.totalVoters}`;
      break;
    case "ejection_result":
      session.notice = message.playerId
        ? `${message.playerId.slice(0, 6)} ejected${message.wasImposter ? " (imposter)" : ""}`
        : "No one was ejected";
      break;
    case "win":
      session.notice = `${message.winner} win: ${message.reason}`;
      break;
    case "world_snapshot":
      handleSnapshot(scene, players, bodies, message.snapshot, localPlayerId, session);
      break;
  }
}

function handleSnapshot(
  scene: Scene,
  players: Map<string, PlayerMeshState>,
  bodies: Map<string, BodyMeshState>,
  snapshot: WorldSnapshot,
  localPlayerId: string | null,
  session: SessionState,
) {
  session.latestSnapshot = snapshot;
  session.phase = snapshot.phase;
  session.latestServerTime = Math.max(session.latestServerTime, snapshot.serverTime);

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

  const liveBodyIds = new Set<string>();
  for (const body of snapshot.deadBodies) {
    liveBodyIds.add(body.id);
    const bodyState = upsertBodyMesh(scene, bodies, body);
    bodyState.mesh.position.x = body.x;
    bodyState.mesh.position.z = body.z;
    bodyState.mesh.isVisible = !body.reported;
  }

  cleanupDisconnectedBodies(bodies, liveBodyIds);
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
  const ix = input.x;
  const iz = input.z;

  const localState = localPlayerId ? players.get(localPlayerId) : undefined;
  const localPlayer = localPlayerId ? session.latestSnapshot?.players.find((player) => player.id === localPlayerId) : undefined;

  if (localPlayerId && localState && localPlayer && canLocallyMove(session.phase, localPlayer.state)) {
    localState.mesh.position.x += ix * MOVE_SPEED * dt;
    localState.mesh.position.z += iz * MOVE_SPEED * dt;
    session.pendingInputs.push({ seq: input.seq, moveX: ix, moveZ: iz, dt });
  }

  if (localState) {
    camera.position.set(localState.mesh.position.x, 18, localState.mesh.position.z - 18);
    camera.setTarget(localState.mesh.position);
  }

  network.sendMessage({
    type: "input",
    seq: input.seq,
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
) {
  let targetX = snapshotPlayer.x;
  let targetZ = snapshotPlayer.z;

  while (pendingInputs.length > 0 && pendingInputs[0].seq <= snapshotPlayer.lastProcessedSeq) {
    pendingInputs.shift();
  }

  for (const input of pendingInputs) {
    targetX += input.moveX * MOVE_SPEED * input.dt;
    targetZ += input.moveZ * MOVE_SPEED * input.dt;
  }

  const diffX = targetX - state.mesh.position.x;
  const diffZ = targetZ - state.mesh.position.z;
  const distSq = diffX * diffX + diffZ * diffZ;

  if (distSq > 0.1) {
    state.mesh.position.x = targetX;
    state.mesh.position.z = targetZ;
  }
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

  const mesh = MeshBuilder.CreateSphere(`player-${snapshotPlayer.id}`, { diameter: 2.6 }, scene);
  const material = new StandardMaterial(`player-material-${snapshotPlayer.id}`, scene);
  material.diffuseColor = Color3.FromHexString(snapshotPlayer.color);
  mesh.material = material;
  mesh.position.set(snapshotPlayer.x, 2, snapshotPlayer.z);

  const playerState = { mesh, material, snapshots: [] };
  players.set(snapshotPlayer.id, playerState);
  return playerState;
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
  const mesh = MeshBuilder.CreateCylinder(`body-${body.id}`, { height: 1.4, diameter: 1.2 }, scene);
  const material = new StandardMaterial(`body-material-${body.id}`, scene);
  material.diffuseColor = Color3.FromHexString("#ff5d73");
  mesh.material = material;
  mesh.rotation.z = Math.PI / 2;
  mesh.position.y = 0.7;

  const bodyState = { mesh };
  bodies.set(body.id, bodyState);
  return bodyState;
}

function cleanupDisconnectedPlayers(players: Map<string, PlayerMeshState>, liveIds: Set<string>) {
  for (const [id, state] of players) {
    if (liveIds.has(id)) continue;
    state.mesh.dispose();
    state.material.dispose();
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

function applySabotageVisuals(
  scene: Scene,
  players: Map<string, PlayerMeshState>,
  snapshot: WorldSnapshot | null,
) {
  const grayPlayers = snapshot?.activeSabotages.some((sabotage) => sabotage.kind === "gray_players") ?? false;
  const lightsOff = snapshot?.activeSabotages.some((sabotage) => sabotage.kind === "lights_off") ?? false;

  scene.clearColor = lightsOff ? new Color4(0.05, 0.07, 0.13, 1) : new Color4(0.81, 0.89, 0.99, 1);

  if (!snapshot) {
    return;
  }

  const snapshotPlayers = new Map(snapshot.players.map((player) => [player.id, player]));
  for (const [id, state] of players) {
    const snapshotPlayer = snapshotPlayers.get(id);
    if (!snapshotPlayer) continue;

    state.material.diffuseColor = grayPlayers
      ? Color3.FromHexString("#8e909a")
      : Color3.FromHexString(snapshotPlayer.color);
  }
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

  root.append(status, actions, meeting);
  document.body.appendChild(root);
  return { root, status, actions, meeting };
}

function updateHud(
  hud: HudState,
  session: SessionState,
  localPlayerId: string | null,
  network: NetworkClient,
) {
  const snapshot = session.latestSnapshot;
  const localPlayer = snapshot?.players.find((player) => player.id === localPlayerId) ?? null;
  const nearbyBody = snapshot && localPlayer ? findNearbyBody(localPlayer, snapshot.deadBodies) : null;
  const nearbyTarget = snapshot && localPlayer ? findNearbyAliveTarget(localPlayer, snapshot.players) : null;

  hud.status.innerHTML = [
    `<strong>Phase:</strong> ${session.phase}`,
    `<strong>Role:</strong> ${session.localRole ?? "pending"}`,
    session.notice,
  ].join("<br />");

  hud.actions.replaceChildren();
  if (snapshot && localPlayer) {
    if (session.phase === "playing" && localPlayer.state === "alive" && nearbyBody) {
      hud.actions.append(
        createHudButton("Report", () => {
          network.sendMessage({ type: "report_body", bodyId: nearbyBody.id });
        }),
      );
    }

    if (
      session.phase === "playing" &&
      localPlayer.state === "alive" &&
      nearbyTarget &&
      (session.localRole === "imposter" || session.localRole === "sheriff")
    ) {
      hud.actions.append(
        createHudButton("Kill", () => {
          network.sendMessage({ type: "kill", targetId: nearbyTarget.id });
        }),
      );
    }

    if (session.phase === "playing" && localPlayer.state === "alive" && session.localRole === "imposter") {
      hud.actions.append(
        createHudButton("Lights", () => {
          network.sendMessage({ type: "sabotage", kind: "lights_off" });
        }),
        createHudButton("Gray", () => {
          network.sendMessage({ type: "sabotage", kind: "gray_players" });
        }),
      );
    }
  }

  if (snapshot?.phase === "meeting" && localPlayer?.state === "alive") {
    hud.meeting.style.display = "block";
    renderMeetingHud(hud.meeting, snapshot, localPlayerId, network);
  } else {
    hud.meeting.style.display = "none";
    hud.meeting.replaceChildren();
  }
}

function createHudButton(label: string, onClick: () => void) {
  const button = document.createElement("button");
  button.textContent = label;
  button.style.padding = "0.8rem 1rem";
  button.style.border = "0";
  button.style.borderRadius = "999px";
  button.style.background = "#f35f7d";
  button.style.color = "white";
  button.style.fontWeight = "700";
  button.style.cursor = "pointer";
  button.onclick = onClick;
  return button;
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
      createHudButton(`Vote ${player.name}`, () => {
        network.sendMessage({ type: "vote", target: player.id });
      }),
    );
  }

  root.appendChild(
    createHudButton("Skip", () => {
      network.sendMessage({ type: "vote", target: "skip" });
    }),
  );
}

function findNearbyBody(player: SnapshotPlayer, bodies: SnapshotDeadBody[]) {
  let best: SnapshotDeadBody | null = null;
  let bestDistSq = 16;

  for (const body of bodies) {
    if (body.reported) continue;
    const distSq = distanceSq(player.x, player.z, body.x, body.z);
    if (distSq < bestDistSq) {
      best = body;
      bestDistSq = distSq;
    }
  }

  return best;
}

function findNearbyAliveTarget(player: SnapshotPlayer, players: SnapshotPlayer[]) {
  let best: SnapshotPlayer | null = null;
  let bestDistSq = 16;

  for (const candidate of players) {
    if (candidate.id === player.id || candidate.state !== "alive") continue;
    const distSq = distanceSq(player.x, player.z, candidate.x, candidate.z);
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
