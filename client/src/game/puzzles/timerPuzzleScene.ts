import type { PuzzleProjectionState } from "../../networking/message";

const spinnerImage = new Image();
spinnerImage.src = "/assets/2d/spinner.png";

const TIMER_ROTATION_PER_TICK = 0.28;
const TICK_RATE = 20;
const ROTATION_PER_MS = (TIMER_ROTATION_PER_TICK * TICK_RATE) / 1000;

let lastServerStartedAt = -1;
let localStartTime = 0;

function getTimerDialAngle(): number {
  if (localStartTime === 0) return 0;
  return ((Date.now() - localStartTime) * ROTATION_PER_MS) % (Math.PI * 2);
}

function angleInArc(angle: number, arcStart: number, arcSize: number): boolean {
  const normalizedAngle = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const normalizedStart = ((arcStart % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  let delta = normalizedAngle - normalizedStart;
  if (delta < 0) delta += Math.PI * 2;
  return delta <= arcSize;
}

export function isTimerTapValid(
  projection: Extract<PuzzleProjectionState, { kind: "timer" }>,
): boolean {
  if (projection.startedAt !== lastServerStartedAt) {
    lastServerStartedAt = projection.startedAt;
    localStartTime = Date.now();
  }
  const angle = getTimerDialAngle();
  return angleInArc(angle, projection.targetStart, projection.targetSize);
}

export function drawTimerPuzzleScene(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  projection: Extract<PuzzleProjectionState, { kind: "timer" }>,
) {
  if (!Number.isFinite(projection.startedAt) || !Number.isFinite(projection.targetStart) || !Number.isFinite(projection.targetSize)) {
    drawPuzzleSyncMessage(context, width, height, "Syncing timer...");
    return;
  }

  if (projection.startedAt !== lastServerStartedAt) {
    lastServerStartedAt = projection.startedAt;
    localStartTime = Date.now();
  }

  const dialAngle = getTimerDialAngle();
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) * 0.28;

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

  context.strokeStyle = "#34d399";
  context.lineWidth = Math.max(24, width * 0.032);
  context.beginPath();
  context.arc(centerX, centerY, radius, projection.targetStart - Math.PI / 2, projection.targetStart + projection.targetSize - Math.PI / 2);
  context.stroke();

  // Draw the full spinner art so the puzzle reads like the in-world station.
  context.save();
  context.translate(centerX, centerY);
  context.rotate(dialAngle - Math.PI / 2);
  const spinnerSize = radius * 1.85;
  if (spinnerImage.complete && spinnerImage.naturalWidth > 0) {
    context.drawImage(spinnerImage, -spinnerSize / 2, -spinnerSize / 2, spinnerSize, spinnerSize);
  } else {
    context.fillStyle = "#f472b6";
    context.beginPath();
    context.arc(0, 0, radius * 0.72, 0, Math.PI * 2);
    context.fill();
  }

  // Keep the break visible even if the source art is subtle.
  context.fillStyle = "#fb7185";
  context.beginPath();
  context.moveTo(radius * 0.12, -radius * 0.78);
  context.lineTo(radius * 0.36, -radius * 0.55);
  context.lineTo(radius * 0.18, -radius * 0.42);
  context.lineTo(-radius * 0.02, -radius * 0.68);
  context.closePath();
  context.fill();
  context.restore();

  context.fillStyle = "#f8fafc";
  context.beginPath();
  context.arc(centerX, centerY, Math.max(18, width * 0.024), 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "#cbd5e1";
  context.font = `${Math.round(width * 0.038)}px Arial`;
  context.fillText("Tap when the break reaches green", centerX, height * 0.88);
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
