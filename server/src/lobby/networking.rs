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
        Sabotage {
            kind: SabotageKind,
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
        Win,
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

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct WorldSnapshot {
        pub tick: u64,
        pub server_time: u64,
        pub phase: GamePhase,
        pub players: Vec<SnapshotPlayer>,
        pub dead_bodies: Vec<SnapshotDeadBody>,
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
        pub x: f32,
        pub z: f32,
        pub state: PlayerState,
        pub last_processed_seq: u32,
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
    }
}
