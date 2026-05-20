type LdtkProject = {
  levels?: Array<{
    pxWid?: number;
    pxHei?: number;
    layerInstances?: Array<{
      __identifier?: string;
      __gridSize?: number;
      __cWid?: number;
      __cHei?: number;
      __tilesetRelPath?: string | null;
      gridTiles?: Array<{
        px?: [number, number];
        src?: [number, number];
      }>;
      intGridCsv?: number[];
    }>;
  }>;
};

export type LobbyTile = {
  px: [number, number];
  src: [number, number];
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

export function parseLobbyLayout(raw: unknown): LobbyLayout | null {
  const project = raw as LdtkProject | null;
  const level = project?.levels?.[0];
  const layers = level?.layerInstances ?? [];
  const ground = layers.find((layer) => layer.__identifier === "Ground");
  const collisions = layers.find((layer) => layer.__identifier === "Collisions");
  const gridSize = ground?.__gridSize ?? collisions?.__gridSize ?? 16;
  const width = collisions?.__cWid ?? ground?.__cWid ?? Math.round((level?.pxWid ?? 0) / gridSize);
  const height = collisions?.__cHei ?? ground?.__cHei ?? Math.round((level?.pxHei ?? 0) / gridSize);
  const tilesetPath = ground?.__tilesetRelPath ?? "";

  if (!level || !ground || !collisions || !tilesetPath || width <= 0 || height <= 0) {
    return null;
  }

  // Keep the LDtk level centered on the same origin the rest of the game already uses.
  return {
    width,
    height,
    gridSize,
    tilesetPath: `/assets/${tilesetPath.replace(/^\/+/, "")}`,
    tiles: (ground.gridTiles ?? []).flatMap((tile) => {
      if (!tile.px || !tile.src) {
        return [];
      }
      return [{ px: tile.px, src: tile.src }];
    }),
    solid: (collisions.intGridCsv ?? []).map((value) => value !== 0),
    halfWidth: width / 2,
    halfHeight: height / 2,
  };
}

export function resolveLobbyPosition(layout: LobbyLayout | null, currentX: number, currentY: number, targetX: number, targetY: number) {
  if (!layout) {
    return { x: targetX, y: targetY };
  }

  // Resolve one axis at a time so players slide along walls instead of sticking diagonally.
  let nextX = currentX;
  let nextY = currentY;
  if (!isSolid(layout, targetX, currentY)) {
    nextX = targetX;
  }
  if (!isSolid(layout, nextX, targetY)) {
    nextY = targetY;
  }
  return { x: nextX, y: nextY };
}

function isSolid(layout: LobbyLayout, x: number, y: number) {
  const cellX = Math.floor(x + layout.halfWidth);
  const cellY = Math.floor(y + layout.halfHeight);
  if (cellX < 0 || cellY < 0 || cellX >= layout.width || cellY >= layout.height) {
    return true;
  }
  return layout.solid[(cellY * layout.width) + cellX] ?? true;
}
