import type { PuzzleStationSnapshot, SnapshotPlayer } from "../../networking/message";
import { drawTimerPuzzleScene, isTimerTapValid } from "./timerPuzzleScene";
import { createWireLayout, drawWiresPuzzleScene, pickWireSocket, type WireDragState } from "./wiresPuzzleScene";

type PuzzleModalState = {
  station: PuzzleStationSnapshot | null;
  player: SnapshotPlayer | null;
  serverTime: number;
};

type PuzzleModalActions = {
  onCancel: () => void;
  onTap: () => void;
  onSolved: () => void;
  onConnect: (fromIndex: number, toIndex: number) => void;
};

export function createPuzzleModal(actions: PuzzleModalActions) {
  const root = document.createElement("div");
  const card = document.createElement("div");
  const title = document.createElement("div");
  const progress = document.createElement("div");
  const headerRow = document.createElement("div");
  const headerText = document.createElement("div");
  const headerMeta = document.createElement("div");
  const fullscreenButton = document.createElement("button");
  const closeButton = document.createElement("button");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const dragState: WireDragState = { leftIndex: null, hiddenIndex: null, pointerX: 0, pointerY: 0 };
  let currentState: PuzzleModalState = { station: null, player: null, serverTime: 0 };

  // Mount a fullscreen modal so the local player can focus on the task while the world keeps running underneath.
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.display = "none";
  root.style.alignItems = "center";
  root.style.justifyContent = "center";
  root.style.background = "rgba(2, 6, 23, 0.78)";
  root.style.zIndex = "30";
  root.style.pointerEvents = "auto";
  root.style.padding = "max(0.75rem, env(safe-area-inset-top)) 0.75rem max(0.75rem, env(safe-area-inset-bottom))";

  card.style.width = "min(96vw, 560px)";
  card.style.padding = "1rem";
  card.style.borderRadius = "1rem";
  card.style.background = "rgba(15, 23, 42, 0.98)";
  card.style.boxShadow = "0 24px 80px rgba(0, 0, 0, 0.45)";
  card.style.display = "flex";
  card.style.flexDirection = "column";
  card.style.gap = "0.75rem";
  card.style.maxHeight = "100%";

  title.style.color = "#f8fafc";
  title.style.font = "700 1.25rem system-ui, sans-serif";

  progress.style.color = "#cbd5e1";
  progress.style.font = "500 0.95rem system-ui, sans-serif";

  headerRow.style.display = "flex";
  headerRow.style.alignItems = "flex-start";
  headerRow.style.justifyContent = "space-between";
  headerRow.style.gap = "0.75rem";

  headerText.style.display = "flex";
  headerText.style.flexDirection = "column";
  headerText.style.gap = "0.35rem";
  headerText.style.minWidth = "0";

  headerMeta.style.display = "flex";
  headerMeta.style.alignItems = "center";
  headerMeta.style.gap = "0.5rem";

  fullscreenButton.type = "button";
  fullscreenButton.style.width = "2.75rem";
  fullscreenButton.style.height = "2.75rem";
  fullscreenButton.style.border = "0";
  fullscreenButton.style.borderRadius = "999px";
  fullscreenButton.style.background = "#1e293b";
  fullscreenButton.style.color = "#f8fafc";
  fullscreenButton.style.display = "grid";
  fullscreenButton.style.placeItems = "center";
  fullscreenButton.style.touchAction = "manipulation";
  fullscreenButton.setAttribute("aria-label", "Enter fullscreen");
  syncFullscreenButton();

  closeButton.textContent = "Leave Puzzle";
  closeButton.style.alignSelf = "flex-end";
  closeButton.style.padding = "0.65rem 0.9rem";
  closeButton.style.border = "0";
  closeButton.style.borderRadius = "999px";
  closeButton.style.background = "#334155";
  closeButton.style.color = "#f8fafc";
  closeButton.style.fontWeight = "700";
  closeButton.style.touchAction = "manipulation";
  const onClosePointerDown = (event: PointerEvent) => {
    event.preventDefault();
    actions.onCancel();
  };
  closeButton.addEventListener("pointerdown", onClosePointerDown);

  // Toggle real browser fullscreen so mobile browsers can dedicate the full screen to the puzzle view.
  const onFullscreenPointerDown = async (event: PointerEvent) => {
    event.preventDefault();
    const activeElement = document.fullscreenElement;
    if (activeElement === root) {
      await document.exitFullscreen?.();
      return;
    }

    await root.requestFullscreen?.();
  };
  fullscreenButton.addEventListener("pointerdown", onFullscreenPointerDown);

  canvas.width = 900;
  canvas.height = 1100;
  canvas.style.width = "100%";
  canvas.style.height = "60vh";
  canvas.style.borderRadius = "0.9rem";
  canvas.style.background = "#08111f";
  canvas.style.touchAction = "none";

  const onCanvasPointerDown = (event: PointerEvent) => {
    const projection = currentState.station?.projection;
    if (!projection) return;

    event.preventDefault();
    const point = getCanvasPoint(canvas, event);
    dragState.pointerX = point.x;
    dragState.pointerY = point.y;

    if (projection.kind === "timer") {
      if (isTimerTapValid(projection)) {
        actions.onSolved();
      } else {
        actions.onTap();
      }
      return;
    }

    if (!canUseWireProjection(projection)) {
      return;
    }

    canvas.setPointerCapture?.(event.pointerId);
    const layout = createWireLayout(canvas.width, canvas.height, projection);
    const fromIndex = pickWireSocket(layout, "left", point.x, point.y);
    if (fromIndex !== null && !projection.connectedPairs.some((pair) => pair.fromIndex === fromIndex)) {
      dragState.leftIndex = fromIndex;
      dragState.hiddenIndex = null;
    }
    render();
  };
  canvas.addEventListener("pointerdown", onCanvasPointerDown);

  const onCanvasPointerMove = (event: PointerEvent) => {
    if (dragState.leftIndex === null) return;
    const point = getCanvasPoint(canvas, event);
    dragState.pointerX = point.x;
    dragState.pointerY = point.y;

    const projection = currentState.station?.projection;
    if (projection?.kind === "wires") {
      const layout = createWireLayout(canvas.width, canvas.height, projection);
      const activeColor = layout.left[dragState.leftIndex]?.color;
      const hoveredHidden = pickWireSocket(layout, "hidden", point.x, point.y);

      // Only unlock the second segment after the player actually reaches the matching middle neuron.
      if (activeColor && hoveredHidden !== null && layout.hidden[hoveredHidden]?.color === activeColor) {
        dragState.hiddenIndex = hoveredHidden;
      }
    }

    render();
  };
  canvas.addEventListener("pointermove", onCanvasPointerMove);

  const finishWireDrag = (event: PointerEvent) => {
    const projection = currentState.station?.projection;
    if (dragState.leftIndex === null || projection?.kind !== "wires") {
      resetDragState();
      return;
    }

    if (!canUseWireProjection(projection)) {
      resetDragState();
      return;
    }

    const point = getCanvasPoint(canvas, event);
    const layout = createWireLayout(canvas.width, canvas.height, projection);
    const toIndex = pickWireSocket(layout, "right", point.x, point.y);
    const activeColor = layout.left[dragState.leftIndex]?.color;
    if (
      toIndex !== null
      && dragState.hiddenIndex !== null
      && activeColor
      && layout.right[toIndex]?.color === activeColor
      && !projection.connectedPairs.some((pair) => pair.fromIndex === dragState.leftIndex || pair.toIndex === toIndex)
    ) {
      // Mirror the expected result locally so the path stays responsive until the next server snapshot arrives.
      projection.connectedPairs.push({ fromIndex: dragState.leftIndex, toIndex });
      actions.onConnect(dragState.leftIndex, toIndex);
    }

    resetDragState();
    dragState.pointerX = point.x;
    dragState.pointerY = point.y;
    render();
  };

  canvas.addEventListener("pointerup", finishWireDrag);
  canvas.addEventListener("pointercancel", finishWireDrag);
  canvas.addEventListener("pointerleave", finishWireDrag);

  // Keep the canvas sized off the phone viewport height so the puzzle uses vertical space well in portrait mode.
  const onViewportResize = () => {
    syncCanvasSize();
    render();
  };
  window.addEventListener("resize", onViewportResize);
  document.addEventListener("fullscreenchange", syncFullscreenButton);

  headerText.append(title, progress);
  headerMeta.append(fullscreenButton, closeButton);
  headerRow.append(headerText, headerMeta);
  card.append(headerRow, canvas);
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
      resetDragState();
      return;
    }

    root.style.display = "flex";
    syncCanvasSize();
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
        resetDragState();
      }
      render();
    },
    dispose() {
      root.remove();
      closeButton.removeEventListener("pointerdown", onClosePointerDown);
      fullscreenButton.removeEventListener("pointerdown", onFullscreenPointerDown);
      canvas.removeEventListener("pointerdown", onCanvasPointerDown);
      canvas.removeEventListener("pointermove", onCanvasPointerMove);
      canvas.removeEventListener("pointerup", finishWireDrag);
      canvas.removeEventListener("pointercancel", finishWireDrag);
      canvas.removeEventListener("pointerleave", finishWireDrag);
      window.removeEventListener("resize", onViewportResize);
      document.removeEventListener("fullscreenchange", syncFullscreenButton);
    },
  };

  function resetDragState() {
    dragState.leftIndex = null;
    dragState.hiddenIndex = null;
  }

  function syncCanvasSize() {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const cardWidth = Math.min(viewportWidth * 0.96, 560);
    const canvasCssWidth = Math.max(280, Math.min(cardWidth - 32, viewportWidth - 32));
    const canvasCssHeight = Math.max(360, Math.min(viewportHeight * 0.7, viewportHeight - 180));
    const dpr = window.devicePixelRatio || 1;

    canvas.style.height = `${Math.round(canvasCssHeight)}px`;
    canvas.width = Math.round(canvasCssWidth * dpr);
    canvas.height = Math.round(canvasCssHeight * dpr);
  }

  function syncFullscreenButton() {
    const isFullscreen = document.fullscreenElement === root;
    fullscreenButton.setAttribute("aria-label", isFullscreen ? "Exit fullscreen" : "Enter fullscreen");
    fullscreenButton.innerHTML = isFullscreen
      ? '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M19 12H7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 7 7 12l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
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
