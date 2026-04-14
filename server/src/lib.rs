pub mod model;
pub mod lobby;
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
use tower_http::trace::TraceLayer;

pub fn get_app() -> axum::Router {
    let cors = tower_http::cors::CorsLayer::new()
        .allow_methods([http::Method::GET, http::Method::POST])
        .allow_origin(tower_http::cors::Any);
    axum::Router::new()
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .route(
            "/ws",
            any(ws_handler),
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
        .with_state(lobby::state::AppState::new())
}

async fn ws_handler(ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(handle_socket)
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
