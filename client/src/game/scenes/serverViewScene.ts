import {
  Engine,
  Mesh,
  Scene,
  StandardMaterial,
  WebGPUEngine,
} from "@babylonjs/core";
import { AdvancedDynamicTexture, Control, Image, Rectangle, StackPanel, TextBlock } from "@babylonjs/gui";
import QRCode from "qrcode";
import { NetworkClient } from "../../networking/client";
import { Logger, LOG_SCOPES } from "../../logger";
import type { PuzzleProjectionState, ServerMessage, SnapshotDeadBody, SnapshotPlayer, WorldSnapshot } from "../../networking/message";
import { drawTimerPuzzleScene } from "../puzzles/timerPuzzleScene";
import { drawWiresPuzzleScene } from "../puzzles/wiresPuzzleScene";
import { createPlayerTag, type PlayerTagState } from "../playerTag";
import { createMeetingOverlay } from "../ui/meetingOverlay";
import {
  applyGrayPlayerTint,
  applyWorldTheme,
  createSharedWorldArena,
  createSharedWorldCamera,
  createWorldBodyMesh,
  createWorldLight,
  createWorldPuzzleStationMesh,
  createWorldPlayerMesh,
  DEFAULT_MAP_HALF_EXTENT,
  getServerViewOrthoHalfHeight,
  setMeshHeight,
  type WorldPuzzleStationMesh,
} from "../world";

type PlayerMeshState = {
  mesh: Mesh;
  material: StandardMaterial;
  tag: PlayerTagState;
};

type BodyMeshState = {
  mesh: Mesh;
  material: StandardMaterial;
};

type PuzzleStationMeshState = WorldPuzzleStationMesh;

type ServerViewState = {
  connected: boolean;
  status: string;
  snapshot: WorldSnapshot | null;
};

type HudState = {
  ui: AdvancedDynamicTexture;
  root: Rectangle;
  mode: TextBlock;
  status: TextBlock;
  subtitle: TextBlock;
  qrFrame: Rectangle;
  qrImage: Image;
  qrAdvert: TextBlock;
  rosterPanel: StackPanel;
  detailPanel: StackPanel;
};

type SceneMetadataState = {
  meetingOverlay?: ReturnType<typeof createMeetingOverlay>;
};

const SERVER_VIEW_AD_TEXT = "School of Engineering and Computer Sciense";
const SERVER_VIEW_JOIN_URL = `${window.location.origin.replace(/\/$/, "")}/`;
export function createServerViewScene(
  engine: Engine | WebGPUEngine,
  network: NetworkClient,
): Scene {
  // Build a read-only scene that shows the whole world for spectators.
  const scene = new Scene(engine);

  const cameraState = createSharedWorldCamera(scene, {
    name: "server-view-camera",
    halfHeight: getServerViewOrthoHalfHeight(DEFAULT_MAP_HALF_EXTENT),
  });
  const arena = createEnvironment(scene);
  applyWorldTheme(scene, arena, "lobby", []);

  const players = new Map<string, PlayerMeshState>();
  const bodies = new Map<string, BodyMeshState>();
  const puzzleStations = new Map<string, PuzzleStationMeshState>();
  const hud = createHud(scene);
  const meetingOverlay = createMeetingOverlay({
    localPlayerId: null,
    network: null,
    readOnly: true,
  });
  const metadata = ((scene.metadata as SceneMetadataState | null) ?? {});
  metadata.meetingOverlay = meetingOverlay;
  scene.metadata = metadata;
  const state: ServerViewState = {
    connected: false,
    status: "Connecting to server view...",
    snapshot: null,
  };

  const offMessage = network.onMessage((message) => {
    // Keep the projector synchronized with every server snapshot and status event.
    handleServerMessage(scene, cameraState, arena, players, bodies, puzzleStations, hud, state, message);
  });

  scene.onDisposeObservable.add(() => {
    // Tear down the spectator UI and any meshes created from snapshots.
    offMessage();
    hud.ui.dispose();
    meetingOverlay.dispose();

    for (const player of players.values()) {
      player.mesh.dispose();
      player.material.dispose();
    }

    for (const body of bodies.values()) {
      body.mesh.dispose();
      body.material.dispose();
    }

    for (const station of puzzleStations.values()) {
      station.mesh.dispose();
      station.material.dispose();
      station.projectionMaterial.dispose();
      station.projectionTexture.dispose();
    }

    players.clear();
    bodies.clear();
    puzzleStations.clear();
  });

  updateHud(hud, state);
  meetingOverlay.update({ snapshot: state.snapshot, notice: state.status });
  void updateQr(hud);

  return scene;
}

function createEnvironment(scene: Scene) {
  createWorldLight(scene);
  return createSharedWorldArena(scene, {
    prefix: "server-view",
    groundColor: "#4f7d5c",
    wallColor: "#ffd166",
    initialMapHalfExtent: DEFAULT_MAP_HALF_EXTENT,
  });
}

