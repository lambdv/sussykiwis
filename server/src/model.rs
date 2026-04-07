use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/**
 * message models
 */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Request {
    Join,
    UpdatePosition(Position),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Response {
    Join,

    UpdatePosition(Position),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    x: f32,
    y: f32,
}

#[derive(Debug, Clone)]
pub struct PlayerState {
    name: String,
    position: Position,
}

/**
 * server types
 */
#[derive(Debug, Clone)]
pub struct Lobby {
    state: GameState,
    players: HashMap<Uuid, PlayerState>,
}
#[derive(Debug, Clone)]

pub enum GameState {
    Lobby,
    Map,
    Meeting,
}
