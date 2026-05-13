import type { PuzzleProjectionState } from "../../networking/message";

export function drawTimerPuzzleScene(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  projection: Extract<PuzzleProjectionState, { kind: "timer" }>,
) {
  if (!Number.isFinite(projection.dialAngle) || !Number.isFinite(projection.targetStart) || !Number.isFinite(projection.targetSize)) {
    drawPuzzleSyncMessage(context, width, height, "Syncing timer...");
    return;
  }

  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.28;

  // Paint a clean puzzle card background so the hologram and modal share the same read.
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#08111f";
  context.fillRect(0, 0, width, height);

  context.fillStyle = "#e2e8f0";
  context.font = `bold ${Math.round(width * 0.06)}px Arial`;
  context.textAlign = "center";
  context.fillText("Timer", centerX, height * 0.16);

  context.strokeStyle = "rgba(148, 163, 184, 0.35)";
  context.lineWidth = Math.max(16, width * 0.02);
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.stroke();

  // Draw the valid target window as the authoritative success arc.
  context.strokeStyle = "#34d399";
  context.lineWidth = Math.max(24, width * 0.032);
  context.beginPath();
  context.arc(centerX, centerY, radius, projection.targetStart - Math.PI / 2, projection.targetStart + projection.targetSize - Math.PI / 2);
  context.stroke();

  // Draw the moving dial from the authoritative server angle.
  context.save();
  context.translate(centerX, centerY);
  context.rotate(projection.dialAngle - Math.PI / 2);
  context.strokeStyle = "#f472b6";
  context.lineWidth = Math.max(10, width * 0.016);
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(radius * 0.92, 0);
  context.stroke();
  context.restore();

  context.fillStyle = "#f8fafc";
  context.beginPath();
  context.arc(centerX, centerY, Math.max(18, width * 0.024), 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#cbd5e1";
  context.font = `${Math.round(width * 0.038)}px Arial`;
  context.fillText("Tap when the dial reaches green", centerX, height * 0.88);
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
