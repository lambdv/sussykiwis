/**
 * Message models for client-server networking.
 *
 * ClientRequest: Requests and actions sent from the client to the server.
 * ServerResponse: Responses and messages sent from the server to the client.
 * Position: Represents a 2D position in the game world.
 */

pub mod model {
    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use uuid::Uuid;

    /// Represents different request types a client may send.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub enum ClientRequest {
        /// Join request (e.g., join a lobby or server)
        Join,
        Input(InputMessage),
        SyncPosition { seq: u32, x: f32, z: f32 },
        ClientLog(ClientLogEntry),
    }

    /// Enum for server responses to the client.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub enum ServerResponse {
        Welcome(WelcomeMessage),
        WorldSnapshot(WorldSnapshot), // sync
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct InputMessage {
        pub seq: u32,
        pub move_x: f32,
        pub move_y: f32,
    }

    /// Carries client-side diagnostics without affecting gameplay state.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct ClientLogEntry {
        pub scope: String,
        pub event: String,
        pub client_time: String,
        pub details: Option<Value>,
    }

    /// Represents one game-loop event routed to websocket sessions.
    #[derive(Debug, Clone)]
    pub enum ServerEvent {
        Broadcast(ServerResponse),
        Direct { to: Uuid, message: ServerResponse },
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct WelcomeMessage {
        pub id: Uuid,
        pub name: String,
        pub tick_rate: u32,
        pub move_speed: f32,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct WorldSnapshot {
        pub server_time: u64,
        pub players: Vec<SnapshotPlayer>,
    }
    /// Represents one player entry in the world snapshot payload.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct SnapshotPlayer {
        pub id: Uuid,
        pub name: String,
        pub color: String,
        pub x: f32,
        pub z: f32,
        pub last_processed_seq: u32,
    }
}

// pub mod request_handlers {
//     use crate::lobby::state::{AppState, Player};
//     use tracing::info;

//     use super::model::{ClientRequest, ServerResponse, WelcomeMessage};

//     use uuid::Uuid;

//     /// handles the request type
//     pub async fn handle_client_request(
//         req: ClientRequest,
//         state: AppState,
//     ) -> Result<ServerResponse, ()> {
//         match req {
//             ClientRequest::Join => handle_join_request(state).await,
//             ClientRequest::Input(_) => todo!(),
//         }
//     }

//     ///handles join requests
//     pub async fn handle_join_request(state: AppState) -> Result<ServerResponse, ()> {
//         // make player
//         let uuid = Uuid::new_v4();

//         let player = Player {
//             id: uuid,
//             name: "Player 1".to_string(),
//             x: 0.0,
//             y: 0.0,
//         };

//         // aquire lock for lobby
//         let mut lobby = state.lobbies.get(&0).unwrap().lock().await;

//         lobby.add_player(player);
//         info!("player joined lobby");
//         Ok(ServerResponse::Welcome(WelcomeMessage {
//             id: uuid,
//             name: "Player 1".to_string(),
//         }))
//     }
// }
