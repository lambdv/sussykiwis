use std::{collections::HashMap, sync::Arc};

use uuid::Uuid;

use tokio::sync::{Mutex, broadcast, mpsc};

#[derive(Clone)]
pub struct AppState {
    pub game_tx: mpsc::Sender<GameCommand>,
    pub event_tx: broadcast::Sender<ServerEvent>,
    pub lobbies: HashMap<i32, Arc<Mutex<Lobby>>>,
}

impl AppState {
    pub fn new(
        game_tx: mpsc::Sender<GameCommand>,
        event_tx: broadcast::Sender<ServerEvent>,
    ) -> Self {
        let mut lobbies = HashMap::new();
        let lobby = Arc::new(Mutex::new(Lobby::new()));
        lobbies.insert(0, lobby);
        Self {
            game_tx,
            event_tx,
            lobbies,
        }
    }
}

#[derive(Clone, Debug)]
pub enum GameCommand {
    PlayerInput(ServerInput),
}

#[derive(Clone, Debug)]
pub struct ServerInput {
    pub player_id: Uuid,
    pub move_x: f32,
    pub move_y: f32,
}

#[derive(Clone, Debug)]
pub enum ServerEvent {
    PlayerJoined(Player),
    PlayerLeft(Uuid),
    WorldSnapshot(WorldSnapshot),
}

#[derive(Clone, Debug)]
pub struct WorldSnapshot {
    pub server_time: u64,
    pub players: Vec<Player>,
}

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
