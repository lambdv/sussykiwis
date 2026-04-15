import type { ClientMessage } from "./message";

/** module for communcating with the server */
export class NetworkClient {
  connection: WebSocket | null = null;
  readonly url = "ws://localhost:3000/ws";

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
}
