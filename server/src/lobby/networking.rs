pub mod model {
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;
    use uuid::Uuid;

    /**
     * Message models for client-server networking.
     *
     * ClientRequest: Requests and actions sent from the client to the server.
     * ServerResponse: Responses and messages sent from the server to the client.
     * Position: Represents a 2D position in the game world.
     */

    /// Represents different request types a client may send.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub enum ClientRequest {
        /// Join request (e.g., join a lobby or server)
        Join,
        //UpdatePosition(Position),
    }

    // Uncomment and implement if server wants to handle symmetric responses
    // #[derive(Debug, Clone, Serialize, Deserialize)]
    // pub enum Response {
    //     Join,
    //     UpdatePosition(Position),
    // }

    /// Enum for server responses to the client.
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub enum ServerResponse {
        Welcome(WelcomeMessage),
    }

    /// Represents a position in 2D space (x, y).
    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct Position {
        pub x: f32,
        pub y: f32,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct WelcomeMessage {
        pub id: UUID,
        pub name: String,
    }

    // End of message models
}

pub mod request_handlers {
    use crate::lobby::state::{AppState, GameState, Lobby, Player};

    use super::model::{ClientRequest, ServerResponse};

    use uuid::Uuid;

    /// handles the request type
    pub async fn handle_client_request(
        req: ClientRequest,
        state: AppState,
    ) -> Result<ServerResponse, ()> {
        match req {
            ClientRequest::Join => {
                handle_join_request(state).await
            }
            // ClientRequest::UpdatePosition(pos) => Err(()),
            _ => Err(()),
        }
    }

    ///handles join requests
    pub async fn handle_join_request(state: AppState) -> Result<ServerResponse, ()> {
        // make player
        let uuid = Uuid::default();
        let player = Player {
            id: uuid,
            name: "Player 1".to_string(),
            x: 0.0,
            y: 0.0,
        };

        // aquire lock for lobby
        let mut lobby = state.lobbies.get(&0).unwrap().lock().await;

        lobby.add_player(player);
        Ok(ServerResponse::Welcome(model::WelcomeMessage {
            id: uuid,
            name: "Player 1".to_string(),
        }))
    }
}
