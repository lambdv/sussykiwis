pub mod model {
    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use uuid::Uuid;

    /// Represents different request types a client may send.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum ClientRequest {
        Join {
            name: Option<String>,
            #[serde(default)]
            spectator: bool,
        },
        Input {
            seq: u32,
            #[serde(rename = "moveX")]
            move_x: f32,
            #[serde(rename = "moveY")]
            move_y: f32,
        },
        Kill {
            #[serde(rename = "targetId")]
            target_id: Uuid,
        },
        ReportBody {
            #[serde(rename = "bodyId")]
            body_id: Uuid,
        },
        Vote {
            target: String,
        },
        MeetingChat {
            message: String,
        },
        Sabotage {
            kind: SabotageKind,
        },
        StartPuzzle {
            #[serde(rename = "stationId")]
            station_id: Uuid,
        },
        CancelPuzzle,
        PuzzleTap,
        PuzzleConnect {
            #[serde(rename = "fromIndex")]
            from_index: usize,
            #[serde(rename = "toIndex")]
            to_index: usize,
        },
        ClientLog {
            scope: String,
            event: String,
            #[serde(rename = "clientTime")]
            client_time: String,
            details: Option<Value>,
        },
    }

    /// Enum for server responses to the client.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum ServerResponse {
        Welcome {
            #[serde(rename = "playerId")]
            player_id: Uuid,
            name: String,
            #[serde(rename = "tickRate")]
            tick_rate: u32,
            #[serde(rename = "moveSpeed")]
            move_speed: f32,
            #[serde(rename = "observer")]
            observer: bool,
        },
        GameStarted {
            role: PlayerRole,
        },
        WorldSnapshot {
            snapshot: WorldSnapshot,
        },
        MeetingStarted {
            #[serde(rename = "reportedBodyId")]
            reported_body_id: Uuid,
        },
        VoteUpdate {
            #[serde(rename = "votesCast")]
            votes_cast: usize,
            #[serde(rename = "totalVoters")]
            total_voters: usize,
        },
        MeetingChat {
            #[serde(rename = "playerId")]
            player_id: Uuid,
            name: String,
            message: String,
            #[serde(rename = "serverTime")]
            server_time: u64,
        },
        EjectionResult {
            #[serde(rename = "playerId")]
            player_id: Option<Uuid>,
            #[serde(rename = "wasImposter")]
            was_imposter: Option<bool>,
        },
        Win {
            winner: Faction,
            reason: String,
        },
    }

    /// Represents one game-loop event routed to websocket sessions.
    #[derive(Debug, Clone)]
    pub enum ServerEvent {
        Broadcast(ServerResponse),
        Direct { to: Uuid, message: ServerResponse },
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WinMessage {
        pub winner: Faction,
        pub reason: String,
    }

    #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub enum GamePhase {
        Lobby,
        Playing,
        Meeting,
        Ejection,
    }

    #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub enum GameSubState {
        Lobby,
        InGame,
    }

    #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub enum PlayerRole {
        Crewmate,
        Imposter,
        Sheriff,
    }

    #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub enum PlayerState {
        Alive,
        Dead,
        Ghost,
        Ejected,
    }

    #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub enum Faction {
        Crew,
        Imposters,
    }

    #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub enum SabotageKind {
        LightsOff,
        GrayPlayers,
    }

    #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub enum PuzzleKind {
        Timer,
        Wires,
    }

    #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    pub enum WireColor {
        Red,
        Blue,
        Yellow,
        Green,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WireConnection {
        pub from_index: usize,
        pub to_index: usize,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    pub enum PuzzleProjectionState {
        Timer {
            #[serde(rename = "dialAngle")]
            dial_angle: f32,
            #[serde(rename = "targetStart")]
            target_start: f32,
            #[serde(rename = "targetSize")]
            target_size: f32,
        },
        Wires {
            #[serde(rename = "leftColors")]
            left_colors: Vec<WireColor>,
            #[serde(rename = "rightColors")]
            right_colors: Vec<WireColor>,
            #[serde(rename = "connectedPairs")]
            connected_pairs: Vec<WireConnection>,
        },
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PuzzleStationSnapshot {
        pub id: Uuid,
        pub kind: PuzzleKind,
        pub x: f32,
        pub z: f32,
        pub occupied_by: Option<Uuid>,
        pub completed_by: Vec<Uuid>,
        pub projection: Option<PuzzleProjectionState>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WorldSnapshot {
        pub tick: u64,
        pub server_time: u64,
        pub phase: GamePhase,
        pub sub_state: GameSubState,
        pub joined_players: usize,
        pub expected_players: usize,
        pub map_half_extent: f32,
        pub lobby_countdown_ends_at: Option<u64>,
        pub players: Vec<SnapshotPlayer>,
        pub dead_bodies: Vec<SnapshotDeadBody>,
        pub puzzle_stations: Vec<PuzzleStationSnapshot>,
        pub active_sabotages: Vec<ActiveSabotage>,
        pub meeting: Option<MeetingSnapshot>,
        pub win: Option<WinMessage>,
    }

    /// Represents one player entry in the world snapshot payload.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SnapshotPlayer {
        pub id: Uuid,
        pub name: String,
        pub color: String,
        pub role: PlayerRole,
        pub x: f32,
        pub z: f32,
        pub facing_yaw: f32,
        pub state: PlayerState,
        pub kill_cooldown_ends_at: u64,
        pub last_processed_seq: u32,
        pub completed_puzzle_count: usize,
        pub total_puzzle_count: usize,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SnapshotDeadBody {
        pub id: Uuid,
        pub player_id: Uuid,
        pub x: f32,
        pub z: f32,
        pub reported: bool,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ActiveSabotage {
        pub kind: SabotageKind,
        pub started_at_tick: u64,
        pub ends_at_tick: u64,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MeetingSnapshot {
        pub reported_body_id: Uuid,
        pub started_at_tick: u64,
        pub ends_at_tick: u64,
        pub votes_cast: usize,
        pub total_voters: usize,
        pub vote_counts: Vec<MeetingVoteCount>,
        pub chat: Vec<MeetingChatMessage>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MeetingVoteCount {
        pub target: Option<Uuid>,
        pub votes: usize,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MeetingChatMessage {
        pub player_id: Uuid,
        pub name: String,
        pub message: String,
        pub server_time: u64,
    }
}
