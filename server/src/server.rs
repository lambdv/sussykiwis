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
use futures_util::{SinkExt, stream::StreamExt};
use serde_json::json;
use tokio::sync::{broadcast, mpsc};
use tower_http::trace::TraceLayer;

use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use crate::lobby::simulation::start_simulation;
use crate::lobby::networking::model::{ClientRequest, ServerResponse};
use crate::{GameCommand, ServerEvent};

// server configuration
pub struct Config {
    pub host: String,
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

    let addr = format!("{}:{}", config.host, config.port);

    let listener = tokio::net::TcpListener::bind(addr.clone()).await?;
    info!(%addr, "server listening");

    // tokio sync channels for communicating with the game loop task
    let (game_tx, game_rx) = mpsc::channel::<GameCommand>(100);
    let (event_tx, _event_rx) = broadcast::channel::<ServerEvent>(100);

    let state = ServerContext::new(game_tx, event_tx.clone());
    // start the game loop in a separate task, it will receive client commands and produce server events for the ws sessions

    tokio::spawn(start_simulation(game_rx, event_tx.clone()));

    let app = get_app_router(state);

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
pub fn get_app_router(state: ServerContext) -> axum::Router {
    // cross origin resource sharing policy for ws and http endpoints
    let cors = tower_http::cors::CorsLayer::new()
        .allow_methods([http::Method::GET, http::Method::POST])
        .allow_origin(tower_http::cors::Any);

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

    let joined = read_join_message(&mut receiver).await;

    if joined.is_err() {
        warn!("SERVER WS REJECTED: expected initial join message");
        let _ = sender.close().await;
        return;
    }

    // Allocate identity and subscribe to server event fanout.
    let id = Uuid::new_v4();
    let short_id = id.to_string().chars().take(6).collect::<String>();
    let name = format!("Player-{short_id}");
    let mut event_rx = context.event_tx.subscribe();

    info!(client_id = %id, client_name = %name, "SERVER WS SESSION STARTED");

    // Register this player in the authoritative game loop.
    if context
        .command_tx
        .send(GameCommand::PlayerJoined {
            id,
            name: name.clone(),
        })
        .await
        .is_err()
    {
        warn!(client_id = %id, "SERVER GAME LOOP UNAVAILABLE DURING JOIN");
        let _ = sender.close().await;
        return;
    }

    // Forward server events from the game loop to this websocket.
    let writer_task = tokio::spawn(async move {
        loop {
            let event = match event_rx.recv().await {
                Ok(event) => event,
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(client_id = %id, skipped, "SERVER WS EVENT LAGGED");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => break,
            };

            let message = match event {
                ServerEvent::Broadcast(message) => message,
                ServerEvent::Direct { to, message } => {
                    if to != id {
                        continue;
                    }
                    message
                }
            };

            if send_message(&mut sender, &message).await.is_err() {
                warn!(client_id = %id, "SERVER WS WRITE FAILED");
                break;
            }
        }
    });

    // Parse incoming websocket text messages and enqueue game commands.
    while let Some(result) = receiver.next().await {
        let message = match result {
            Ok(message) => message,
            Err(_) => {
                warn!(client_id = %id, "SERVER WS READ FAILED");
                break;
            }
        };

        match message {
            Message::Text(text) => {
                let parsed = serde_json::from_str::<ClientRequest>(&text);
                let request = match parsed {
                    Ok(request) => request,
                    Err(error) => {
                        warn!(client_id = %id, %error, raw = %text, "SERVER WS PARSE FAILED");
                        continue;
                    }
                };

                match request {
                    ClientRequest::Input(input) => {
                        if context
                            .command_tx
                            .send(GameCommand::PlayerInput {
                                id,
                                seq: input.seq,
                                move_x: input.move_x,
                                move_z: input.move_y,
                            })
                            .await
                            .is_err()
                        {
                            warn!(client_id = %id, "SERVER GAME LOOP UNAVAILABLE DURING INPUT");
                            break;
                        }
                    }
                    ClientRequest::SyncPosition { seq, x, z } => {
                        if context
                            .command_tx
                            .send(GameCommand::SyncPosition { id, seq, x, z })
                            .await
                            .is_err()
                        {
                            warn!(client_id = %id, "SERVER GAME LOOP UNAVAILABLE DURING SYNC_POSITION");
                            break;
                        }
                    }
                    ClientRequest::ClientLog(entry) => {
                        let details = entry.details.unwrap_or(serde_json::Value::Null);
                        info!(
                            client_id = %id,
                            scope = %entry.scope,
                            event = %entry.event,
                            client_time = %entry.client_time,
                            details = %details,
                            "REMOTE CLIENT LOG"
                        );
                    }
                    ClientRequest::Join => {
                        warn!(client_id = %id, "SERVER WS RECEIVED UNEXPECTED EXTRA JOIN");
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // Notify game loop about disconnect and stop forwarding task.
    let _ = context.command_tx.send(GameCommand::PlayerLeft { id }).await;
    info!(client_id = %id, "SERVER WS SESSION ENDED");
    writer_task.abort();
}

/// Reads and validates the first client packet as a join request.
async fn read_join_message(
    receiver: &mut futures_util::stream::SplitStream<WebSocket>,
) -> Result<(), ()> {
    loop {
        let Some(result) = receiver.next().await else {
            return Err(());
        };

        let message = result.map_err(|_| ())?;
        let Message::Text(text) = message else {
            return Err(());
        };

        let request = serde_json::from_str::<ClientRequest>(&text).map_err(|_| ())?;
        match request {
            ClientRequest::Join => return Ok(()),
            ClientRequest::ClientLog(entry) => {
                // Accept pre-join debug traffic so visibility logs cannot break the handshake.
                let details = entry.details.unwrap_or(serde_json::Value::Null);
                info!(
                    scope = %entry.scope,
                    event = %entry.event,
                    client_time = %entry.client_time,
                    details = %details,
                    "REMOTE CLIENT LOG (PRE-JOIN)"
                );
            }
            ClientRequest::Input(_) | ClientRequest::SyncPosition { .. } => return Err(()),
        }
    }
}

/// Serializes and sends one server message to a websocket sink.
async fn send_message(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &ServerResponse,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(message).expect("server response must serialize");
    sender.send(Message::Text(payload.into())).await
}
