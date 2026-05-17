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
  TransformNode,
  WebGPUEngine,
} from "@babylonjs/core";
import {
  AdvancedDynamicTexture,
  Control,
  StackPanel,
  TextBlock,
} from "@babylonjs/gui";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { NetworkClient } from "../../networking/client";
import type { PlayerRole, ServerMessage, WorldSnapshot } from "../../networking/message";
import type { WinSceneData } from "./gameScene";
import { createWorldPlayerMesh } from "../world";

type RoleAssignmentSceneCallbacks = {
  onDone: () => void;
  onPhase: (phase: "meeting" | "ejected" | "noEjection") => void;
  onWin: (data: WinSceneData) => void;
};

type RevealState = {
  localRole: PlayerRole | null;
  latestSnapshot: WorldSnapshot | null;
  revealEndsAt: number | null;
  revealTimer: number | null;
};

type PlayerFigure = {
  mesh: TransformNode;
  nameMesh: Mesh;
  nameTexture: DynamicTexture;
  color: string;
  drawName: (name: string, color: string) => void;
};

type RevealHud = {
  ui: AdvancedDynamicTexture;
  title: TextBlock;
  objective: TextBlock;
  details: TextBlock;
  hint: TextBlock;
};

export function createRoleAssignmentScene(
  engine: Engine | WebGPUEngine,
  canvas: HTMLCanvasElement,
  network: NetworkClient,
  localPlayerId: string | null,
  initialRole: PlayerRole | null,
  callbacks: RoleAssignmentSceneCallbacks,
): Scene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.05, 0.1, 1);

  const state: RevealState = {
    localRole: initialRole,
    latestSnapshot: null,
    revealEndsAt: null,
    revealTimer: null,
  };

  const camera = new ArcRotateCamera("role-assignment-camera", -Math.PI / 4, 1.02, 26, new Vector3(0, 1.5, 0), scene);
  camera.mode = Camera.PERSPECTIVE_CAMERA;
  camera.lowerAlphaLimit = camera.upperAlphaLimit = camera.alpha;
  camera.lowerBetaLimit = camera.upperBetaLimit = camera.beta;
  camera.attachControl(canvas, true);
  camera.inputs.clear();

  const light = new HemisphericLight("role-assignment-light", new Vector3(0, 1, 0.3), scene);
  light.intensity = 1.15;

  const ground = MeshBuilder.CreateGround("role-assignment-ground", { width: 42, height: 42 }, scene);
  const groundMaterial = new StandardMaterial("role-assignment-ground-material", scene);
  groundMaterial.diffuseColor = Color3.FromHexString("#111827");
  ground.material = groundMaterial;

  const figures: PlayerFigure[] = [];
  const hud = createHud(scene);

  const offMessage = network.onMessage((message) => {
    handleServerMessage(message, state, localPlayerId, callbacks);
    updateScene(scene, figures, hud, state, localPlayerId);
  });

  const renderLoop = scene.onBeforeRenderObservable.add(() => {
    updateRevealTimer(state, callbacks);
    updateScene(scene, figures, hud, state, localPlayerId);
  });

  updateScene(scene, figures, hud, state, localPlayerId);

  scene.onDisposeObservable.add(() => {
    offMessage();
    scene.onBeforeRenderObservable.remove(renderLoop);
    if (state.revealTimer !== null) {
      window.clearTimeout(state.revealTimer);
    }
    hud.ui.dispose();
  });

  return scene;
}

function handleServerMessage(
  message: ServerMessage,
  state: RevealState,
  localPlayerId: string | null,
  callbacks: RoleAssignmentSceneCallbacks,
) {
  switch (message.type) {
    case "game_started":
      state.localRole = message.role;
      break;
    case "meeting_started":
      callbacks.onPhase("meeting");
      break;
    case "ejection_result":
      callbacks.onPhase(message.playerId ? "ejected" : "noEjection");
      break;
    case "win":
      if (state.latestSnapshot) {
        callbacks.onWin({
          snapshot: state.latestSnapshot,
          winner: message.winner,
          reason: message.reason,
        });
      }
      break;
    case "world_snapshot":
      state.latestSnapshot = message.snapshot;
      if (!state.localRole) {
        state.localRole = findLocalRole(message.snapshot, localPlayerId);
      }
      if (message.snapshot.phase === "win" && message.snapshot.win) {
        callbacks.onWin({
          snapshot: message.snapshot,
          winner: message.snapshot.win.winner,
          reason: message.snapshot.win.reason,
        });
        return;
      }
      if (message.snapshot.subState === "in_game" && state.localRole && state.revealEndsAt === null) {
        startRevealTimer(state, callbacks);
      }
      break;
    default:
      break;
  }
}

function updateRevealTimer(state: RevealState, callbacks: RoleAssignmentSceneCallbacks) {
  if (state.revealEndsAt === null && state.latestSnapshot?.subState === "in_game" && state.localRole) {
    startRevealTimer(state, callbacks);
  }
}

function startRevealTimer(state: RevealState, callbacks: RoleAssignmentSceneCallbacks) {
  if (state.revealEndsAt !== null) return;

  const durationMs = 6000;
  state.revealEndsAt = Date.now() + durationMs;
  state.revealTimer = window.setTimeout(() => {
    state.revealTimer = null;
    state.revealEndsAt = null;
    callbacks.onDone();
  }, durationMs);
}

