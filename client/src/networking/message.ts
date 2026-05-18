export type GamePhase = "lobby" | "playing" | "meeting" | "ejection" | "win";

export type GameSubState = "lobby" | "in_game";

export type PlayerRole = "crewmate" | "imposter" | "sheriff";

export type PlayerState = "alive" | "dead" | "ghost" | "ejected";

export type Faction = "crew" | "imposters";

export type SabotageKind = "lights_off" | "gray_players";

export type PuzzleKind = "timer" | "wires";

export type WireColor = "red" | "blue" | "yellow" | "green";

export type WireConnection = {
  fromIndex: number;
  toIndex: number;
};

export type PuzzleProjectionState =
  | { kind: "timer"; dialAngle: number; targetStart: number; targetSize: number }
  | { kind: "wires"; leftColors: WireColor[]; rightColors: WireColor[]; connectedPairs: WireConnection[] };

export type PuzzleStationSnapshot = {
  id: string;
  kind: PuzzleKind;
  x: number;
  z: number;
  occupiedBy: string | null;
  completedBy: string[];
  projection: PuzzleProjectionState | null;
};

export type ClientMessage =
  | { type: "join"; name?: string; spectator?: boolean }
  | { type: "input"; seq: number; moveX: number; moveY: number }
  | { type: "kill"; targetId: string }
  | { type: "report_body"; bodyId: string }
  | { type: "vote"; target: string }
  | { type: "meeting_chat"; message: string }
  | { type: "sabotage"; kind: SabotageKind }
  | { type: "start_puzzle"; stationId: string }
  | { type: "cancel_puzzle" }
  | { type: "puzzle_tap" }
  | { type: "puzzle_connect"; fromIndex: number; toIndex: number }
  | {
      type: "client_log";
      scope: string;
      event: string;
      clientTime: string;
      details?: unknown;
    };

export type WelcomeMessage = {
  playerId: string;
  name: string;
  tickRate: number;
  moveSpeed: number;
  observer: boolean;
};

export type GameStartedMessage = {
  role: PlayerRole;
};

export type SnapshotPlayer = {
  id: string;
  name: string;
  color: string;
  role: PlayerRole;
  x: number;
  z: number;
  facingYaw: number;
  state: PlayerState;
  killCooldownEndsAt: number;
  lastProcessedSeq: number;
  completedPuzzleCount: number;
  totalPuzzleCount: number;
};

export type SnapshotDeadBody = {
  id: string;
  playerId: string;
  x: number;
  z: number;
  reported: boolean;
};

export type ActiveSabotage = {
  kind: SabotageKind;
  startedAtTick: number;
  endsAtTick: number;
};

export type MeetingSnapshot = {
  reportedBodyId: string;
  startedAtTick: number;
  endsAtTick: number;
  votesCast: number;
  totalVoters: number;
  voteCounts: { target: string | null; votes: number }[];
  chat: { playerId: string; name: string; message: string; serverTime: number }[];
};

export type WinState = {
  winner: Faction;
  reason: string;
};

export type WorldSnapshot = {
  tick: number;
  serverTime: number;
  phase: GamePhase;
  subState: GameSubState;
  joinedPlayers: number;
  expectedPlayers: number;
  mapHalfExtent: number;
  lobbyCountdownEndsAt: number | null;
  players: SnapshotPlayer[];
  deadBodies: SnapshotDeadBody[];
  puzzleStations: PuzzleStationSnapshot[];
  activeSabotages: ActiveSabotage[];
  meeting: MeetingSnapshot | null;
  win: WinState | null;
};

export type ServerMessage =
  | { type: "welcome"; playerId: string; name: string; tickRate: number; moveSpeed: number; observer: boolean }
  | { type: "game_started"; role: PlayerRole }
  | { type: "world_snapshot"; snapshot: WorldSnapshot }
  | { type: "meeting_started"; reportedBodyId: string }
  | { type: "vote_update"; votesCast: number; totalVoters: number }
  | { type: "meeting_chat"; playerId: string; name: string; message: string; serverTime: number }
  | { type: "ejection_result"; playerId: string | null; wasImposter: boolean | null }
  | { type: "win"; winner: Faction; reason: string };
