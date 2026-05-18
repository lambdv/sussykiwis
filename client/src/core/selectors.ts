import type {
  PlayerRole,
  PuzzleStationSnapshot,
  SnapshotDeadBody,
  SnapshotPlayer,
  WorldSnapshot,
} from "../networking/message";

const BODY_INTERACTION_RANGE_SQ = 16;
const KILL_INTERACTION_RANGE_SQ = 36;
const PUZZLE_INTERACTION_RANGE_SQ = 20.25;

export function getLocalPlayer(snapshot: WorldSnapshot | null, localPlayerId: string | null) {
  return snapshot?.players.find((player) => player.id === localPlayerId) ?? null;
}

export function findNearbyBody(x: number, y: number, bodies: SnapshotDeadBody[]) {
  let best: SnapshotDeadBody | null = null;
  let bestDistSq = BODY_INTERACTION_RANGE_SQ;

  for (const body of bodies) {
    if (body.reported) continue;
    const distSq = distanceSq(x, y, body.x, body.z);
    if (distSq < bestDistSq) {
      best = body;
      bestDistSq = distSq;
    }
  }

  return best;
}

export function findNearbyAliveTarget(x: number, y: number, playerId: string, players: SnapshotPlayer[]) {
  let best: SnapshotPlayer | null = null;
  let bestDistSq = KILL_INTERACTION_RANGE_SQ;

  for (const player of players) {
    if (player.id === playerId || player.state !== "alive") continue;
    const distSq = distanceSq(x, y, player.x, player.z);
    if (distSq < bestDistSq) {
      best = player;
      bestDistSq = distSq;
    }
  }

  return best;
}

export function findNearbyPuzzle(x: number, y: number, localPlayerId: string, stations: PuzzleStationSnapshot[]) {
  let best: PuzzleStationSnapshot | null = null;
  let bestDistSq = PUZZLE_INTERACTION_RANGE_SQ;

  for (const station of stations) {
    if (station.occupiedBy !== null || station.completedBy.includes(localPlayerId)) {
      continue;
    }

    const distSq = distanceSq(x, y, station.x, station.z);
    if (distSq < bestDistSq) {
      best = station;
      bestDistSq = distSq;
    }
  }

  return best;
}

export function canPlayerWorkPuzzle(snapshot: WorldSnapshot | null, player: SnapshotPlayer | null) {
  return snapshot?.phase === "playing"
    && !!player
    && (player.role === "crewmate" || player.role === "sheriff")
    && (player.state === "alive" || player.state === "ghost");
}

export function deriveHudState(snapshot: WorldSnapshot | null, localPlayerId: string | null, localRole: PlayerRole | null) {
  const localPlayer = getLocalPlayer(snapshot, localPlayerId);
  const localX = localPlayer?.x;
  const localY = localPlayer?.z;
  const nearbyBody = snapshot && localPlayer && localX !== undefined && localY !== undefined
    ? findNearbyBody(localX, localY, snapshot.deadBodies)
    : null;
  const nearbyTarget = snapshot && localPlayer && localX !== undefined && localY !== undefined
    ? findNearbyAliveTarget(localX, localY, localPlayer.id, snapshot.players)
    : null;
  const nearbyPuzzle = snapshot && localPlayer && localX !== undefined && localY !== undefined
    ? findNearbyPuzzle(localX, localY, localPlayer.id, snapshot.puzzleStations)
    : null;
  const activePuzzle = snapshot?.puzzleStations.find((station) => station.occupiedBy === localPlayerId) ?? null;
  const isAlive = snapshot?.phase === "playing" && localPlayer?.state === "alive";
  const canWorkPuzzle = canPlayerWorkPuzzle(snapshot, localPlayer);
  const killCooldownRemainingMs = Math.max(0, (localPlayer?.killCooldownEndsAt ?? 0) - (snapshot?.serverTime ?? 0));

  return {
    localPlayer,
    nearbyBody,
    nearbyTarget,
    nearbyPuzzle,
    activePuzzle,
    canReport: Boolean(isAlive && nearbyBody),
    canKill: Boolean(
      isAlive
      && nearbyTarget
      && killCooldownRemainingMs <= 0
      && (localRole === "imposter" || localRole === "sheriff"),
    ),
    canSabotage: Boolean(isAlive && localRole === "imposter"),
    canWorkPuzzle,
    killCooldownRemainingSeconds: Math.ceil(killCooldownRemainingMs / 1000),
  };
}

function distanceSq(ax: number, ay: number, bx: number, by: number) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
