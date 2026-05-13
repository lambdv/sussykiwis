import {
  ArcRotateCamera,
  Camera,
  Color3,
  Color4,
  DirectionalLight,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import type { GamePhase, PuzzleKind, SnapshotDeadBody, SnapshotPlayer, WorldSnapshot } from "../networking/message";

export const DEFAULT_MAP_HALF_EXTENT = 30;
export const PLAYER_MESH_Y = 2;
export const GHOST_MESH_Y = 3;
export const BODY_MESH_Y = 0.7;
export const PUZZLE_STATION_Y = 1.2;
export const PUZZLE_PROJECTION_Y = 5.4;

type WorldPalette = {
  clearColor: Color4;
  ground: string;
  wall: string;
};

type SharedCameraOptions = {
  name: string;
  canvas?: HTMLCanvasElement;
  distance?: number;
  halfHeight: number;
};

type SharedArenaOptions = {
  prefix: string;
  groundColor: string;
  wallColor: string;
  initialMapHalfExtent?: number;
};

export type SharedCameraState = {
  camera: ArcRotateCamera;
  setHalfHeight: (halfHeight: number) => void;
};

export type SharedArenaState = {
  groundMaterial: StandardMaterial;
  wallMaterial: StandardMaterial;
  updateBounds: (mapHalfExtent: number, phase: GamePhase) => void;
  updatePalette: (groundColor: string, wallColor: string) => void;
};

export type WorldPuzzleStationMesh = {
  mesh: Mesh;
  material: StandardMaterial;
  projectionMesh: Mesh;
  projectionMaterial: StandardMaterial;
  projectionTexture: DynamicTexture;
  setStatus: (completed: boolean, occupied: boolean) => void;
};

export function createSharedWorldCamera(scene: Scene, options: SharedCameraOptions): SharedCameraState {
  // Keep every world scene on the same orthographic isometric camera model.
  const camera = new ArcRotateCamera(
    options.name,
    -Math.PI / 4,
    0.95,
    options.distance ?? 52,
    Vector3.Zero(),
    scene,
  );
  let currentHalfHeight = options.halfHeight;

  camera.lowerAlphaLimit = camera.upperAlphaLimit = camera.alpha;
  camera.lowerBetaLimit = camera.upperBetaLimit = camera.beta;
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;

  scene.onBeforeRenderObservable.add(() => {
    // Keep world units stable across aspect ratios so server and player views frame identically.
    const engine = scene.getEngine();
    const width = Math.max(1, engine.getRenderWidth());
    const height = Math.max(1, engine.getRenderHeight());
    const aspect = width / height;
    const halfWidth = currentHalfHeight * aspect;
    camera.orthoLeft = -halfWidth;
    camera.orthoRight = halfWidth;
    camera.orthoBottom = -currentHalfHeight;
    camera.orthoTop = currentHalfHeight;
  });

  // Always mark the shared world camera active so scene transitions never render without one.
  scene.activeCamera = camera;

  if (options.canvas) {
    camera.attachControl(options.canvas, true);
    camera.inputs.clear();
  }

  return {
    camera,
    setHalfHeight(halfHeight: number) {
      currentHalfHeight = halfHeight;
    },
  };
}

export function createWorldLight(scene: Scene) {
  // Use one directional light model so all world scenes shade meshes the same way.
  const light = new DirectionalLight("world-light", new Vector3(-1, -2, -1), scene);
  light.intensity = 1.2;
  light.diffuse = Color3.White();
  light.specular = Color3.Black();
  return light;
}

export function createSharedWorldArena(scene: Scene, options: SharedArenaOptions): SharedArenaState {
  // Keep one resizable arena so snapshots can own the playable bounds.
  const ground = MeshBuilder.CreateGround(`${options.prefix}-ground`, { width: 1, height: 1 }, scene);
  const lobbyGround = MeshBuilder.CreateCylinder(
    `${options.prefix}-lobby-ground`,
    { height: 0.08, diameter: 1, tessellation: 48 },
    scene,
  );
  const groundMaterial = new StandardMaterial(`${options.prefix}-ground-material`, scene);
  ground.material = groundMaterial;
  lobbyGround.material = groundMaterial;
  lobbyGround.position.y = -0.04;

  const wallMaterial = new StandardMaterial(`${options.prefix}-wall-material`, scene);
  const north = MeshBuilder.CreateBox(`${options.prefix}-wall-north`, { width: 1, height: 3.5, depth: 1.2 }, scene);
  const south = MeshBuilder.CreateBox(`${options.prefix}-wall-south`, { width: 1, height: 3.5, depth: 1.2 }, scene);
  const east = MeshBuilder.CreateBox(`${options.prefix}-wall-east`, { width: 1.2, height: 3.5, depth: 1 }, scene);
  const west = MeshBuilder.CreateBox(`${options.prefix}-wall-west`, { width: 1.2, height: 3.5, depth: 1 }, scene);

  north.material = wallMaterial;
  south.material = wallMaterial;
  east.material = wallMaterial;
  west.material = wallMaterial;

  const updateBounds = (mapHalfExtent: number, phase: GamePhase) => {
    const wallThickness = 1.2;
    const wallHeight = 3.5;
    const edge = mapHalfExtent + wallThickness / 2;
    const full = mapHalfExtent * 2 + wallThickness;
    const diameter = mapHalfExtent * 2;
    const isLobby = phase === "lobby";

    ground.scaling.x = mapHalfExtent * 2;
    ground.scaling.z = mapHalfExtent * 2;
    ground.isVisible = !isLobby;

    lobbyGround.scaling.x = diameter;
    lobbyGround.scaling.z = diameter;
    lobbyGround.isVisible = isLobby;

    north.scaling.x = full;
    north.position.set(0, wallHeight / 2, edge);
    north.isVisible = !isLobby;

    south.scaling.x = full;
    south.position.set(0, wallHeight / 2, -edge);
    south.isVisible = !isLobby;

    east.scaling.z = full;
    east.position.set(edge, wallHeight / 2, 0);
    east.isVisible = !isLobby;

    west.scaling.z = full;
    west.position.set(-edge, wallHeight / 2, 0);
    west.isVisible = !isLobby;
  };

  const updatePalette = (groundColor: string, wallColor: string) => {
    groundMaterial.diffuseColor = Color3.FromHexString(groundColor);
    wallMaterial.diffuseColor = Color3.FromHexString(wallColor);
  };

  updatePalette(options.groundColor, options.wallColor);
  updateBounds(options.initialMapHalfExtent ?? DEFAULT_MAP_HALF_EXTENT, "lobby");

  return { groundMaterial, wallMaterial, updateBounds, updatePalette };
}

export function createWorldPlayerMesh(scene: Scene, name: string, color: string) {
  // Render all live player avatars with the same mesh silhouette in every world scene.
  const mesh = MeshBuilder.CreateSphere(name, { diameter: 2.6 }, scene);
  const material = new StandardMaterial(`${name}-material`, scene);
  material.diffuseColor = safeColor(color, Color3.FromHexString("#94a3b8"));
  mesh.material = material;
  return { mesh, material };
}

export function createWorldBodyMesh(scene: Scene, name: string) {
  // Keep dead-body markers identical between player and server views.
  const mesh = MeshBuilder.CreateCylinder(name, { height: 1.4, diameter: 1.2 }, scene);
  const material = new StandardMaterial(`${name}-material`, scene);
  material.diffuseColor = Color3.FromHexString("#ff5d73");
  mesh.material = material;
  mesh.rotation.z = Math.PI / 2;
  mesh.position.y = BODY_MESH_Y;
  return { mesh, material };
}

export function createWorldPuzzleStationMesh(scene: Scene, name: string, kind: PuzzleKind): WorldPuzzleStationMesh {
  // Build one shared station pedestal model so player and server views render tasks consistently.
  const mesh = MeshBuilder.CreateCylinder(name, { height: 2.4, diameter: 2.8 }, scene);
  const material = new StandardMaterial(`${name}-material`, scene);
  material.diffuseColor = kind === "timer" ? Color3.FromHexString("#9b87f5") : Color3.FromHexString("#38bdf8");
  material.emissiveColor = material.diffuseColor.scale(0.2);
  mesh.material = material;
  mesh.position.y = PUZZLE_STATION_Y;

  // Mount a floating dynamic-texture plane above the pedestal for the live puzzle projection.
  const projectionMesh = MeshBuilder.CreatePlane(`${name}-projection`, { width: 4.2, height: 4.2 }, scene);
  projectionMesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  projectionMesh.position.y = PUZZLE_PROJECTION_Y;
  projectionMesh.parent = mesh;
  projectionMesh.isPickable = false;
  projectionMesh.isVisible = false;

  const projectionTexture = new DynamicTexture(`${name}-projection-texture`, { width: 1024, height: 1024 }, scene, true);
  projectionTexture.hasAlpha = true;
  const projectionMaterial = new StandardMaterial(`${name}-projection-material`, scene);
  projectionMaterial.diffuseTexture = projectionTexture;
  projectionMaterial.emissiveColor = Color3.White();
  projectionMaterial.specularColor = Color3.Black();
  projectionMaterial.useAlphaFromDiffuseTexture = true;
  projectionMaterial.backFaceCulling = false;
  projectionMesh.material = projectionMaterial;

  return {
    mesh,
    material,
    projectionMesh,
    projectionMaterial,
    projectionTexture,
    setStatus(completed: boolean, occupied: boolean) {
      material.diffuseColor = completed
        ? Color3.FromHexString("#34d399")
        : kind === "timer"
          ? Color3.FromHexString("#9b87f5")
          : Color3.FromHexString("#38bdf8");
      material.emissiveColor = occupied ? Color3.FromHexString("#f8fafc") : material.diffuseColor.scale(0.2);
      projectionMesh.isVisible = occupied;
    },
  };
}

export function clampToMap(value: number, mapHalfExtent: number) {
  return Math.max(-mapHalfExtent, Math.min(mapHalfExtent, value));
}

export function clampPositionToPhaseBounds(x: number, z: number, mapHalfExtent: number, phase: GamePhase) {
  if (phase !== "lobby") {
    return {
      x: clampToMap(x, mapHalfExtent),
      z: clampToMap(z, mapHalfExtent),
    };
  }

  // Keep the lobby circular while the actual match map stays square.
  const distanceSq = (x * x) + (z * z);
  const radiusSq = mapHalfExtent * mapHalfExtent;
  if (distanceSq <= radiusSq || distanceSq === 0) {
    return { x, z };
  }

  const scale = mapHalfExtent / Math.sqrt(distanceSq);
  return {
    x: x * scale,
    z: z * scale,
  };
}

export function getSnapshotMapHalfExtent(snapshot: WorldSnapshot | null) {
  return snapshot?.mapHalfExtent ?? DEFAULT_MAP_HALF_EXTENT;
}

export function getServerViewOrthoHalfHeight(mapHalfExtent: number) {
  return Math.max(28, mapHalfExtent + 10);
}

export function applyWorldTheme(
  scene: Scene,
  arena: SharedArenaState,
  phase: GamePhase,
  activeSabotages: WorldSnapshot["activeSabotages"],
) {
  // Drive the arena palette from phase so the projector and player scenes stay visually aligned.
  const lightsOff = activeSabotages.some((sabotage) => sabotage.kind === "lights_off");
  const palette = getWorldPalette(phase, lightsOff);
  scene.clearColor = palette.clearColor;
  arena.updatePalette(palette.ground, palette.wall);
}

export function applyGrayPlayerTint(
  players: Map<string, { material: StandardMaterial }>,
  snapshotPlayers: SnapshotPlayer[],
  activeSabotages: WorldSnapshot["activeSabotages"],
) {
  // Mirror sabotage tinting through one shared rule for all views.
  const grayPlayers = activeSabotages.some((sabotage) => sabotage.kind === "gray_players");
  const playerById = new Map(snapshotPlayers.map((player) => [player.id, player]));

  for (const [id, state] of players) {
    const snapshotPlayer = playerById.get(id);
    if (!snapshotPlayer) continue;
    state.material.diffuseColor = grayPlayers
      ? Color3.FromHexString("#8e909a")
      : safeColor(snapshotPlayer.color, Color3.FromHexString("#94a3b8"));
  }
}

export function setMeshHeight(mesh: Mesh, playerState: SnapshotPlayer["state"] | SnapshotDeadBody["reported"]) {
  if (typeof playerState === "boolean") {
    mesh.position.y = BODY_MESH_Y;
    return;
  }

  mesh.position.y = playerState === "ghost" ? GHOST_MESH_Y : PLAYER_MESH_Y;
}

function getWorldPalette(phase: GamePhase, lightsOff: boolean): WorldPalette {
  if (lightsOff) {
    return {
      clearColor: new Color4(0.05, 0.07, 0.13, 1),
      ground: "#1d2736",
      wall: "#5d718d",
    };
  }

  if (phase === "lobby") {
    return {
      clearColor: new Color4(0.6, 0.8, 0.95, 1),
      ground: "#4f7d5c",
      wall: "#ffd166",
    };
  }

  return {
    clearColor:
      phase === "meeting"
        ? new Color4(0.15, 0.11, 0.18, 1)
        : phase === "ejection"
          ? new Color4(0.18, 0.11, 0.08, 1)
          : phase === "win"
            ? new Color4(0.1, 0.1, 0.1, 1)
            : new Color4(0.81, 0.89, 0.99, 1),
    ground: "#243b55",
    wall: "#8bb4ff",
  };
}

function safeColor(value: string, fallback: Color3) {
  try {
    return Color3.FromHexString(value);
  } catch {
    return fallback;
  }
}
