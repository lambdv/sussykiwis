type LdtkFieldDef = {
  identifier?: string;
  uid?: number;
  doc?: string | null;
};

type LdtkEntityDef = {
  uid?: number;
  fieldDefs?: LdtkFieldDef[];
};

type LdtkFieldInstance = {
  __identifier?: string;
  __value?: unknown;
  defUid?: number;
};

type LdtkEntityInstance = {
  __identifier?: string;
  px?: [number, number];
  width?: number;
  height?: number;
  defUid?: number;
  fieldInstances?: LdtkFieldInstance[];
};

type LdtkProject = {
  defs?: {
    entities?: LdtkEntityDef[];
  };
  levels?: Array<{
    pxWid?: number;
    pxHei?: number;
    layerInstances?: Array<{
      __identifier?: string;
      __type?: string;
      __gridSize?: number;
      __cWid?: number;
      __cHei?: number;
      __tilesetRelPath?: string | null;
      gridTiles?: Array<{
        px?: [number, number];
        src?: [number, number];
      }>;
      intGridCsv?: number[];
      entityInstances?: LdtkEntityInstance[];
    }>;
  }>;
};

export type LobbyTile = {
  px: [number, number];
  src: [number, number];
};

export type AuthoredTileLayer = {
  identifier: string;
  tilesetPath: string;
  tiles: LobbyTile[];
};

export type HideLayerZone = {
  identifier: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hideLayer: string | null;
};

export type AuthoredMapLayout = {
  width: number;
  height: number;
  gridSize: number;
  halfWidth: number;
  halfHeight: number;
  layers: AuthoredTileLayer[];
  hideZones: HideLayerZone[];
};

export type LobbyLayout = {
  width: number;
  height: number;
  gridSize: number;
  tilesetPath: string;
  tiles: LobbyTile[];
  solid: boolean[];
  halfWidth: number;
  halfHeight: number;
};

const PLAYER_HALF_EXTENT = 0.375;

export function parseAuthoredMap(raw: unknown): AuthoredMapLayout | null {
  const project = raw as LdtkProject | null;
  const level = project?.levels?.[0];
  const layers = level?.layerInstances ?? [];
  const tileLayers = layers.filter((layer) => layer.__type === "Tiles");
  const entityDefs = new Map<number, Map<number, LdtkFieldDef>>();

  // Cache entity field metadata so authored docs can fill in omitted instance values.
  for (const entityDef of project?.defs?.entities ?? []) {
    if (entityDef.uid === undefined) {
      continue;
    }
    entityDefs.set(
      entityDef.uid,
      new Map((entityDef.fieldDefs ?? []).flatMap((fieldDef) => fieldDef.uid === undefined ? [] : [[fieldDef.uid, fieldDef]])),
    );
  }

  const gridSize = tileLayers[0]?.__gridSize ?? layers[0]?.__gridSize ?? 16;
  const width = tileLayers[0]?.__cWid ?? layers[0]?.__cWid ?? Math.round((level?.pxWid ?? 0) / gridSize);
  const height = tileLayers[0]?.__cHei ?? layers[0]?.__cHei ?? Math.round((level?.pxHei ?? 0) / gridSize);

  if (!level || width <= 0 || height <= 0) {
    return null;
  }

  const levelWidth = width * gridSize;
  const levelHeight = height * gridSize;
  const parsedLayers = tileLayers.flatMap((layer) => {
    const identifier = layer.__identifier;
    const tilesetPath = layer.__tilesetRelPath;
    if (!identifier || !tilesetPath) {
      return [];
    }

    return [{
      identifier,
      tilesetPath: `/assets/${tilesetPath.replace(/^\/+/, "")}`,
      tiles: (layer.gridTiles ?? []).flatMap((tile) => {
        if (!tile.px || !tile.src) {
          return [];
        }
        return [{ px: tile.px, src: tile.src }];
      }),
    } satisfies AuthoredTileLayer];
  });

  const hideZones = layers.flatMap((layer) => (layer.entityInstances ?? []).flatMap((entity) => {
    if (!entity.px || !entity.width || !entity.height) {
      return [];
    }

    const fieldDefs = entity.defUid === undefined ? null : entityDefs.get(entity.defUid) ?? null;
    const fieldValues = new Map((entity.fieldInstances ?? []).map((field) => [field.__identifier ?? "", field]));
    const hideLayerField = fieldValues.get("hide_layer");
    const hideLayer = typeof hideLayerField?.__value === "string"
      ? hideLayerField.__value
      : typeof hideLayerField?.defUid === "number"
        ? fieldDefs?.get(hideLayerField.defUid)?.doc ?? null
        : null;

    // Convert LDtk top-left pixel bounds into the centered world coordinates used by the scene.
    return [{
      identifier: entity.__identifier ?? "Entity",
      x: entity.px[0] - (levelWidth / 2),
      y: entity.px[1] - (levelHeight / 2),
      width: entity.width,
      height: entity.height,
      hideLayer,
    } satisfies HideLayerZone];
  }));

  return {
    width,
    height,
    gridSize,
    halfWidth: width / 2,
    halfHeight: height / 2,
    layers: parsedLayers,
    hideZones,
  };
}

export function parseLobbyLayout(raw: unknown): LobbyLayout | null {
  const authored = parseAuthoredMap(raw);
  const project = raw as LdtkProject | null;
  const level = project?.levels?.[0];
  const layers = level?.layerInstances ?? [];
  const ground = layers.find((layer) => layer.__identifier === "Ground");
  const collisions = layers.find((layer) => layer.__identifier === "Collisions");
  const groundLayer = authored?.layers.find((layer) => layer.identifier === "Ground") ?? null;

  if (!level || !ground || !collisions || !authored || !groundLayer) {
    return null;
  }

  // Keep the LDtk level centered on the same origin the rest of the game already uses.
  return {
    width: authored.width,
    height: authored.height,
    gridSize: authored.gridSize,
    tilesetPath: groundLayer.tilesetPath,
    tiles: groundLayer.tiles,
    solid: (collisions.intGridCsv ?? []).map((value) => value !== 0),
    halfWidth: authored.halfWidth,
    halfHeight: authored.halfHeight,
  };
}

export function resolveLobbyPosition(layout: LobbyLayout | null, currentX: number, currentY: number, targetX: number, targetY: number) {
  if (!layout) {
    return { x: targetX, y: targetY };
  }

  // Resolve one axis at a time so players slide along walls instead of sticking diagonally.
  let nextX = currentX;
  let nextY = currentY;
  if (!hitsSolidCells(layout, targetX, currentY)) {
    nextX = targetX;
  }
  if (!hitsSolidCells(layout, nextX, targetY)) {
    nextY = targetY;
  }
  return { x: nextX, y: nextY };
}

function hitsSolidCells(layout: LobbyLayout, centerX: number, centerY: number) {
  const minCellX = Math.floor((centerX - PLAYER_HALF_EXTENT) + layout.halfWidth);
  const maxCellX = Math.floor((centerX + PLAYER_HALF_EXTENT) + layout.halfWidth - 0.000001);
  const minCellY = Math.floor((centerY - PLAYER_HALF_EXTENT) + layout.halfHeight);
  const maxCellY = Math.floor((centerY + PLAYER_HALF_EXTENT) + layout.halfHeight - 0.000001);

  for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      if (cellX < 0 || cellY < 0 || cellX >= layout.width || cellY >= layout.height) {
        return true;
      }

      if (layout.solid[(cellY * layout.width) + cellX]) {
        return true;
      }
    }
  }

  return false;
}
