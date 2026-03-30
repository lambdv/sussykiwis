mod model;

use std::fmt::{Display, Formatter};

use axum::{
    Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    routing::any,
};
use http::{Method, Request, header};
use tower_http::cors::{Any, CorsLayer};

use tokio::net::TcpListener;

async fn handler(ws: WebSocketUpgrade) -> axum::response::Response {
    println!("1");
    ws.on_upgrade(handle_socket)
}

async fn handle_socket(mut socket: WebSocket) {
    println!("1");

    while let Some(msg) = socket.recv().await {
        let msg = if let Ok(msg) = msg {
            println!("got message {:?}", msg);
            msg
        } else {
            println!("client disconnected");

            // client disconnected
            return;
        };

        if socket.send(msg).await.is_err() {
            // client disconnected
            //
            println!("client disconnected");

            return;
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "127.0.0.1:3000".to_string();
    let listener = TcpListener::bind(addr.clone()).await?;
    println!("Listening on port: {addr}");

    let cors = tower_http::cors::CorsLayer::new()
        .allow_methods([Method::GET, Method::POST])
        .allow_origin(Any);

    let app = Router::new().layer(cors).route("/ws", any(handler));
    axum::serve(listener, app).await?;
    Ok(())
}
