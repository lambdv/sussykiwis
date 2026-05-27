use axum::{
    Json,
    extract::State,
    extract::ws::WebSocketUpgrade,
    http::StatusCode,
    response::IntoResponse,
    routing::{any, get},
};
use serde_json::json;
use tokio::sync::{broadcast, mpsc};
use tower_http::trace::TraceLayer;

use tracing::info;
use tracing_subscriber::EnvFilter;

use crate::lobby::networking::session::handle_socket;
use crate::lobby::simulation::start_simulation;
use crate::{GameCommand, ServerEvent};

pub struct Config {
    pub host: String,
    pub port: u16,
    pub tick_rate: u32,
}

/// Axum app state shared across all WebSocket sessions.
#[derive(Clone)]
pub struct ServerContext {
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

pub async fn start_server(config: Config) -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let addr = format!("{}:{}", config.host, config.port);

    let listener = tokio::net::TcpListener::bind(addr.clone()).await?;
    info!(%addr, "server listening");

    let (game_tx, game_rx) = mpsc::channel::<GameCommand>(100);
    let (event_tx, _event_rx) = broadcast::channel::<ServerEvent>(100);

    let state = ServerContext::new(game_tx, event_tx.clone());

    tokio::spawn(start_simulation(game_rx, event_tx.clone()));

    let app = get_app_router(state);

    axum::serve(listener, app).await?;
    Ok(())
}

pub fn get_app_router(state: ServerContext) -> axum::Router {
    let cors = tower_http::cors::CorsLayer::new()
        .allow_methods([http::Method::GET, http::Method::POST])
        .allow_origin(tower_http::cors::Any);

    axum::Router::new()
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .route("/ws", any(ws_handler))
        .route("/health", get(|| async { (StatusCode::OK, "ok") }))
        .route(
            "/ping",
            get(|| async {
                (
                    StatusCode::OK,
                    Json(json!({
                        "message": "pong"
                    })),
                )
            }),
        )
        .with_state(state)
}

pub fn get_app() -> axum::Router {
    let (game_tx, _game_rx) = mpsc::channel::<GameCommand>(1);
    let (event_tx, _event_rx) = broadcast::channel::<ServerEvent>(1);
    get_app_router(ServerContext::new(game_tx, event_tx))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(context): State<ServerContext>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, context))
}