function createHud(scene: Scene): HudState {
  // Build a simple projector overlay with the match mode and joined roster.
  const ui = AdvancedDynamicTexture.CreateFullscreenUI("ServerViewUI", true, scene);

  const root = new Rectangle("server-view-hud");
  root.width = "340px";
  root.height = "100%";
  root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  root.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
  root.thickness = 0;
  root.background = "rgba(10, 15, 24, 0.78)";
  root.paddingLeft = "18px";
  root.paddingRight = "18px";
  root.paddingTop = "18px";
  root.paddingBottom = "18px";
  ui.addControl(root);

  const panel = new StackPanel("server-view-panel");
  panel.width = "100%";
  panel.isVertical = true;
  panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  root.addControl(panel);

  const mode = new TextBlock("server-view-mode");
  mode.text = "SERVER VIEW";
  mode.color = "#8be9fd";
  mode.fontSize = 34;
  mode.height = "48px";
  mode.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  panel.addControl(mode);

  const status = new TextBlock("server-view-status");
  status.text = "Connecting...";
  status.color = "white";
  status.fontSize = 22;
  status.height = "40px";
  status.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  panel.addControl(status);

  const subtitle = new TextBlock("server-view-subtitle");
  subtitle.text = "Read-only feed for the projector";
  subtitle.color = "#cbd5e1";
  subtitle.fontSize = 18;
  subtitle.height = "34px";
  subtitle.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  panel.addControl(subtitle);

  const qrAdvert = new TextBlock("server-view-qr-advert");
  qrAdvert.text = SERVER_VIEW_AD_TEXT;
  qrAdvert.color = "#ffffff";
  qrAdvert.fontSize = 20;
  qrAdvert.height = "36px";
  qrAdvert.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  panel.addControl(qrAdvert);

  const rosterTitle = new TextBlock("server-view-roster-title");
  rosterTitle.text = "Joined players";
  rosterTitle.color = "white";
  rosterTitle.fontSize = 24;
  rosterTitle.height = "44px";
  rosterTitle.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  panel.addControl(rosterTitle);

  const rosterPanel = new StackPanel("server-view-roster");
  rosterPanel.width = "100%";
  rosterPanel.isVertical = true;
  rosterPanel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  panel.addControl(rosterPanel);

  const detailPanel = new StackPanel("server-view-detail");
  detailPanel.width = "100%";
  detailPanel.isVertical = true;
  detailPanel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  panel.addControl(detailPanel);

  const qrFrame = new Rectangle("server-view-qr-frame");
  qrFrame.width = "320px";
  qrFrame.height = "380px";
  qrFrame.thickness = 2;
  qrFrame.cornerRadius = 18;
  qrFrame.background = "rgba(10, 15, 24, 0.94)";
  qrFrame.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
  qrFrame.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  qrFrame.left = "-24px";
  qrFrame.top = "-24px";
  qrFrame.paddingTop = "16px";
  qrFrame.paddingBottom = "16px";
  qrFrame.paddingLeft = "16px";
  qrFrame.paddingRight = "16px";
  root.addControl(qrFrame);

  const qrImage = new Image("server-view-qr", "");
  qrImage.width = "100%";
  qrImage.height = "300px";
  qrImage.stretch = Image.STRETCH_UNIFORM;
  qrFrame.addControl(qrImage);

  return { ui, root, mode, status, subtitle, qrFrame, qrImage, qrAdvert, rosterPanel, detailPanel };
}

