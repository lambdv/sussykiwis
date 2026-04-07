pub mod model;

use std::collections::HashMap;

use axum::{
    Json,
    extract::ws::WebSocketUpgrade,
    http::{
        StatusCode, Uri,
        header::{self, HeaderMap, HeaderName},
    },
    response::{Html, IntoResponse},
    routing::{any, get},
};
use serde_json::json;

pub fn get_app() -> axum::Router {
    let cors = tower_http::cors::CorsLayer::new()
        .allow_methods([http::Method::GET, http::Method::POST])
        .allow_origin(tower_http::cors::Any);
    axum::Router::new()
        .layer(cors)
        .route(
            "/ws",
            any(|ws: WebSocketUpgrade| async { ws.on_upgrade(handle_socket) }),
        )
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
        //.with_state(AppState {})
}

/// state of the app that you pass for each request
#[derive(Debug, Clone)]
pub struct AppState {
    lobbies: HashMap<i32, model::Lobby>,
}

/// handles websocket messages
pub async fn handle_socket(mut socket: axum::extract::ws::WebSocket) {
    while let Some(msg) = socket.recv().await {
        let msg = if let Ok(msg) = msg {
            //println!("got message {:?}", msg);
            msg
        } else {
            println!("client disconnected");
            return;
        };

        if socket.send(msg).await.is_err() {
            println!("client disconnected");
            return;
        }
    }
}
