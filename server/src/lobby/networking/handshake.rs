use axum::extract::ws::Message;
use futures_util::stream::StreamExt;
use serde_json;
use tracing::debug;

use crate::lobby::networking::model::ClientRequest;

pub struct JoinRequest {
    pub name: Option<String>,
    pub spectator: bool,
}

/// Reads and validates the first client packet as a join request.
/// Accepts pre-join ClientLog messages without failing the handshake.
pub async fn read_join_message(
    receiver: &mut futures_util::stream::SplitStream<axum::extract::ws::WebSocket>,
) -> Result<JoinRequest, ()> {
    loop {
        let Some(result) = receiver.next().await else {
            debug!("HANDSHAKE: stream ended");
            return Err(());
        };

        let message = match result {
            Ok(msg) => msg,
            Err(e) => {
                debug!(error = %e, "HANDSHAKE: websocket error");
                return Err(());
            }
        };

        match message {
            Message::Text(text) => {
                match serde_json::from_str::<ClientRequest>(&text) {
                    Ok(ClientRequest::Join { name, spectator }) => {
                        return Ok(JoinRequest { name, spectator });
                    }
                    Ok(ClientRequest::ClientLog {
                        scope,
                        event,
                        client_time,
                        details,
                    }) => {
                        let details = details.unwrap_or(serde_json::Value::Null);
                        debug!(
                            scope = %scope,
                            event = %event,
                            client_time = %client_time,
                            details = %details,
                            "HANDSHAKE: pre-join client log"
                        );
                    }
                    Ok(other) => {
                        debug!(request = ?other, "HANDSHAKE: unexpected request type");
                        return Err(());
                    }
                    Err(_) => {
                        debug!(raw = %text.chars().take(120).collect::<String>(), "HANDSHAKE: non-json payload");
                        return Err(());
                    }
                }
            }
            Message::Binary(data) => {
                debug!(len = data.len(), "HANDSHAKE: binary frame");
                return Err(());
            }
            Message::Ping(_) | Message::Pong(_) => {
                // Protocol-level frames are handled by axum, skip silently.
            }
            Message::Close(_) => {
                debug!("HANDSHAKE: close frame received");
                return Err(());
            }
        }
    }
}
