import type { PuzzleProjectionState, WireColor } from "../../networking/message";

type WireSocket = {
  x: number;
  y: number;
  color: WireColor;
};

type HiddenNeuron = {
  x: number;
  y: number;
  color: WireColor;
};

export type WireLayout = {
  left: WireSocket[];
  hidden: HiddenNeuron[];
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
  const hiddenX = width * 0.5;
  const right = projection.rightColors.map((color, index) => ({ x: width * 0.78, y: startY + (index * gap), color }));

  return {
    left: projection.leftColors.map((color, index) => ({ x: width * 0.22, y: startY + (index * gap), color })),
    hidden: right.map((socket) => ({ x: hiddenX, y: socket.y, color: socket.color })),
    right,
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
   context.fillText("Neural Network", width / 2, height * 0.16);

  context.strokeStyle = "rgba(148, 163, 184, 0.24)";
  context.lineWidth = Math.max(4, width * 0.006);
  context.strokeRect(width * 0.12, height * 0.2, width * 0.76, height * 0.58);

  context.fillStyle = "#94a3b8";
  context.font = `bold ${Math.round(width * 0.025)}px Arial`;
  context.fillText("INPUT", width * 0.22, height * 0.24);
  context.fillText("HIDDEN", width * 0.5, height * 0.24);
  context.fillText("OUTPUT", width * 0.78, height * 0.24);

  // Draw the inactive network first so the active colored path reads clearly on top.
  for (const input of layout.left) {
    for (const hidden of layout.hidden) {
      drawWirePath(context, width, input.x, input.y, hidden.x, hidden.y, "rgba(100, 116, 139, 0.28)");
    }
  }

  for (const hidden of layout.hidden) {
    for (const output of layout.right) {
      drawWirePath(context, width, hidden.x, hidden.y, output.x, output.y, "rgba(100, 116, 139, 0.2)");
    }
  }

  // Draw locked-in authoritative wire connections first so the drag preview overlays them.
  for (const pair of projection.connectedPairs) {
    const from = layout.left[pair.fromIndex];
    const to = layout.right[pair.toIndex];
    const hidden = layout.hidden[pair.toIndex];
    if (!from || !to) continue;

    drawNetworkConnection(context, width, from, hidden ?? to, to, wireColorToHex(from.color));
  }

  if (dragState.fromIndex !== null) {
    const from = layout.left[dragState.fromIndex];
    if (from) {
      const hiddenIndex = projection.rightColors.findIndex((color) => color === from.color);
      const hidden = layout.hidden[hiddenIndex];
      if (hidden) {
        drawWirePath(context, width, from.x, from.y, hidden.x, hidden.y, wireColorToHex(from.color));
        drawWirePath(context, width, hidden.x, hidden.y, dragState.pointerX, dragState.pointerY, wireColorToHex(from.color));
      }
    }
  }

  const activeNeuronIndexes = new Set<number>();
  for (const pair of projection.connectedPairs) {
    activeNeuronIndexes.add(pair.toIndex);
  }

  if (dragState.fromIndex !== null) {
    const activeSocket = layout.left[dragState.fromIndex];
    if (activeSocket) {
      const activeIndex = projection.rightColors.findIndex((color) => color === activeSocket.color);
      if (activeIndex >= 0) {
        activeNeuronIndexes.add(activeIndex);
      }
    }
  }

  // Keep the active path colorful while the rest of the network stays dimmed out.
  for (const [index, socket] of layout.left.entries()) {
    const isActive = projection.connectedPairs.some((pair) => pair.fromIndex === index) || dragState.fromIndex === index;
    drawNeuron(context, layout.radius, socket.x, socket.y, isActive ? wireColorToHex(socket.color) : "#475569");
  }

  for (const [index, socket] of layout.hidden.entries()) {
    drawNeuron(context, layout.radius * 0.92, socket.x, socket.y, activeNeuronIndexes.has(index) ? wireColorToHex(socket.color) : "#475569");
  }

  for (const [index, socket] of layout.right.entries()) {
    drawNeuron(context, layout.radius, socket.x, socket.y, activeNeuronIndexes.has(index) ? wireColorToHex(socket.color) : "#475569");
  }

  context.fillStyle = "#cbd5e1";
  context.font = `${Math.round(width * 0.038)}px Arial`;
  context.fillText("Route the active input neuron to the matching output", width / 2, height * 0.88);
}

function drawNetworkConnection(
  context: CanvasRenderingContext2D,
  width: number,
  from: WireSocket,
  hidden: HiddenNeuron | WireSocket,
  to: WireSocket,
  color: string,
) {
  drawWirePath(context, width, from.x, from.y, hidden.x, hidden.y, color);
  drawWirePath(context, width, hidden.x, hidden.y, to.x, to.y, color);
}

function drawWirePath(
  context: CanvasRenderingContext2D,
  width: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string,
) {
  context.strokeStyle = color;
  context.lineWidth = Math.max(10, width * 0.014);
  context.beginPath();
  context.moveTo(fromX, fromY);
  context.bezierCurveTo((fromX + toX) * 0.5, fromY, (fromX + toX) * 0.5, toY, toX, toY);
  context.stroke();
}

function drawNeuron(
  context: CanvasRenderingContext2D,
  radius: number,
  x: number,
  y: number,
  fillStyle: string,
) {
  context.fillStyle = fillStyle;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();

  context.strokeStyle = "#f8fafc";
  context.lineWidth = Math.max(4, radius * 0.18);
  context.stroke();
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
