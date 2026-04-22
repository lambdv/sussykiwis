/// client messages
export type ClientMessage = JoinMessage;

export type JoinMessage = {
  type: "join";
};

/// server messages
export type ServerMessage = JoinResponseMessage | MatchMessage;

export type JoinResponseMessage = {
  type: "join_response";
  name: string;
};

export type MatchMessage = {
  type: "match";
  playerCount: number;
};