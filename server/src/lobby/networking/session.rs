use axum::extract::ws::{Message, WebSocket};
use futures_util::SinkExt;
use futures_util::stream::{SplitSink, SplitStream, StreamExt};
use tokio::sync::broadcast;
use tokio::time::{Duration, timeout};
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::lobby::networking::commands::{request_to_command, send_message};
use crate::lobby::networking::handshake::{JoinRequest, read_join_message};
use crate::lobby::networking::model::{ClientRequest, ServerEvent, ServerResponse};
use crate::lobby::simulation::{GameCommand, MOVE_SPEED, TICK_RATE};
use crate::server::ServerContext;

pub struct ClientSession {
    pub id: Uuid,
    pub name: String,
    pub spectator: bool,
    pub context: ServerContext,
}

impl ClientSession {
    pub fn from_join(join: JoinRequest, context: ServerContext) -> Self {
        let id = Uuid::new_v4();
        let short_id = id.to_string().chars().take(6).collect::<String>();
        let fallback_name = if join.spectator {
            format!("Observer-{short_id}")
        } else {
            format!("Player-{short_id}")
        };
        let name = join
            .name
            .filter(|v| !v.trim().is_empty())
            .unwrap_or(fallback_name);

        Self {
            id,
            name,
            spectator: join.spectator,
            context,
        }
    }

    pub async fn register(&self) -> Result<(), ()> {
        info!(
            client_id = %self.id,
            client_name = %self.name,
            spectator = self.spectator,
            "SERVER WS SESSION STARTED"
        );

        if !self.spectator {
            self.context
                .command_tx
                .send(GameCommand::PlayerJoined {
                    id: self.id,
                    name: self.name.clone(),
                })
                .await
                .map_err(|_| {
                    warn!(client_id = %self.id, "SERVER GAME LOOP UNAVAILABLE DURING JOIN");
                })?;
        }

        Ok(())
    }

    /// Reads incoming WebSocket messages, parses client requests,
    /// and forwards game commands to the simulation loop.
    pub async fn read_client_loop(&self, receiver: &mut SplitStream<WebSocket>) {
        while let Some(result) = receiver.next().await {
            let message = match result {
                Ok(message) => message,
                Err(_) => {
                    warn!(client_id = %self.id, "SERVER WS READ FAILED");
                    break;
                }
            };

            match message {
                Message::Text(text) => {
                    let parsed = serde_json::from_str::<ClientRequest>(&text);
                    let request = match parsed {
                        Ok(request) => request,
                        Err(error) => {
                            warn!(client_id = %self.id, %error, raw = %text, "SERVER WS PARSE FAILED");
                            continue;
                        }
                    };

                    match request {
                        ClientRequest::ClientLog {
                            scope,
                            event,
                            client_time,
                            details,
                        } => {
                            let details = details.unwrap_or(serde_json::Value::Null);
                            info!(
                                client_id = %self.id,
                                scope = %scope,
                                event = %event,
                                client_time = %client_time,
                                details = %details,
                                "REMOTE CLIENT LOG"
                            );
                            continue;
                        }
                        ClientRequest::Join { .. } => {
                            warn!(client_id = %self.id, "SERVER WS RECEIVED UNEXPECTED EXTRA JOIN");
                            continue;
                        }
                        _ => {}
                    }

                    if let Some(command) = request_to_command(self.id, request) {
                        if self.context.command_tx.send(command).await.is_err() {
                            warn!(client_id = %self.id, "SERVER GAME LOOP UNAVAILABLE");
                            break;
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    }

    /// Notifies the game loop about disconnection.
    pub async fn disconnect(&self) {
        if !self.spectator {
            let _ = self
                .context
                .command_tx
                .send(GameCommand::PlayerLeft { id: self.id })
                .await;
        }
        info!(client_id = %self.id, "SERVER WS SESSION ENDED");
    }
}

const HANDSHAKE_TIMEOUT_SECS: u64 = 5;

/// Full WebSocket session lifecycle: handshake, registration, event forwarding, and cleanup.
pub async fn handle_socket(socket: WebSocket, context: ServerContext) {
    let (mut sender, mut receiver) = socket.split();

    let join = match timeout(
        Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
        read_join_message(&mut receiver),
    )
    .await
    {
        Ok(Ok(join)) => join,
        Ok(Err(())) => {
            debug!("SERVER WS REJECTED: expected initial join message");
            let _ = sender.close().await;
            return;
        }
        Err(_) => {
            debug!("SERVER WS REJECTED: handshake timed out");
            let _ = sender.close().await;
            return;
        }
    };

    let session = ClientSession::from_join(join, context.clone());

    if session.register().await.is_err() {
        let _ = sender.close().await;
        return;
    }

    // Spectators get a direct welcome before the event stream starts.
    if session.spectator {
        if send_message(
            &mut sender,
            &ServerResponse::Welcome {
                player_id: session.id,
                name: session.name.clone(),
                tick_rate: TICK_RATE,
                move_speed: MOVE_SPEED,
                observer: true,
            },
        )
        .await
        .is_err()
        {
            let _ = sender.close().await;
            return;
        }
    }

    let writer_id = session.id;
    let writer_task = tokio::spawn(forward_events_to_socket(
        sender,
        context.event_tx.subscribe(),
        writer_id,
    ));

    session.read_client_loop(&mut receiver).await;
    session.disconnect().await;

    writer_task.abort();
}

/// Forwards game loop events (broadcasts and direct messages) to a single WebSocket.
async fn forward_events_to_socket(
    mut sender: SplitSink<WebSocket, Message>,
    mut event_rx: broadcast::Receiver<ServerEvent>,
    client_id: Uuid,
) {
    loop {
        let event = match event_rx.recv().await {
            Ok(event) => event,
            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                warn!(client_id = %client_id, skipped, "SERVER WS EVENT LAGGED");
                continue;
            }
            Err(broadcast::error::RecvError::Closed) => break,
        };

        let Some(message) = event.message_for(client_id) else {
            continue;
        };

        if send_message(&mut sender, &message).await.is_err() {
            warn!(client_id = %client_id, "SERVER WS WRITE FAILED");
            break;
        }
    }
}
