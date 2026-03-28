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

// impl Display for Message {
//     fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
//         match self {
//             Message::Text(bytes) => write!(f, bytes.as_str()),
//             _ => Error,
//         }
//     }
// }

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

pub enum SussyError {
    Sus,
    Amongus,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "127.0.0.1:3000".to_string();
    let listener = TcpListener::bind(addr.clone()).await?;
    println!("Listening on port: {addr}");

    let cors = tower_http::cors::CorsLayer::new()
        // allow `GET` and `POST` when accessing the resource
        .allow_methods([Method::GET, Method::POST])
        // allow requests from any origin
        .allow_origin(Any);

    let app = Router::new().layer(cors).route("/ws", any(handler));

    axum::serve(listener, app).await?;
    Ok(())
}
