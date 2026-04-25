// Client->server messages currently supported by the Rust lobby.
export type ClientMessage = {
  type: "join";
};

// Server->client messages handled today (including serde externally tagged enum).
export type ServerMessage =
  | {
      Welcome: {
        id: string;
        name: string;
      };
    }
  | {
      type: string;
      [key: string]: unknown;
    };
