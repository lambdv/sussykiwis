/// module for the game server
/// it contains the axum app/server and websocket handling
/// uses the lobby module to manage game state and player connections (packet types, game state, game world simulation ect)
use axum::{
    Json,
    extract::State,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    http::{
        StatusCode, Uri,
        header::{self, HeaderMap, HeaderName},
    },
    response::{Html, IntoResponse},
    routing::{any, get},
};
use serde_json::json;
use std::collections::HashMap;
use tokio::sync::{broadcast, mpsc};
use tower_http::trace::TraceLayer;

use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::{AppState, GameCommand, ServerEvent};

// server configuration
pub struct Config {
    pub port: u16,
    pub tick_rate: u32,
}

// the actual app server
pub async fn start_server(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let addr = format!("127.0.0.1:{}", config.port);

    let listener = tokio::net::TcpListener::bind(addr.clone()).await?;
    info!(%addr, "server listening");

    let app = get_app_router();
    axum::serve(listener, app).await?;
    Ok(())
}

/// all the state of the axum app / game server
#[derive(Clone)]
pub struct ServerContext {
    // sender / transport of client packets to the game loop
    pub command_tx: mpsc::Sender<GameCommand>,
    pub event_tx: broadcast::Sender<ServerEvent>,
}
impl ServerContext {
    pub fn new(
        command_tx: mpsc::Sender<GameCommand>,
        event_tx: broadcast::Sender<ServerEvent>,
    ) -> Self {
        Self {
            command_tx,
            event_tx,
        }
    }
}

// the server app router
pub fn get_app_router() -> axum::Router {
    let cors = tower_http::cors::CorsLayer::new()
        .allow_methods([http::Method::GET, http::Method::POST])
        .allow_origin(tower_http::cors::Any);
    let (game_tx, _game_rx) = mpsc::channel::<GameCommand>(100);
    let (event_tx, _event_rx) = broadcast::channel::<ServerEvent>(100);
    let state = ServerContext::new(game_tx, event_tx);

    axum::Router::new()
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .route("/ws", any(ws_handler))
        .route(
            "/health",
            get(|| async {
                (
                    StatusCode::OK,
                    Json(json!({
                        "message": "healty"
                    })),
                )
            }),
        )
        .with_state(state)
}

/// route handler for websocket connections
/// it upgrades the http request to a ws connection and calls handle socket to:
/// 1. itilize the connection
/// 2. spawn a reciver and sender task for socket packets
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(context): State<ServerContext>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, context))
}

async fn handle_socket(mut socket: WebSocket, context: ServerContext) {
    info!("client connected");

    let (mut sender, mut receiver) = socket.split();

    if read_join_message(&mut receiver).await.is_err() {
        let _ = sender.close().await;
        return;
    }
}
