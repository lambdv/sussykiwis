import {
  AbstractMesh,
  ArcRotateCamera,
  Camera,
  Color3,
  Color4,
  DirectionalLight,
  Mesh,
  MeshBuilder,
  Scene,
  SceneLoader,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import "@babylonjs/loaders/OBJ";
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

type KiwiVariant = {
  fileName: string;
};

const KIWI_FALLBACK_VARIANT: KiwiVariant = { fileName: "kiwiBlack.obj" };
const KIWI_VARIANTS: Record<string, KiwiVariant> = {
  "#ef4444": { fileName: "KiwiPink.obj" },
  "#3b82f6": { fileName: "kiwiBlue.obj" },
  "#22c55e": { fileName: "kiwiGreenobj.obj" },
  "#eab308": { fileName: "kiwiGold.obj" },
  "#a855f7": { fileName: "kiwiPurple.obj" },
  "#f97316": { fileName: "kiwiOrange.obj" },
};
const KIWI_ASSET_BASE_URL = "/assets/kiwis/";
const kiwiTemplateCache = new Map<string, Promise<AbstractMesh[]>>();

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
  const shouldUseMobileZoom = typeof window !== "undefined" && options.canvas !== undefined;

  camera.lowerAlphaLimit = camera.upperAlphaLimit = camera.alpha;
  camera.lowerBetaLimit = camera.upperBetaLimit = camera.beta;
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;

  scene.onBeforeRenderObservable.add(() => {
    // Keep world units stable across aspect ratios so server and player views frame identically.
    const engine = scene.getEngine();
    const width = Math.max(1, options.canvas?.clientWidth ?? engine.getRenderWidth());
    const height = Math.max(1, options.canvas?.clientHeight ?? engine.getRenderHeight());
    const aspect = width / height;
    const halfHeight = getViewportScaledHalfHeight(currentHalfHeight, width, height, shouldUseMobileZoom);
    const halfWidth = halfHeight * aspect;
    camera.orthoLeft = -halfWidth;
    camera.orthoRight = halfWidth;
    camera.orthoBottom = -halfHeight;
    camera.orthoTop = halfHeight;
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

function getViewportScaledHalfHeight(baseHalfHeight: number, width: number, height: number, enabled: boolean) {
  // Pull the camera closer on compact screens while preserving desktop framing.
  if (!enabled) {
    return baseHalfHeight;
  }

  const shortEdge = Math.min(width, height);
  const maxShortEdge = 1080;
  const minShortEdge = 540;
  const clampedShortEdge = Math.min(maxShortEdge, Math.max(minShortEdge, shortEdge));
  const t = (clampedShortEdge - minShortEdge) / (maxShortEdge - minShortEdge);
const mobileScale = 0.5  * t;
return baseHalfHeight * mobileScale;
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
  // Create a stable root node immediately, then swap in the color-matched kiwi OBJ when it loads.
  const mesh = new TransformNode(name, scene);
  mesh.position.y = PLAYER_MESH_Y;
  void attachKiwiVariant(scene, mesh, color);
  return { mesh };
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
  players: Map<string, { mesh: TransformNode }>,
  snapshotPlayers: SnapshotPlayer[],
  activeSabotages: WorldSnapshot["activeSabotages"],
) {
  // Mirror sabotage tinting through one shared rule for all views.
  const grayPlayers = activeSabotages.some((sabotage) => sabotage.kind === "gray_players");
  const playerById = new Map(snapshotPlayers.map((player) => [player.id, player]));

  for (const [id, state] of players) {
    if (!playerById.has(id)) continue;

    for (const child of state.mesh.getChildMeshes(false)) {
      const material = child.material;
      if (!(material instanceof StandardMaterial)) continue;
      material.diffuseColor = grayPlayers ? Color3.FromHexString("#8e909a") : Color3.White();
    }
  }
}

export function setMeshHeight(mesh: TransformNode, playerState: SnapshotPlayer["state"] | SnapshotDeadBody["reported"]) {
  if (typeof playerState === "boolean") {
    mesh.position.y = BODY_MESH_Y;
    return;
  }

  mesh.position.y = playerState === "ghost" ? GHOST_MESH_Y : PLAYER_MESH_Y;
}

export function applyPlayerFacing(mesh: TransformNode, facingYaw: number) {
  // The kiwi asset faces 90 degrees right in model space, so offset it left for world-facing.
  mesh.rotation.y = facingYaw - (Math.PI / 2);
}

export function getFacingYawFromMovement(moveX: number, moveZ: number) {
  // Convert a world-space movement vector into the kiwi root yaw.
  return Math.atan2(moveX, moveZ);
}

export function lerpAngle(start: number, end: number, alpha: number) {
  // Interpolate through the shortest turn so remote players do not spin across wrap boundaries.
  const delta = Math.atan2(Math.sin(end - start), Math.cos(end - start));
  return start + delta * alpha;
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

function attachKiwiVariant(scene: Scene, mesh: TransformNode, color: string) {
  const variant = getKiwiVariant(color);
  void loadKiwiTemplate(scene, variant.fileName).then((meshes) => {
    if (mesh.isDisposed()) return;

    for (const templateMesh of meshes) {
      const clone = templateMesh.clone(`${mesh.name}-clone`, mesh, true);
      if (clone) {
        // Re-enable the cloned render mesh because the cached template stays hidden in-scene.
        clone.setEnabled(true);
        clone.isVisible = true;
        clone.isPickable = false;
        // Keep per-clone materials independent so later effects do not mutate the shared template.
        clone.material = clone.material?.clone(`${clone.name}-material`) ?? null;
      }
    }
  });
}

function getKiwiVariant(color: string) {
  const normalized = color.trim().toLowerCase();
  return KIWI_VARIANTS[normalized] ?? KIWI_FALLBACK_VARIANT;
}

async function loadKiwiTemplate(scene: Scene, fileName: string) {
  const cached = kiwiTemplateCache.get(fileName);
  if (cached) return cached;

  const promise = SceneLoader.ImportMeshAsync("", KIWI_ASSET_BASE_URL, fileName, scene).then((result) => {
    const meshes = result.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0);
    // Keep only renderable template meshes and hide them so clones own the visible scene state.
    for (const m of result.meshes) {
      m.setEnabled(false);
      m.isPickable = false;
      m.isVisible = false;
      m.parent = null;
    }
    return meshes;
  });

  kiwiTemplateCache.set(fileName, promise);
  return promise;
}
