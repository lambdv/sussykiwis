use std::{
    collections::HashMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use uuid::Uuid;

use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};

use tokio::{
    sync::{
        Mutex,
        mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel},
    },
    time::{Duration, sleep},
};

#[derive(Clone, Debug)]
pub struct AppState {
    pub lobbies: HashMap<i32, LobbyState>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            lobbies: HashMap::new(),
        }
    }
}

type LobbyState = Arc<Mutex<Lobby>>;

#[derive(Clone, Debug)]

pub struct Lobby {
    pub players: Vec<Player>,
    pub state: GameState,
}

impl Lobby {
    pub fn new() -> Self {
        Self {
            players: Vec::new(),
            state: GameState::Lobby,
        }
    }

    pub fn add_player(&mut self, player: Player) {
        self.players.push(player);
    }
}

#[derive(Clone, Debug)]
pub enum GameState {
    Lobby,
    Overworld,
    Meeting,
}

#[derive(Clone, Debug)]
pub struct Player {
    pub id: Uuid,
    pub name: String,
    pub x: f32,
    pub y: f32,
}
