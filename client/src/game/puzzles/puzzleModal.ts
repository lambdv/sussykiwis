import type { PuzzleStationSnapshot, SnapshotPlayer } from "../../networking/message";
import { drawTimerPuzzleScene } from "./timerPuzzleScene";
import { createWireLayout, drawWiresPuzzleScene, pickWireSocket } from "./wiresPuzzleScene";

type PuzzleModalState = {
  station: PuzzleStationSnapshot | null;
  player: SnapshotPlayer | null;
};

type PuzzleModalActions = {
  onCancel: () => void;
  onTap: () => void;
  onConnect: (fromIndex: number, toIndex: number) => void;
};

export function createPuzzleModal(actions: PuzzleModalActions) {
  const root = document.createElement("div");
  const card = document.createElement("div");
  const title = document.createElement("div");
  const progress = document.createElement("div");
  const closeButton = document.createElement("button");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const dragState = { fromIndex: null as number | null, pointerX: 0, pointerY: 0 };
  let currentState: PuzzleModalState = { station: null, player: null };

  // Mount a fullscreen modal so the local player can focus on the task while the world keeps running underneath.
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.display = "none";
  root.style.alignItems = "center";
  root.style.justifyContent = "center";
  root.style.background = "rgba(2, 6, 23, 0.78)";
  root.style.zIndex = "30";
  root.style.pointerEvents = "auto";

  card.style.width = "min(92vw, 560px)";
  card.style.padding = "1rem";
  card.style.borderRadius = "1rem";
  card.style.background = "rgba(15, 23, 42, 0.98)";
  card.style.boxShadow = "0 24px 80px rgba(0, 0, 0, 0.45)";
  card.style.display = "flex";
  card.style.flexDirection = "column";
  card.style.gap = "0.75rem";

  title.style.color = "#f8fafc";
  title.style.font = "700 1.25rem system-ui, sans-serif";

  progress.style.color = "#cbd5e1";
  progress.style.font = "500 0.95rem system-ui, sans-serif";

  closeButton.textContent = "Leave Puzzle";
  closeButton.style.alignSelf = "flex-end";
  closeButton.style.padding = "0.65rem 0.9rem";
  closeButton.style.border = "0";
  closeButton.style.borderRadius = "999px";
  closeButton.style.background = "#334155";
  closeButton.style.color = "#f8fafc";
  closeButton.style.fontWeight = "700";
  closeButton.style.touchAction = "manipulation";
  closeButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    actions.onCancel();
  });

  canvas.width = 900;
  canvas.height = 900;
  canvas.style.width = "100%";
  canvas.style.aspectRatio = "1 / 1";
  canvas.style.borderRadius = "0.9rem";
  canvas.style.background = "#08111f";
  canvas.style.touchAction = "none";

  // Send local puzzle inputs back to the server so the simulation remains authoritative.
  canvas.addEventListener("pointerdown", (event) => {
    const projection = currentState.station?.projection;
    if (!projection) return;

    event.preventDefault();
    const point = getCanvasPoint(canvas, event);
    dragState.pointerX = point.x;
    dragState.pointerY = point.y;

    if (projection.kind === "timer") {
      actions.onTap();
      return;
    }

    if (!canUseWireProjection(projection)) {
      return;
    }

    const layout = createWireLayout(canvas.width, canvas.height, projection);
    dragState.fromIndex = pickWireSocket(layout, "left", point.x, point.y);
    render();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (dragState.fromIndex === null) return;
    const point = getCanvasPoint(canvas, event);
    dragState.pointerX = point.x;
    dragState.pointerY = point.y;
    render();
  });

  const finishWireDrag = (event: PointerEvent) => {
    const projection = currentState.station?.projection;
    if (dragState.fromIndex === null || projection?.kind !== "wires") {
      dragState.fromIndex = null;
      return;
    }

    if (!canUseWireProjection(projection)) {
      dragState.fromIndex = null;
      return;
    }

    const point = getCanvasPoint(canvas, event);
    const layout = createWireLayout(canvas.width, canvas.height, projection);
    const toIndex = pickWireSocket(layout, "right", point.x, point.y);
    if (toIndex !== null) {
      // Optimistic update
      if (!projection.connectedPairs.some(p => p.fromIndex === dragState.fromIndex)) {
          projection.connectedPairs.push({ fromIndex: dragState.fromIndex, toIndex });
      }
      actions.onConnect(dragState.fromIndex, toIndex);
    }

    dragState.fromIndex = null;
    dragState.pointerX = point.x;
    dragState.pointerY = point.y;
    render();
  };

  canvas.addEventListener("pointerup", finishWireDrag);
  canvas.addEventListener("pointercancel", finishWireDrag);

  card.append(title, progress, closeButton, canvas);
  root.appendChild(card);
  document.body.appendChild(root);

  function render() {
    if (!context) {
      return;
    }

    const station = currentState.station;
    const projection = station?.projection;
    if (!station || !projection) {
      root.style.display = "none";
      dragState.fromIndex = null;
      return;
    }

    root.style.display = "flex";
    title.textContent = station.kind === "timer" ? "Spin Tile" : "Connect The Neural Network";
    progress.textContent = currentState.player
      ? `Tasks ${currentState.player.completedPuzzleCount} / ${currentState.player.totalPuzzleCount}`
      : "Tasks syncing...";

    if (projection.kind === "timer") {
      drawTimerPuzzleScene(context, canvas.width, canvas.height, projection);
      return;
    }

    drawWiresPuzzleScene(context, canvas.width, canvas.height, projection, dragState);
  }

  return {
    update(state: PuzzleModalState) {
      currentState = state;
      if (!state.station) {
        dragState.fromIndex = null;
      }
      render();
    },
    dispose() {
      root.remove();
    },
  };
}

function getCanvasPoint(canvas: HTMLCanvasElement, event: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
    y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
  };
}

function canUseWireProjection(projection: PuzzleStationSnapshot["projection"]) {
  return projection?.kind === "wires"
    && Array.isArray(projection.leftColors)
    && Array.isArray(projection.rightColors)
    && Array.isArray(projection.connectedPairs);
}
