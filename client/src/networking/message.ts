/// client
export type ClientMessage = JoinMessage;

export type JoinMessage = {
  type: "join";
};

///server
export type ServerMessage = JoinResponseMessage;

export type JoinResponseMessage = {
  type: "join_response";
  name: string;
};
