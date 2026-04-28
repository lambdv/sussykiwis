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
    // Create the authoritative world once and tick it forever.
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
    pub fn tick(&mut self) {
        if self.players.is_empty() {
            return;
        }

        let dt = 1.0 / self.tick_rate as f32;

        // Integrate each player using latest authoritative input values.
        for player in self.players.values_mut() {
            player.x += player.move_x * self.move_speed * dt;
            player.z += player.move_z * self.move_speed * dt;
            player.x = player.x.clamp(-self.map_half_extent, self.map_half_extent);
            player.z = player.z.clamp(-self.map_half_extent, self.map_half_extent);
        }

        debug!(dt, player_count = self.players.len(), "SERVER TICK");
    }

    /// make change in the world based on client input
    pub fn handle_command(&mut self, command: GameCommand) {
        match command {
            GameCommand::PlayerJoined { id, name } => {
                // Assign one server-owned player color to keep all clients consistent.
                let color = pick_player_color(self.players.len());

                // Spawn the new player at origin with no active movement.
                let player = ClientState {
                    id,
                    name: name.clone(),
                    color: color.clone(),
                    x: 0.0,
                    z: 0.0,
                    move_x: 0.0,
                    move_z: 0.0,
                    last_seq: 0,
                };

                self.players.insert(id, player);

                info!(
                    player_id = %id,
                    player_name = %name,
                    color = %color,
                    player_count = self.players.len(),
                    "SERVER STATE TRANSITION: player joined"
                );

                // Publish welcome payload once the player is registered in authority.
                let _ = self.event_tx.send(ServerEvent::Direct {
                    to: id,
                    message: ServerResponse::Welcome(WelcomeMessage {
                        id,
                        name,
                    }),
                });
            }
            GameCommand::PlayerLeft { id } => {
                // Remove players immediately when their websocket closes.
                self.players.remove(&id);
                info!(
                    player_id = %id,
                    player_count = self.players.len(),
                    "SERVER STATE TRANSITION: player left"
                );
            }
            GameCommand::PlayerInput {
                id,
                seq,
                move_x,
                move_z,
            } => {
                // Clamp combined axes so diagonal input cannot exceed max speed.
                let length_sq = (move_x * move_x) + (move_z * move_z);
                let (clamped_x, clamped_z) = if length_sq > 1.0 {
                    let length = length_sq.sqrt();
                    (move_x / length, move_z / length)
                } else {
                    (move_x, move_z)
                };

                // Ignore stale sequence numbers to keep latest-input semantics.
                if let Some(player) = self.players.get_mut(&id) {
                    if seq <= player.last_seq {
                        debug!(player_id = %id, seq, last_seq = player.last_seq, "SERVER INPUT DROPPED: stale sequence");
                        return;
                    }

                    player.last_seq = seq;
                    player.move_x = clamped_x;
                    player.move_z = clamped_z;
                } else {
                    return;
                }

                debug!(
                    player_id = %id,
                    seq,
                    move_x = clamped_x,
                    move_z = clamped_z,
                    "SERVER INPUT UPDATE"
                );
            }
        }
    }

    /// sync world state to all clients
    pub fn sync(&mut self) {
        let server_time = self.start.elapsed().as_millis() as u64;
        let players = self
            .players
            .values()
            .map(|player| SnapshotPlayer {
                id: player.id,
                name: player.name.clone(),
                color: player.color.clone(),
                x: player.x,
                z: player.z,
                last_processed_seq: player.last_seq,
            })
            .collect::<Vec<_>>();

        let payload = ServerResponse::WorldSnapshot(WorldSnapshot {
            server_time,
            players,
        });

        debug!(
            server_time,
            player_count = self.players.len(),
            "SERVER SNAPSHOT BROADCAST"
        );

        // Fan out one authoritative snapshot through the shared broadcast channel.
        let _ = self.event_tx.send(ServerEvent::Broadcast(payload));
    }
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

fn pick_player_color(index: usize) -> String {
    // Cycle through a small fixed palette so clients can distinguish players.
    const COLORS: [&str; 6] = ["#ebb0ff", "#8fd3ff", "#ffd37a", "#9cffb0", "#ff9aa2", "#c7b8ff"];
    COLORS[index % COLORS.len()].to_string()
}
