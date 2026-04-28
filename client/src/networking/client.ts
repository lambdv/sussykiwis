import type { ClientMessage, ServerMessage } from "./message";

type MessageHandler = (msg: ServerMessage) => void;

export class NetworkClient {
  private connection: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private messageHandlers = new Set<MessageHandler>();

  private getUrl(): string {
    // Connect back to the Rust server using the current page host.
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const host = window.location.hostname || "localhost";
    return `${protocol}://${host}:8080/ws`;
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
