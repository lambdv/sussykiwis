import type { ClientMessage, ServerMessage } from "./message";

type MessageHandler = (msg: ServerMessage) => void;

export class NetworkClient {
  connection: WebSocket | null = null;
  readonly url = "ws://localhost:3000/ws";
  private messageHandlers: MessageHandler[] = [];

  async connect(): Promise<void> {
    if (this.connection?.OPEN) return;

    return await new Promise<void>((res, rej) => {
      this.connection = new WebSocket(this.url);

      this.connection.onopen = () => {
        res();
      };

      this.connection.onerror = () => {
        rej(new Error("Failed to connect socket"));
      };

      this.connection.onmessage = (event) => {
        const msg = JSON.parse(event.data) as ServerMessage;
        this.messageHandlers.forEach((handler) => handler(msg));
      };

      this.connection.onclose = () => {
        this.connection = null;
      };
    });
  }

  sendMessage(message: ClientMessage) {
    if (!this.isConnected())
      console.error("WebSocket is not open. Ready state:");
    this.connection?.send(JSON.stringify(message));
  }

  isConnected(): boolean {
    return !!this.connection && this.connection.readyState === WebSocket.OPEN;
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.push(handler);
  }
}