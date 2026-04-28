/// simulate the game world
use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, mpsc};
use tokio::time;
use tracing::{debug, info};
use uuid::Uuid;

use crate::lobby::networking::model::{
    ServerEvent, ServerResponse, SnapshotPlayer, WelcomeMessage, WorldSnapshot,
};

pub async fn start_simulation(
    mut game_rx: mpsc::Receiver<GameCommand>,
    event_tx: broadcast::Sender<ServerEvent>,
) {
    /// create a world
    let mut world = World::new(event_tx);
    let tick_duration = Duration::from_millis(1000 / world.tick_rate as u64);
    let mut ticker = time::interval(tick_duration);

    loop {
        ticker.tick().await;

        while let Ok(command) = game_rx.try_recv() {
            world.handle_command(command);
        }

        world.tick();
        world.sync();
    }
}

/// game world
pub struct World {
    players: HashMap<Uuid, ClientState>,
    tick_rate: u32,
    move_speed: f32,
    map_half_extent: f32,
    start: Instant,
    event_tx: broadcast::Sender<ServerEvent>,
}

impl World {
    pub fn new(event_tx: broadcast::Sender<ServerEvent>) -> Self {
        Self {
            players: HashMap::new(),
            tick_rate: 20,
            move_speed: 6.0,
            map_half_extent: 60.0,
            start: Instant::now(),
            event_tx,
        }
    }
    /// advance simulation by 1 tick
    pub fn tick(&mut self) {}

    /// make change in the world based on client input
    pub fn handle_command(&mut self, command: GameCommand) {}

    /// sync world state to all clients
    pub fn sync(&mut self) {}
}

/// client request to make a change in the world
pub enum GameCommand {
    PlayerJoined {
        id: Uuid,
        name: String,
    },
    PlayerLeft {
        id: Uuid,
    },
    PlayerInput {
        id: Uuid,
        seq: u32,
        move_x: f32,
        move_z: f32,
    },
}

/// internal state of a player in the world
pub struct ClientState {
    id: Uuid,
    name: String,
    color: String,
    x: f32,
    z: f32,
    move_x: f32,
    move_z: f32,
    last_seq: u32,
}