function handleServerMessage(
  scene: Scene,
  cameraState: ReturnType<typeof createSharedWorldCamera>,
  arena: ReturnType<typeof createEnvironment>,
  players: Map<string, PlayerMeshState>,
  bodies: Map<string, BodyMeshState>,
  puzzleStations: Map<string, PuzzleStationMeshState>,
  hud: HudState,
  state: ServerViewState,
  message: ServerMessage,
) {
  switch (message.type) {
    case "welcome":
      state.connected = true;
      state.status = message.observer ? "Connected as observer" : `Connected as ${message.name}`;
      updateHud(hud, state);
      updateMeetingOverlay(scene, state);
      break;

    case "game_started":
      state.status = `Round started: ${message.role}`;
      updateHud(hud, state);
      updateMeetingOverlay(scene, state);
      break;

    case "meeting_started":
      state.status = `Meeting called for ${message.reportedBodyId.slice(0, 6)}`;
      updateHud(hud, state);
      updateMeetingOverlay(scene, state);
      break;

    case "vote_update":
      state.status = `Votes ${message.votesCast}/${message.totalVoters}`;
      updateHud(hud, state);
      updateMeetingOverlay(scene, state);
      break;

    case "meeting_chat":
      state.status = `${message.name}: ${message.message}`;
      updateHud(hud, state);
      updateMeetingOverlay(scene, state);
      break;

    case "ejection_result":
      state.status = message.playerId
        ? `${message.playerId.slice(0, 6)} ejected${message.wasImposter ? " (imposter)" : ""}`
        : "No one was ejected";
      updateHud(hud, state);
      updateMeetingOverlay(scene, state);
      break;

    case "win":
      state.status = `${message.winner} win: ${message.reason}`;
      updateHud(hud, state);
      updateMeetingOverlay(scene, state);
      break;

    case "world_snapshot":
      {
        const prevPhase = state.snapshot?.phase;
        state.snapshot = message.snapshot;
        state.status = formatSnapshotStatus(message.snapshot);

        if (prevPhase !== message.snapshot.phase) {
          Logger.info(LOG_SCOPES.STATE, "SERVER VIEW: phase change", {
            from: prevPhase,
            to: message.snapshot.phase,
            playerCount: message.snapshot.players.length,
          });
        }

        arena.updateBounds(message.snapshot.mapHalfExtent, message.snapshot.phase);
        cameraState.setHalfHeight(getServerViewOrthoHalfHeight(message.snapshot.mapHalfExtent));
        applyWorldTheme(scene, arena, message.snapshot.phase, message.snapshot.activeSabotages);
        applySabotageVisuals(players, message.snapshot);
        syncWorld(scene, players, bodies, puzzleStations, message.snapshot);
        updateHud(hud, state);
        updateMeetingOverlay(scene, state);
      }
      break;
  }
}

function updateMeetingOverlay(scene: Scene, state: ServerViewState) {
  // Keep the server projector on the shared meeting overlay whenever a meeting is active.
  const metadata = scene.metadata as SceneMetadataState | null;
  metadata?.meetingOverlay?.update({ snapshot: state.snapshot, notice: state.status });
}

function formatSnapshotStatus(snapshot: WorldSnapshot) {
  // Keep the projector headline short and useful while the match changes state.
  if (snapshot.phase === "lobby") {
    if (snapshot.lobbyCountdownEndsAt !== null) {
      const secondsLeft = Math.max(0, Math.ceil((snapshot.lobbyCountdownEndsAt - snapshot.serverTime) / 1000));
      return `Lobby ${snapshot.joinedPlayers} / ${snapshot.expectedPlayers} • ${secondsLeft}s`;
    }

    return `Lobby ${snapshot.joinedPlayers} / ${snapshot.expectedPlayers}`;
  }

  if (snapshot.phase === "win") {
    return "Round complete";
  }

  return snapshot.phase === "meeting"
    ? "Meeting in progress"
    : snapshot.phase === "ejection"
      ? "Resolving vote"
      : "Live match";
}

function syncWorld(
  scene: Scene,
  players: Map<string, PlayerMeshState>,
  bodies: Map<string, BodyMeshState>,
  puzzleStations: Map<string, PuzzleStationMeshState>,
  snapshot: WorldSnapshot,
) {
  // Keep one mesh per player so the observer view always shows the full map.
  const livePlayerIds = new Set<string>();
  for (const player of snapshot.players) {
    livePlayerIds.add(player.id);
    const meshState = upsertPlayer(scene, players, player);
    meshState.mesh.position.x = player.x;
    meshState.mesh.position.z = player.z;
    setMeshHeight(meshState.mesh, player.state);
  }

  cleanupPlayers(players, livePlayerIds);

  const liveBodyIds = new Set<string>();
  for (const body of snapshot.deadBodies) {
    liveBodyIds.add(body.id);
    const meshState = upsertBody(scene, bodies, body);
    meshState.mesh.position.x = body.x;
    meshState.mesh.position.z = body.z;
    meshState.mesh.isVisible = !body.reported;
  }

  cleanupBodies(bodies, liveBodyIds);
  syncPuzzleStations(scene, puzzleStations, snapshot);
}

function applySabotageVisuals(players: Map<string, PlayerMeshState>, snapshot: WorldSnapshot) {
  applyGrayPlayerTint(players, snapshot.players, snapshot.activeSabotages);
}

function upsertPlayer(scene: Scene, players: Map<string, PlayerMeshState>, player: SnapshotPlayer) {
  let state = players.get(player.id);
  if (state) return state;

  // Render each player as a color-coded marker that reads clearly from far away.
  const { mesh, material } = createWorldPlayerMesh(scene, `server-view-player-${player.id}`, player.color);

  const tag = createPlayerTag(scene, player.id, player.name);
  tag.mesh.parent = mesh;

  state = { mesh, material, tag };
  players.set(player.id, state);
  return state;
}

