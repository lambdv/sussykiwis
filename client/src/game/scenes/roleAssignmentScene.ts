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
import { AdvancedDynamicTexture, Control, Rectangle, StackPanel, TextBlock } from "@babylonjs/gui";
import { NetworkClient } from "../../networking/client";
import type { PlayerRole, ServerMessage, WorldSnapshot } from "../../networking/message";
import type { WinSceneData } from "./gameScene";

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

type RevealHud = {
  ui: AdvancedDynamicTexture;
  title: TextBlock;
  objective: TextBlock;
  details: TextBlock;
  roster: TextBlock;
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
  // Build a dedicated Babylon scene so the role reveal is separate from gameplay rendering.
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.05, 0.1, 1);

  const state: RevealState = {
    localRole: initialRole,
    latestSnapshot: null,
    revealEndsAt: null,
    revealTimer: null,
  };

  // Keep the reveal camera fixed so the transition feels intentional rather than interactive.
  const camera = new ArcRotateCamera("role-assignment-camera", -Math.PI / 4, 1.02, 26, new Vector3(0, 1.5, 0), scene);
  camera.mode = Camera.PERSPECTIVE_CAMERA;
  camera.lowerAlphaLimit = camera.upperAlphaLimit = camera.alpha;
  camera.lowerBetaLimit = camera.upperBetaLimit = camera.beta;
  camera.attachControl(canvas, true);
  camera.inputs.clear();

  // Light a simple stage so the reveal reads clearly on small screens.
  const light = new HemisphericLight("role-assignment-light", new Vector3(0, 1, 0.3), scene);
  light.intensity = 1.15;

  const ground = MeshBuilder.CreateGround("role-assignment-ground", { width: 42, height: 42 }, scene);
  const groundMaterial = new StandardMaterial("role-assignment-ground-material", scene);
  groundMaterial.diffuseColor = Color3.FromHexString("#111827");
  ground.material = groundMaterial;

  // Show the local player prominently and reveal imposter teammates beside them when relevant.
  const localFigure = createFigure(scene, "role-assignment-local", 0, 1.6, 0, "#94a3b8");
  const teammateFigures = [
    createFigure(scene, "role-assignment-teammate-a", -4.5, 1.1, 3.5, "#475569"),
    createFigure(scene, "role-assignment-teammate-b", 4.5, 1.1, 3.5, "#475569"),
  ];

  const hud = createHud(scene);

  const offMessage = network.onMessage((message) => {
    handleServerMessage(message, state, localPlayerId, callbacks);
    updateScene(localFigure, teammateFigures, hud, state, localPlayerId);
  });

  const renderLoop = scene.onBeforeRenderObservable.add(() => {
    updateRevealTimer(state, callbacks);
    updateScene(localFigure, teammateFigures, hud, state, localPlayerId);
  });

  updateScene(localFigure, teammateFigures, hud, state, localPlayerId);

  scene.onDisposeObservable.add(() => {
    // Tear down all scene-owned resources once gameplay takes over.
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
      // Cache the role immediately in case snapshots arrive a tick later.
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
  // Start the reveal as soon as the local client knows both the role and active round state.
  if (state.revealEndsAt === null && state.latestSnapshot?.subState === "in_game" && state.localRole) {
    startRevealTimer(state, callbacks);
  }
}

function startRevealTimer(state: RevealState, callbacks: RoleAssignmentSceneCallbacks) {
  // Hold the reveal long enough to read before loading the interactive world scene.
  if (state.revealEndsAt !== null) return;

  const durationMs = 4500;
  state.revealEndsAt = Date.now() + durationMs;
  state.revealTimer = window.setTimeout(() => {
    state.revealTimer = null;
    state.revealEndsAt = null;
    callbacks.onDone();
  }, durationMs);
}

function updateScene(
  localFigure: Mesh,
  teammateFigures: Mesh[],
  hud: RevealHud,
  state: RevealState,
  localPlayerId: string | null,
) {
  // Keep the dedicated reveal scene synced with the latest authoritative roster.
  const snapshot = state.latestSnapshot;
  const role = state.localRole;

  if (!snapshot || snapshot.subState !== "in_game" || !role) {
    hud.title.text = "Preparing role reveal";
    hud.objective.text = "Waiting for the round to become active.";
    hud.details.text = "";
    hud.roster.text = "";
    hud.hint.text = "Syncing with server";
    setFigureColor(localFigure, "#94a3b8");
    teammateFigures.forEach((figure) => {
      figure.isVisible = false;
      setFigureColor(figure, "#475569");
    });
    return;
  }

  const localPlayer = snapshot.players.find((player) => player.id === localPlayerId) ?? null;
  const imposters = snapshot.players.filter((player) => player.role === "imposter");
  const imposterTeammates = localPlayer?.role === "imposter"
    ? imposters.filter((player) => player.id !== localPlayer.id)
    : [];
  const allOtherPlayers = snapshot.players.filter((player) => player.id !== localPlayerId);
  const secondsLeft = state.revealEndsAt === null ? 5 : Math.max(0, Math.ceil((state.revealEndsAt - Date.now()) / 1000));

  hud.title.text = formatRoleName(role);
  hud.objective.text = role === "imposter"
    ? "Eliminate the crew and avoid being voted out."
    : role === "sheriff"
      ? "Protect the crew and use your one-shot kill carefully."
      : "Finish your tasks and identify the imposters.";
  hud.details.text = role === "imposter"
    ? `Your team: ${formatPlayerList(imposterTeammates.map((player) => player.name)) || "No teammate"}`
    : `There ${imposters.length === 1 ? "is" : "are"} ${imposters.length} imposter${imposters.length === 1 ? "" : "s"} among us.`;
  hud.roster.text = role === "imposter"
    ? `Imposter teammate${imposterTeammates.length === 1 ? "" : "s"}: ${formatPlayerList(imposterTeammates.map((player) => player.name)) || "None"}`
    : `Players: ${formatPlayerList(allOtherPlayers.map((player) => player.name)) || "None"}`;
  hud.hint.text = `Gameplay starts in ${secondsLeft}`;

  setFigureColor(localFigure, localPlayer?.color ?? roleColor(role));
  teammateFigures.forEach((figure, index) => {
    const teammate = imposterTeammates[index];
    figure.isVisible = !!teammate;
    if (teammate) {
      setFigureColor(figure, teammate.color);
    }
  });
}

function createHud(scene: Scene): RevealHud {
  // Render the reveal copy inside Babylon GUI so this transition stays scene-owned.
  const ui = AdvancedDynamicTexture.CreateFullscreenUI("RoleAssignmentUI", true, scene);
  const root = new Rectangle("role-assignment-root");
  root.width = "100%";
  root.height = "100%";
  root.thickness = 0;
  root.background = "rgba(2,6,23,0.2)";
  ui.addControl(root);

  const panel = new StackPanel();
  panel.width = "min(92vw, 620px)";
  panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
  panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
  panel.paddingBottom = "36px";
  root.addControl(panel);

  const title = new TextBlock();
  title.color = "white";
  title.fontSize = 52;
  title.height = "72px";
  panel.addControl(title);

  const objective = new TextBlock();
  objective.color = "#e2e8f0";
  objective.fontSize = 22;
  objective.height = "64px";
  objective.textWrapping = true;
  panel.addControl(objective);

  const details = new TextBlock();
  details.color = "#f8fafc";
  details.fontSize = 20;
  details.height = "42px";
  details.textWrapping = true;
  panel.addControl(details);

  const roster = new TextBlock();
  roster.color = "#cbd5e1";
  roster.fontSize = 18;
  roster.height = "72px";
  roster.textWrapping = true;
  panel.addControl(roster);

  const hint = new TextBlock();
  hint.color = "#93c5fd";
  hint.fontSize = 18;
  hint.height = "34px";
  panel.addControl(hint);

  return { ui, title, objective, details, roster, hint };
}

function createFigure(scene: Scene, name: string, x: number, y: number, z: number, color: string) {
  // Use simple capsules so the reveal scene loads as quickly as the old overlay.
  const figure = MeshBuilder.CreateCapsule(name, { height: 3.2, radius: 1 }, scene);
  figure.position.set(x, y, z);
  const material = new StandardMaterial(`${name}-material`, scene);
  material.diffuseColor = Color3.FromHexString(color);
  figure.material = material;
  return figure;
}

function setFigureColor(mesh: Mesh, color: string) {
  // Recolor the reveal figures in place whenever roster data changes.
  const material = mesh.material;
  if (material instanceof StandardMaterial) {
    material.diffuseColor = Color3.FromHexString(color);
  }
}

function findLocalRole(snapshot: WorldSnapshot, localPlayerId: string | null) {
  // Derive the local role from the authoritative snapshot if the start packet was missed.
  return snapshot.players.find((player) => player.id === localPlayerId)?.role ?? null;
}

function roleColor(role: PlayerRole) {
  // Match the fallback figure accent to the assigned role.
  return role === "imposter" ? "#ef4444" : role === "sheriff" ? "#f59e0b" : "#38bdf8";
}

function formatRoleName(role: PlayerRole) {
  // Convert internal ids into the player-facing role title.
  return role === "imposter" ? "Imposter" : role === "sheriff" ? "Sheriff" : "Crewmate";
}

function formatPlayerList(names: string[]) {
  // Keep roster text compact in the reveal layout.
  return names.join(", ");
}
