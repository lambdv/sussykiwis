import type { PuzzleProjectionState, WireColor } from "../../networking/message";

type WireSocket = {
  x: number;
  y: number;
  color: WireColor;
};

export type WireLayout = {
  left: WireSocket[];
  right: WireSocket[];
  radius: number;
};

export function createWireLayout(
  width: number,
  height: number,
  projection: Extract<PuzzleProjectionState, { kind: "wires" }>,
): WireLayout {
  const startY = height * 0.24;
  const gap = height * 0.14;
  const radius = Math.max(18, width * 0.03);

  return {
    left: projection.leftColors.map((color, index) => ({ x: width * 0.22, y: startY + (index * gap), color })),
    right: projection.rightColors.map((color, index) => ({ x: width * 0.78, y: startY + (index * gap), color })),
    radius,
  };
}

export function pickWireSocket(
  layout: WireLayout,
  side: "left" | "right",
  x: number,
  y: number,
): number | null {
  const sockets = side === "left" ? layout.left : layout.right;
  for (let index = 0; index < sockets.length; index += 1) {
    const socket = sockets[index];
    const dx = x - socket.x;
    const dy = y - socket.y;
    if ((dx * dx) + (dy * dy) <= layout.radius * layout.radius * 1.8) {
      return index;
    }
  }

  return null;
}

export function drawWiresPuzzleScene(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  projection: Extract<PuzzleProjectionState, { kind: "wires" }>,
  dragState: { fromIndex: number | null; pointerX: number; pointerY: number },
) {
  if (!isValidWireProjection(projection)) {
    drawPuzzleSyncMessage(context, width, height, "Syncing wires...");
    return;
  }

  const layout = createWireLayout(width, height, projection);

  // Paint the static panel frame before drawing sockets and live wire paths.
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#08111f";
  context.fillRect(0, 0, width, height);

  context.fillStyle = "#e2e8f0";
  context.font = `bold ${Math.round(width * 0.06)}px Arial`;
  context.textAlign = "center";
  context.fillText("Wires", width / 2, height * 0.16);

  context.strokeStyle = "rgba(148, 163, 184, 0.24)";
  context.lineWidth = Math.max(4, width * 0.006);
  context.strokeRect(width * 0.12, height * 0.2, width * 0.76, height * 0.58);

  // Draw locked-in authoritative wire connections first so the drag preview overlays them.
  for (const pair of projection.connectedPairs) {
    const from = layout.left[pair.fromIndex];
    const to = layout.right[pair.toIndex];
    if (!from || !to) continue;

    context.strokeStyle = wireColorToHex(from.color);
    context.lineWidth = Math.max(10, width * 0.014);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.bezierCurveTo(width * 0.42, from.y, width * 0.58, to.y, to.x, to.y);
    context.stroke();
  }

  if (dragState.fromIndex !== null) {
    const from = layout.left[dragState.fromIndex];
    if (from) {
      context.strokeStyle = wireColorToHex(from.color);
      context.lineWidth = Math.max(10, width * 0.014);
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.bezierCurveTo(width * 0.42, from.y, width * 0.58, dragState.pointerY, dragState.pointerX, dragState.pointerY);
      context.stroke();
    }
  }

  // Draw the colored endpoints last so they stay readable over the wire strokes.
  for (const socket of [...layout.left, ...layout.right]) {
    context.fillStyle = wireColorToHex(socket.color);
    context.beginPath();
    context.arc(socket.x, socket.y, layout.radius, 0, Math.PI * 2);
    context.fill();

    context.strokeStyle = "#f8fafc";
    context.lineWidth = Math.max(4, width * 0.006);
    context.stroke();
  }

  context.fillStyle = "#cbd5e1";
  context.font = `${Math.round(width * 0.038)}px Arial`;
  context.fillText("Drag each left wire to its matching color", width / 2, height * 0.88);
}

function wireColorToHex(color: WireColor) {
  switch (color) {
    case "red":
      return "#ef4444";
    case "blue":
      return "#3b82f6";
    case "yellow":
      return "#eab308";
    case "green":
      return "#22c55e";
  }
}

function isValidWireProjection(projection: Extract<PuzzleProjectionState, { kind: "wires" }>) {
  return Array.isArray(projection.leftColors)
    && Array.isArray(projection.rightColors)
    && Array.isArray(projection.connectedPairs)
    && projection.leftColors.length === 4
    && projection.rightColors.length === 4;
}

function drawPuzzleSyncMessage(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  message: string,
) {
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#08111f";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#cbd5e1";
  context.font = `bold ${Math.round(width * 0.05)}px Arial`;
  context.textAlign = "center";
  context.fillText(message, width / 2, height / 2);
}
