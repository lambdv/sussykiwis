import type { ClientMessage, ServerMessage } from "./message";

type MessageHandler = (msg: ServerMessage) => void;

export class NetworkClient {
  private connection: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private messageHandlers = new Set<MessageHandler>();

  private getUrl(): string {
    // Read HTTP server base URI from env and default locally if missing.
    // Vite only exposes `VITE_*` variables to client bundles.
    const env = (import.meta as { env?: Record<string, string> }).env;
    // Prefer the Vite-exposed name, but keep a fallback for older local `.env` files.
    const serverUri =
      env?.VITE_SERVER_URI ?? env?.SERVER_URI ?? "http://localhost:10000/";

    // Convert HTTP(S) URI to WS(S) endpoint and point to `/ws`.
    const base = new URL(serverUri);
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
        res();
      };

      this.connection.onerror = () => {
        this.connectPromise = null;
        rej(new Error("Failed to connect socket"));
      };

      this.connection.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;
          this.messageHandlers.forEach((handler) => handler(msg));
        } catch {
          console.error("Failed to parse websocket message", event.data);
        }
      };

      this.connection.onclose = () => {
        this.connection = null;
        this.connectPromise = null;
      };
    });

    return this.connectPromise;
  }

  sendMessage(message: ClientMessage): boolean {
    // Prevent sending if socket is not yet connected.
    if (!this.isConnected()) {
      console.error("WebSocket is not open; message dropped", message);
      return false;
    }

    this.connection?.send(JSON.stringify(message));
    return true;
  }

  isConnected(): boolean {
    return !!this.connection && this.connection.readyState === WebSocket.OPEN;
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
    this.connection?.close();
    this.connection = null;
    this.connectPromise = null;
  }
}
