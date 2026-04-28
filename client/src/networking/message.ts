// Client->server messages currently supported by the Rust lobby.
export type ClientMessage = "Join" | { Input: InputMessage };

export type InputMessage = {
  seq: number;
  move_x: number;
  move_y: number;
};

export type WelcomeMessage = {
  id: string;
  name: string;
};

export type SnapshotPlayer = {
  id: string;
  name: string;
  color: string;
  x: number;
  z: number;
  last_processed_seq: number;
};

export type WorldSnapshot = {
  server_time: number;
  players: SnapshotPlayer[];
};

// Server->client messages handled today (including serde externally tagged enum).
export type ServerMessage =
  | {
      Welcome: WelcomeMessage;
    }
  | {
      WorldSnapshot: WorldSnapshot;
    }
  | {
      type: string;
      [key: string]: unknown;
    };
