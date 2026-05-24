import type { ClientMessage, ServerMessage, WelcomeMessage } from "./message";
import { Logger, LOG_SCOPES } from "../logger";

type MessageHandler = (msg: ServerMessage) => void;

type DisconnectHandler = (wasIntentional: boolean) => void;

const DEFAULT_MOVE_SPEED = 10.0;

export class NetworkClient {
  private connection: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private messageHandlers = new Set<MessageHandler>();
  private disconnectHandlers = new Set<DisconnectHandler>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Number.POSITIVE_INFINITY;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private isDisconnecting = false;
  private nextInputSeqValue = 0;
  private moveSpeed = DEFAULT_MOVE_SPEED;

  private getUrl(): string {
    // Only honor the explicit server URI in local Vite dev.
    const env = (import.meta as { env?: Record<string, unknown> }).env;
    const isDev = env?.DEV === true;
    const serverUri = isDev
      ? ((env?.VITE_SERVER_URI ?? env?.SERVER_URI) as string | undefined)
      : undefined;
    const base = serverUri
      ? new URL(serverUri)
      : new URL("/api/", window.location.origin);

    // Convert HTTP(S) URI to WS(S) endpoint and point to `/ws`.
    const wsProtocol = base.protocol === "https:" ? "wss:" : "ws:";

    // If a base path is provided (eg. `/api/`), preserve it.
    // This lets nginx serve the client at `/` and proxy the server at `/api`.
    const basePath = base.pathname.replace(/\/+$/, "");
    return `${wsProtocol}//${base.host}${basePath}/ws`;
  }

  async connect(): Promise<void> {
    // Reuse an active socket immediately to avoid duplicate connections.
    if (this.isConnected()) return;

    // Reuse an in-flight connect promise if one is already running.
    if (this.connectPromise) {
      return this.connectPromise;
    }

    // Open websocket and resolve once the connection is accepted.
    this.connectPromise = new Promise<void>((res, rej) => {
      this.connection = new WebSocket(this.getUrl());

      this.connection.onopen = () => {
        this.connectPromise = null;
        this.reconnectAttempts = 0;
        this.isDisconnecting = false;
        Logger.info(LOG_SCOPES.NETWORK, "CLIENT: connected to server");
        res();
      };

      this.connection.onerror = () => {
        this.connectPromise = null;
        this.handleDisconnect(false);
        Logger.error(LOG_SCOPES.NETWORK, "CLIENT: websocket error");
        rej(new Error("Failed to connect socket"));
      };

      this.connection.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;
          if (msg.type === "welcome") {
            // Keep session movement settings aligned with the authoritative server welcome.
            this.nextInputSeqValue = 0;
            this.moveSpeed = msg.moveSpeed;
            Logger.info(LOG_SCOPES.NETWORK, "CLIENT: received welcome", {
              playerId: msg.playerId,
              name: msg.name,
              role: msg.observer ? "observer" : "player",
            });
          }
          this.messageHandlers.forEach((handler) => handler(msg));
        } catch {
          Logger.error(LOG_SCOPES.NETWORK, "CLIENT: failed to parse message", { raw: event.data });
        }
      };

      this.connection.onclose = () => {
        this.connection = null;
        this.connectPromise = null;
        Logger.info(LOG_SCOPES.NETWORK, "CLIENT: disconnected");
        this.handleDisconnect(this.isDisconnecting);
      };
    });

    return this.connectPromise;
  }

  private handleDisconnect(wasIntentional: boolean) {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.disconnectHandlers.forEach((handler) => handler(wasIntentional));

    if (!wasIntentional && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      this.reconnectTimeout = setTimeout(() => {
        this.reconnectTimeout = null;
        this.connect();
      }, delay);
    }

    this.isDisconnecting = false;
  }

  async join(options: { name?: string; spectator?: boolean; timeoutMs?: number } = {}): Promise<WelcomeMessage> {
    // Reuse the shared socket, then wait for the server welcome packet.
    await this.connect();

    return new Promise<WelcomeMessage>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        offMessage();
        offDisconnect();

        if (timeout !== null) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      const settleWelcome = (value: WelcomeMessage) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const settleError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const offMessage = this.onMessage((message) => {
        if (message.type === "welcome") {
          settleWelcome(message);
          return;
        }

        if (message.type === "join_rejected") {
          settleError(new Error(message.reason));
          this.disconnect();
        }
      });

      const offDisconnect = this.onDisconnect(() => {
        settleError(new Error("Disconnected while waiting for welcome"));
      });

      timeout = setTimeout(() => {
        this.disconnect();
        settleError(new Error("Join timed out"));
      }, options.timeoutMs ?? 8000);

      if (!this.sendMessage({ type: "join", name: options.name, spectator: options.spectator })) {
        this.disconnect();
        settleError(new Error("Failed to send join message"));
      }
    });
  }

  sendMessage(message: ClientMessage): boolean {
    if (!this.isConnected()) {
      return false;
    }

    this.connection?.send(JSON.stringify(message));
    return true;
  }

  isConnected(): boolean {
    return !!this.connection && this.connection.readyState === WebSocket.OPEN;
  }

  nextInputSeq(): number {
    // Use one monotonic input stream for the whole websocket session across scene changes.
    this.nextInputSeqValue += 1;
    return this.nextInputSeqValue;
  }

  getMoveSpeed(): number {
    return this.moveSpeed;
  }

  onMessage(handler: MessageHandler) {
    // Register callback and return an unsubscribe helper.
    this.messageHandlers.add(handler);
    return () => {
      this.offMessage(handler);
    };
  }

  offMessage(handler: MessageHandler) {
    // Remove a previously registered callback.
    this.messageHandlers.delete(handler);
  }

  disconnect() {
    // Close the websocket cleanly when app exits or reconnect is needed.
    this.isDisconnecting = true;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.connection?.close();
    this.connection = null;
    this.connectPromise = null;
    this.reconnectAttempts = 0;
    this.nextInputSeqValue = 0;
    this.moveSpeed = DEFAULT_MOVE_SPEED;
  }

  onDisconnect(handler: DisconnectHandler) {
    this.disconnectHandlers.add(handler);
    return () => {
      this.disconnectHandlers.delete(handler);
    };
  }
}