function upsertBody(scene: Scene, bodies: Map<string, BodyMeshState>, body: SnapshotDeadBody) {
  let state = bodies.get(body.id);
  if (state) return state;

  // Draw reported bodies as small red markers so the audience can track meetings.
  const { mesh, material } = createWorldBodyMesh(scene, `server-view-body-${body.id}`);

  state = { mesh, material };
  bodies.set(body.id, state);
  return state;
}

function cleanupPlayers(players: Map<string, PlayerMeshState>, liveIds: Set<string>) {
  // Remove player markers that disappeared from the latest authoritative snapshot.
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

function cleanupBodies(bodies: Map<string, BodyMeshState>, liveIds: Set<string>) {
  // Remove body markers once the server no longer reports them.
  for (const [id, state] of bodies) {
    if (liveIds.has(id)) continue;
    state.mesh.dispose();
    state.material.dispose();
    bodies.delete(id);
  }
}

function syncPuzzleStations(
  scene: Scene,
  puzzleStations: Map<string, PuzzleStationMeshState>,
  snapshot: WorldSnapshot,
) {
  // Keep lobby snapshots free of task pedestals so the projector only shows them once the round is live.
  if (snapshot.subState !== "in_game") {
    for (const [id, state] of puzzleStations) {
      state.mesh.dispose();
      state.material.dispose();
      state.projectionMaterial.dispose();
      state.projectionTexture.dispose();
      puzzleStations.delete(id);
    }

    return;
  }

  // Mirror the same station/projection state to the read-only server projector.
  const liveIds = new Set<string>();
  const requiredCompletions = snapshot.players.filter(isTaskPlayer).length;
  for (const station of snapshot.puzzleStations) {
    liveIds.add(station.id);
    const meshState = upsertPuzzleStation(scene, puzzleStations, station.id, station.kind);
    meshState.mesh.position.x = station.x;
    meshState.mesh.position.z = station.z;
    meshState.setStatus(requiredCompletions > 0 && station.completedBy.length >= requiredCompletions, station.occupiedBy !== null);
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

function upsertPuzzleStation(
  scene: Scene,
  puzzleStations: Map<string, PuzzleStationMeshState>,
  stationId: string,
  kind: WorldSnapshot["puzzleStations"][number]["kind"],
) {
  const existing = puzzleStations.get(stationId);
  if (existing) {
    return existing;
  }

  const meshState = createWorldPuzzleStationMesh(scene, `server-view-puzzle-${stationId}`, kind);
  puzzleStations.set(stationId, meshState);
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

function isTaskPlayer(player: WorldSnapshot["players"][number]) {
  return player.role === "crewmate" || player.role === "sheriff";
}

function updateHud(hud: HudState, state: ServerViewState) {
  // Keep the overlay focused on the state of the live server and lobby.
  hud.status.text = state.status;
  hud.subtitle.text = state.snapshot
    ? state.snapshot.phase === "lobby"
      ? "Lobby overview with all joined players"
      : state.snapshot.phase === "meeting"
        ? "Meeting overview with vote breakdown"
      : "Bird's-eye match feed"
    : state.connected
      ? "Waiting for the first server snapshot"
      : "Read-only feed for the projector";

  hud.mode.text = state.snapshot
    ? state.snapshot.phase === "lobby"
      ? "LOBBY"
      : state.snapshot.phase === "playing"
        ? "MATCH"
        : state.snapshot.phase === "meeting"
          ? "MEETING"
          : state.snapshot.phase === "ejection"
            ? "EJECTION"
            : "WIN"
    : "SERVER VIEW";

  hud.rosterPanel.clearControls();
  hud.detailPanel.clearControls();
  if (!state.snapshot) return;

  for (const player of state.snapshot.players) {
    // Show each player as a compact avatar chip for spectators.
    const row = new StackPanel();
    row.isVertical = false;
    row.height = "34px";
    row.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;

    const avatar = new Rectangle();
    avatar.width = "14px";
    avatar.height = "14px";
    avatar.cornerRadius = 7;
    avatar.thickness = 0;
    avatar.background = player.color;

    const label = new TextBlock();
    label.text = player.name;
    label.color = "white";
    label.fontSize = 18;
    label.height = "28px";
    label.width = "220px";
    label.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    label.paddingLeft = "10px";

    row.addControl(avatar);
    row.addControl(label);
    hud.rosterPanel.addControl(row);
  }

}

async function updateQr(hud: HudState) {
  // Render the join URL as a large QR so players can scan into the game quickly.
  const dataUrl = await QRCode.toDataURL(SERVER_VIEW_JOIN_URL, {
    width: 512,
    margin: 1,
    errorCorrectionLevel: "M",
    color: {
      dark: "#111827",
      light: "#ffffff",
    },
  });

  hud.qrImage.source = dataUrl;
  hud.qrAdvert.text = SERVER_VIEW_AD_TEXT;
}
