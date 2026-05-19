import type { GamePhase, PlayerState, SnapshotPlayer, WorldSnapshot } from "../networking/message";

export type PendingInput = {
  seq: number;
  moveX: number;
  moveY: number;
  dt: number;
  facingLeft: boolean | null;
};

export type RemoteSnapshot = {
  time: number;
  x: number;
  y: number;
  facingLeft: boolean;
};

export function updateRenderTime(currentRenderTime: number, latestServerTime: number, dtMs: number) {
  const interpolationDelay = 100;

  if (currentRenderTime === 0 && latestServerTime > 0) {
    return latestServerTime - interpolationDelay;
  }

  if (latestServerTime <= 0) {
    return currentRenderTime;
  }

  const nextRenderTime = currentRenderTime + dtMs;
  const targetRenderTime = latestServerTime - interpolationDelay;
  const diff = targetRenderTime - nextRenderTime;
  return nextRenderTime + diff * 0.1;
}

export function getFacingFromMovement(x: number, _y: number) {
  if (x === 0) {
    return null;
  }

  return x < 0;
}

export function clampToPhaseBounds(x: number, y: number, mapHalfExtent: number, phase: GamePhase) {
  if (phase !== "lobby") {
    return {
      x: clampToMap(x, mapHalfExtent),
      y: clampToMap(y, mapHalfExtent),
    };
  }

  const distanceSq = (x * x) + (y * y);
  const radiusSq = mapHalfExtent * mapHalfExtent;
  if (distanceSq <= radiusSq || distanceSq === 0) {
    return { x, y };
  }

  const scale = mapHalfExtent / Math.sqrt(distanceSq);
  return {
    x: x * scale,
    y: y * scale,
  };
}

export function canLocallyMove(phase: GamePhase, state: PlayerState) {
  return phase === "lobby" || (phase === "playing" && (state === "alive" || state === "ghost"));
}

export function reconcileLocalPlayer(
  snapshotPlayer: SnapshotPlayer,
  pendingInputs: PendingInput[],
  moveSpeed: number,
  mapHalfExtent: number,
  phase: GamePhase,
) {
  let targetX = snapshotPlayer.x;
  let targetY = snapshotPlayer.z;
  // Initialize target facing directly from the authoritative snapshot player state
  let targetFacingLeft = snapshotPlayer.facingLeft;

  while (pendingInputs.length > 0 && pendingInputs[0].seq <= snapshotPlayer.lastProcessedSeq) {
    pendingInputs.shift();
  }

  for (const input of pendingInputs) {
    targetX += input.moveX * moveSpeed * input.dt;
    targetY += input.moveY * moveSpeed * input.dt;
    if (input.facingLeft !== null) {
      targetFacingLeft = input.facingLeft;
    }
  }

  const clamped = clampToPhaseBounds(targetX, targetY, mapHalfExtent, phase);
  return {
    x: clamped.x,
    y: clamped.y,
    facingLeft: targetFacingLeft,
  };
}

export function predictLocalPlayer(
  x: number,
  y: number,
  moveX: number,
  moveY: number,
  dt: number,
  moveSpeed: number,
  mapHalfExtent: number,
  phase: GamePhase,
) {
  return clampToPhaseBounds(x + moveX * moveSpeed * dt, y + moveY * moveSpeed * dt, mapHalfExtent, phase);
}

export function getRemoteRenderPosition(snapshots: RemoteSnapshot[], renderTime: number) {
  if (snapshots.length === 0) {
    return null;
  }

  if (renderTime > snapshots[snapshots.length - 1].time) {
    return extrapolateSnapshot(snapshots, renderTime);
  }

  if (renderTime < snapshots[0].time) {
    return snapshots[0];
  }

  let prev = snapshots[0];
  let next = snapshots[0];
  for (let i = 0; i < snapshots.length - 1; i += 1) {
    if (snapshots[i].time <= renderTime && snapshots[i + 1].time >= renderTime) {
      prev = snapshots[i];
      next = snapshots[i + 1];
      break;
    }
  }

  const timeDiff = next.time - prev.time;
  const alpha = timeDiff > 0 ? (renderTime - prev.time) / timeDiff : 0;
  return {
    time: renderTime,
    x: prev.x + (next.x - prev.x) * alpha,
    y: prev.y + (next.y - prev.y) * alpha,
    facingLeft: alpha < 0.5 ? prev.facingLeft : next.facingLeft,
  };
}

export function getMapHalfExtent(snapshot: WorldSnapshot | null) {
  return snapshot?.mapHalfExtent ?? 30;
}

function extrapolateSnapshot(snapshots: RemoteSnapshot[], renderTime: number) {
  const last = snapshots[snapshots.length - 1];
  let velocityX = 0;
  let velocityY = 0;

  if (snapshots.length > 1) {
    const previous = snapshots[snapshots.length - 2];
    const dt = Math.max(1, last.time - previous.time);
    velocityX = (last.x - previous.x) / dt;
    velocityY = (last.y - previous.y) / dt;
  }

  const overTime = renderTime - last.time;
  if (overTime >= 150) {
    return last;
  }

  return {
    time: renderTime,
    x: last.x + velocityX * overTime,
    y: last.y + velocityY * overTime,
    facingLeft: last.facingLeft,
  };
}

function clampToMap(value: number, mapHalfExtent: number) {
  return Math.max(-mapHalfExtent, Math.min(mapHalfExtent, value));
}