function createFigure(scene: Scene, idx: number, color: string): PlayerFigure {
  const mesh = createWorldPlayerMesh(scene, `figure-${idx}`, color).mesh;

  const nameMesh = MeshBuilder.CreatePlane(`name-plane-${idx}`, { width: 3.2, height: 0.85 }, scene);
  nameMesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  nameMesh.isPickable = false;

  const nameTexture = new DynamicTexture(`name-tex-${idx}`, { width: 512, height: 128 }, scene, false);
  nameTexture.hasAlpha = true;

  const nameMaterial = new StandardMaterial(`name-mat-${idx}`, scene);
  nameMaterial.diffuseTexture = nameTexture;
  nameMaterial.emissiveColor = Color3.White();
  nameMaterial.specularColor = Color3.Black();
  nameMaterial.backFaceCulling = false;
  nameMaterial.useAlphaFromDiffuseTexture = true;
  nameMesh.material = nameMaterial;

  const drawName = (name: string, color: string) => {
    nameTexture.drawText(name, 256, 86, "bold 64px Arial", color, "transparent", true);
  };

  return { mesh, nameMesh, nameTexture, color, drawName };
}

function updateScene(
  scene: Scene,
  figures: PlayerFigure[],
  hud: RevealHud,
  state: RevealState,
  localPlayerId: string | null,
) {
  const snapshot = state.latestSnapshot;
  const role = state.localRole;

  if (!snapshot || snapshot.subState !== "in_game" || !role) {
    hud.title.text = "Preparing role reveal";
    hud.objective.text = "Waiting for the round to become active.";
    hud.details.text = "";
    hud.hint.text = "Syncing with server";
    figures.forEach((f) => {
      f.mesh.isVisible = false;
      f.nameMesh.isVisible = false;
    });
    return;
  }

  const secondsLeft = state.revealEndsAt === null ? 6 : Math.max(0, Math.ceil((state.revealEndsAt - Date.now()) / 1000));

  hud.title.text = formatRoleName(role);
  hud.objective.text = formatObjective(role);
  hud.hint.text = `Gameplay starts in ${secondsLeft}s`;

  const playersToShow: { id: string; name: string; color: string }[] =
    role === "imposter"
      ? snapshot.players.filter((p) => p.role === "imposter")
      : snapshot.players;

  const totalPlayers = playersToShow.length;
  const localIndex = playersToShow.findIndex((p) => p.id === localPlayerId);
  const centerOffset = localIndex >= 0 ? localIndex - Math.floor(totalPlayers / 2) : 0;

  const spacing = 5.5;
  const startX = -centerOffset * spacing;

  while (figures.length < totalPlayers) {
    const idx = figures.length;
    figures.push(createFigure(scene, idx, playersToShow[idx].color));
  }

  while (figures.length > totalPlayers) {
    const f = figures.pop()!;
    f.mesh.dispose();
    f.nameMesh.dispose();
  }

  if (role === "imposter") {
    const imposterCount = snapshot.players.filter((p) => p.role === "imposter").length;
    const crewCount = snapshot.players.filter((p) => p.role !== "imposter").length;
    hud.details.text = `${imposterCount} Imposter${imposterCount === 1 ? "" : "s"} | ${crewCount} Crewmate${crewCount === 1 ? "" : "s"}`;
  } else {
    const imposterCount = snapshot.players.filter((p) => p.role === "imposter").length;
    hud.details.text = `There ${imposterCount === 1 ? "is" : "are"} ${imposterCount} Imposter among us`;
  }

  figures.forEach((f, idx) => {
    const player = playersToShow[idx];
    const x = startX + idx * spacing;
    const isLocal = player.id === localPlayerId;

    f.mesh.position.set(x, 1.6, 0);
    f.mesh.setEnabled(true);

    f.nameMesh.position.set(x, 4.5, 0);
    f.nameMesh.isVisible = true;

    if (f.color !== player.color) {
      f.mesh.dispose();
      f.mesh = createWorldPlayerMesh(scene, `figure-${idx}`, player.color).mesh;
      f.color = player.color;
      f.mesh.position.set(x, 1.6, 0);
    }

    f.drawName(player.name, isLocal ? "#fbbf24" : "#f1f5f9");
  });
}

function createHud(scene: Scene): RevealHud {
  const ui = AdvancedDynamicTexture.CreateFullscreenUI("RoleAssignmentUI", true, scene);

  const panel = new StackPanel();
  panel.width = "min(92vw, 620px)";
  panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
  panel.paddingTop = "48px";
  ui.addControl(panel);

  const title = new TextBlock();
  title.color = "white";
  title.fontSize = 64;
  title.height = "80px";
  title.fontFamily = "Arial";
  title.fontWeight = "bold";
  panel.addControl(title);

  const objective = new TextBlock();
  objective.color = "#e2e8f0";
  objective.fontSize = 26;
  objective.height = "72px";
  objective.textWrapping = true;
  objective.fontFamily = "Arial";
  objective.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  panel.addControl(objective);

  const details = new TextBlock();
  details.color = "#f8fafc";
  details.fontSize = 22;
  details.height = "48px";
  details.textWrapping = true;
  details.fontFamily = "Arial";
  details.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  panel.addControl(details);

  const hint = new TextBlock();
  hint.color = "#93c5fd";
  hint.fontSize = 20;
  hint.height = "40px";
  hint.fontFamily = "Arial";
  hint.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  panel.addControl(hint);

  return { ui, title, objective, details, hint };
}

function formatRoleName(role: PlayerRole): string {
  return role === "imposter" ? "IMPOSTER" : role === "sheriff" ? "SHERIFF" : "CREWMATE";
}

function formatObjective(role: PlayerRole): string {
  return role === "imposter"
    ? "You are the Imposter. Kill all crewmates."
    : role === "sheriff"
      ? "You are the Sheriff. Protect the crew and shoot the imposters."
      : "You are the Crewmate. Complete all tasks and vote out the imposters.";
}

function findLocalRole(snapshot: WorldSnapshot, localPlayerId: string | null) {
  return snapshot.players.find((p) => p.id === localPlayerId)?.role ?? null;
}
