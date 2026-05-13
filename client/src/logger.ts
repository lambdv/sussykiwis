const LOG_SCOPES = {
  CLIENT: "CLIENT",
  NETWORK: "NETWORK",
  GAME: "GAME",
  STATE: "STATE",
} as const;

type LogScope = (typeof LOG_SCOPES)[keyof typeof LOG_SCOPES];

const isDev = (import.meta as { env?: Record<string, string> }).env?.DEV === "true";

function formatTime(): string {
  const now = new Date();
  return now.toISOString().split("T")[1].slice(0, -1);
}

function formatMessage(scope: LogScope, event: string, details?: Record<string, unknown>): string {
  const base = `[${formatTime()}] [${scope}] ${event}`;
  if (details && Object.keys(details).length > 0) {
    const detailStr = Object.entries(details)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    return `${base} ${detailStr}`;
  }
  return base;
}

export function info(scope: LogScope, event: string, details?: Record<string, unknown>): void {
  if (isDev) {
    console.info(formatMessage(scope, event, details));
  }
}

export function warn(scope: LogScope, event: string, details?: Record<string, unknown>): void {
  if (isDev) {
    console.warn(formatMessage(scope, event, details));
  }
}

export function error(scope: LogScope, event: string, details?: Record<string, unknown>): void {
  console.error(formatMessage(scope, event, details));
}

export const Logger = {
  CLIENT: LOG_SCOPES.CLIENT,
  NETWORK: LOG_SCOPES.NETWORK,
  GAME: LOG_SCOPES.GAME,
  STATE: LOG_SCOPES.STATE,
  info,
  warn,
  error,
};

export { LOG_SCOPES };