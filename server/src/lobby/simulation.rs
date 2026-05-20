/// Simulates the authoritative game world.
use std::collections::{HashMap, HashSet};
use std::f32::consts::TAU;
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::{broadcast, mpsc};
use tokio::time;
use tracing::{debug, info};
use uuid::Uuid;

use crate::lobby::networking::model::{
    ActiveSabotage, BorrowDirection, Faction, GamePhase, GameSubState, KiwiBorrowLink,
    KiwiBorrowSnapshot, MeetingChatMessage, MeetingSnapshot, MeetingVoteCount, PlayerRole,
    PlayerState, PuzzleKind, PuzzleProjectionState, PuzzleStationSnapshot, SabotageKind,
    ServerEvent, ServerResponse, SnapshotDeadBody, SnapshotPlayer, WinMessage, WireColor,
    WireConnection, WorldSnapshot,
};

const MIN_PLAYERS: usize = 4;
const MAX_PLAYERS: usize = 15;
const KILL_RANGE: f32 = 4.0;
const REPORT_RANGE: f32 = 4.0;
const PUZZLE_RANGE: f32 = 4.5;
pub const TICK_RATE: u32 = 20;
pub const MOVE_SPEED: f32 = 10.0;
const LOBBY_COUNTDOWN_SECONDS: u64 = 1;
const TOTAL_PUZZLES_PER_PLAYER: usize = 10;
const TIMER_TARGET_SIZE: f32 = 0.8;
const TIMER_ROTATION_PER_TICK: f32 = 0.28;
const LOBBY_LDTK_JSON: &str = include_str!("../../../client/public/assets/game.ldtk");

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

/// Client requests that can change the authoritative world.
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
    Kill {
        id: Uuid,
        target_id: Uuid,
    },
    ReportBody {
        id: Uuid,
        body_id: Uuid,
    },
    Vote {
        id: Uuid,
        target: VoteTarget,
    },
    MeetingChat {
        id: Uuid,
        message: String,
    },
    Sabotage {
        id: Uuid,
        kind: SabotageKind,
    },
    StartPuzzle {
        id: Uuid,
        station_id: Uuid,
    },
    CancelPuzzle {
        id: Uuid,
    },
    PuzzleTap {
        id: Uuid,
    },
    PuzzleConnect {
        id: Uuid,
        from_index: usize,
        to_index: usize,
    },
    EnterBorrow {
        id: Uuid,
        borrow_id: Uuid,
    },
    TraverseBorrow {
        id: Uuid,
        direction: BorrowDirection,
    },
    ExitBorrow {
        id: Uuid,
    },
}

#[derive(Clone)]
struct Player {
    id: Uuid,
    name: String,
    color: String,
    x: f32,
    z: f32,
    // Authoritative flag indicating if the player is looking to the left
    facing_left: bool,
    move_x: f32,
    move_z: f32,
    last_seq: u32,
    role: PlayerRole,
    state: PlayerState,
    kill_cooldown_ends_at_tick: u64,
    completed_puzzle_station_ids: HashSet<Uuid>,
}

#[derive(Clone)]
struct PuzzleStation {
    id: Uuid,
    kind: PuzzleKind,
    x: f32,
    z: f32,
    occupant: Option<PuzzleOccupant>,
}

#[derive(Clone)]
struct PuzzleOccupant {
    player_id: Uuid,
    state: ActivePuzzleState,
}

#[derive(Clone)]
enum ActivePuzzleState {
    Timer(TimerPuzzleState),
    Wires(WiresPuzzleState),
}

#[derive(Clone)]
struct TimerPuzzleState {
    started_at_tick: u64,
    target_start: f32,
}

#[derive(Clone)]
struct WiresPuzzleState {
    left_colors: [WireColor; 4],
    right_colors: [WireColor; 4],
    connected_pairs: Vec<WireConnection>,
}

#[derive(Clone)]
struct DeadBody {
    id: Uuid,
    player_id: Uuid,
    x: f32,
    z: f32,
    reported: bool,
}

#[derive(Clone)]
struct MeetingState {
    reported_body_id: Uuid,
    started_at_tick: u64,
    ends_at_tick: u64,
    votes: HashMap<Uuid, VoteTarget>,
    chat: Vec<MeetingChatMessage>,
}

#[derive(Clone)]
struct EjectionState {
    ends_at_tick: u64,
    ejected_player_id: Option<Uuid>,
}

#[derive(Clone)]
struct LobbyCollisionMap {
    width: usize,
    height: usize,
    half_width: f32,
    half_height: f32,
    solid: Vec<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LdtkProject {
    levels: Vec<LdtkLevel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LdtkLevel {
    px_wid: u32,
    px_hei: u32,
    layer_instances: Vec<LdtkLayer>,
}

#[derive(Deserialize)]
struct LdtkLayer {
    #[serde(rename = "__identifier")]
    identifier: String,
    #[serde(rename = "__cWid")]
    width: usize,
    #[serde(rename = "__cHei")]
    height: usize,
    #[serde(rename = "__gridSize")]
    grid_size: u32,
    #[serde(default, rename = "intGridCsv")]
    int_grid_csv: Vec<i32>,
}

#[derive(Clone, Copy)]
pub enum VoteTarget {
    Player(Uuid),
    Skip,
}

/// Authoritative game world.
pub struct World {
    players: HashMap<Uuid, Player>,
    join_order: Vec<Uuid>,
    dead_bodies: HashMap<Uuid, DeadBody>,
    puzzle_stations: Vec<PuzzleStation>,
    active_sabotages: Vec<ActiveSabotage>,
    phase: GamePhase,
    round_locked: bool,
    lobby_countdown_ends_at_tick: Option<u64>,
    meeting: Option<MeetingState>,
    ejection: Option<EjectionState>,
    win: Option<WinMessage>,
    tick: u64,
    tick_rate: u32,
    move_speed: f32,
    lobby_collision: LobbyCollisionMap,
    lobby_map_half_extent: f32,
    event_tx: broadcast::Sender<ServerEvent>,
}

impl World {
    pub fn new(event_tx: broadcast::Sender<ServerEvent>) -> Self {
        let lobby_collision = load_lobby_collision_map();
        Self {
            players: HashMap::new(),
            join_order: Vec::new(),
            dead_bodies: HashMap::new(),
            puzzle_stations: create_puzzle_stations(),
            active_sabotages: Vec::new(),
            phase: GamePhase::Lobby,
            round_locked: false,
            lobby_countdown_ends_at_tick: None,
            meeting: None,
            ejection: None,
            win: None,
            tick: 0,
            tick_rate: TICK_RATE,
            move_speed: MOVE_SPEED,
            lobby_map_half_extent: lobby_collision.half_width.min(lobby_collision.half_height),
            lobby_collision,
            event_tx,
        }
    }

    /// Advances the world by one fixed simulation tick.
    pub fn tick(&mut self) {
        self.tick += 1;

        // Allow movement in pre-match lobby and active gameplay phases.
        if matches!(self.phase, GamePhase::Lobby | GamePhase::Playing) {
            let dt = 1.0 / self.tick_rate as f32;
            let map_half_extent = self.current_map_half_extent();

            // Integrate the latest input for movable player states.
            for player in self.players.values_mut() {
                if !matches!(player.state, PlayerState::Alive | PlayerState::Ghost) {
                    continue;
                }

                let target_x = player.x + player.move_x * self.move_speed * dt;
                let target_z = player.z + player.move_z * self.move_speed * dt;
                (player.x, player.z) = resolve_position_for_phase(
                    player.x,
                    player.z,
                    target_x,
                    target_z,
                    map_half_extent,
                    &self.lobby_collision,
                );
            }
        }

        self.expire_sabotages();
        self.sync_puzzle_sessions();
        self.advance_meeting_if_needed();
        self.advance_ejection_if_needed();
        self.try_start_match();

        debug!(
            tick = self.tick,
            phase = ?self.phase,
            player_count = self.players.len(),
            "SERVER TICK"
        );
    }

    /// Applies one client command after validating it against current world state.
    pub fn handle_command(&mut self, command: GameCommand) {
        match command {
            GameCommand::PlayerJoined { id, name } => self.handle_join(id, name),
            GameCommand::PlayerLeft { id } => self.handle_leave(id),
            GameCommand::PlayerInput {
                id,
                seq,
                move_x,
                move_z,
            } => self.handle_input(id, seq, move_x, move_z),
            GameCommand::Kill { id, target_id } => self.handle_kill(id, target_id),
            GameCommand::ReportBody { id, body_id } => self.handle_report(id, body_id),
            GameCommand::Vote { id, target } => self.handle_vote(id, target),
            GameCommand::MeetingChat { id, message } => self.handle_meeting_chat(id, message),
            GameCommand::Sabotage { id, kind } => self.handle_sabotage(id, kind),
            GameCommand::StartPuzzle { id, station_id } => self.handle_start_puzzle(id, station_id),
            GameCommand::CancelPuzzle { id } => self.release_puzzle_for_player(id),
            GameCommand::PuzzleTap { id } => self.handle_puzzle_tap(id),
            GameCommand::PuzzleConnect {
                id,
                from_index,
                to_index,
            } => self.handle_puzzle_connect(id, from_index, to_index),
            // Borrow movement is not wired into the simulation yet, so ignore these for now.
            GameCommand::EnterBorrow { id, borrow_id } => {
                let _ = (id, borrow_id);
            }
            GameCommand::TraverseBorrow { id, direction } => {
                let _ = (id, direction);
            }
            GameCommand::ExitBorrow { id } => {
                let _ = id;
            }
        }
    }

    fn handle_join(&mut self, id: Uuid, _name: String) {
        if self.players.len() >= MAX_PLAYERS {
            // Refuse joins beyond the lobby cap so the server stays authoritative.
            let _ = self.event_tx.send(ServerEvent::Direct {
                to: id,
                message: ServerResponse::JoinRejected {
                    reason: "Lobby is full".to_string(),
                },
            });
            return;
        }

        let (color_name, color) = pick_player_color(self.players.len());
        let (spawn_x, spawn_z) = pick_spawn_position(self.join_order.len());

        // Spawn the player into the lobby with no role until the match starts.
        let player = Player {
            id,
            name: color_name.to_string(),
            color: color.to_string(),
            x: spawn_x,
            z: spawn_z,
            // By default, the player is not looking left
            facing_left: false,
            move_x: 0.0,
            move_z: 0.0,
            last_seq: 0,
            role: PlayerRole::Crewmate,
            state: PlayerState::Alive,
            kill_cooldown_ends_at_tick: 0,
            completed_puzzle_station_ids: HashSet::new(),
        };

        self.players.insert(id, player);
        self.join_order.push(id);

        info!(
            player_id = %id,
            player_name = %color_name,
            color = %color,
            player_count = self.players.len(),
            "SERVER STATE TRANSITION: player joined"
        );

        let _ = self.event_tx.send(ServerEvent::Direct {
            to: id,
            message: ServerResponse::Welcome {
                player_id: id,
                name: color_name.to_string(),
                tick_rate: self.tick_rate,
                move_speed: self.move_speed,
                observer: false,
            },
        });

        self.maybe_unlock_round();
        self.try_start_match();
    }

    fn handle_leave(&mut self, id: Uuid) {
        self.players.remove(&id);
        self.join_order.retain(|player_id| *player_id != id);
        self.release_puzzle_for_player(id);

        // Drop votes from disconnected players so meetings can still resolve.
        if let Some(meeting) = self.meeting.as_mut() {
            meeting.votes.remove(&id);
        }

        info!(
            player_id = %id,
            player_count = self.players.len(),
            "SERVER STATE TRANSITION: player left"
        );

        self.maybe_unlock_round();
        self.check_win_condition();
    }

    fn handle_input(&mut self, id: Uuid, seq: u32, move_x: f32, move_z: f32) {
        // Clamp combined axes so diagonal input cannot exceed max speed.
        let length_sq = (move_x * move_x) + (move_z * move_z);
        let (clamped_x, clamped_z) = if length_sq > 1.0 {
            let length = length_sq.sqrt();
            (move_x / length, move_z / length)
        } else {
            (move_x, move_z)
        };

        let Some(player) = self.players.get_mut(&id) else {
            return;
        };

        // Ignore stale sequence numbers to keep latest-input semantics.
        if seq <= player.last_seq {
            debug!(player_id = %id, seq, last_seq = player.last_seq, "SERVER INPUT DROPPED: stale sequence");
            return;
        }

        player.last_seq = seq;

        // Meeting, ejection, and win phases freeze movement without dropping ack state.
        if !matches!(self.phase, GamePhase::Lobby | GamePhase::Playing)
            || !matches!(player.state, PlayerState::Alive | PlayerState::Ghost)
        {
            player.move_x = 0.0;
            player.move_z = 0.0;
            return;
        }

        player.move_x = clamped_x;
        player.move_z = clamped_z;
        if clamped_x < 0.0 {
            // Player is moving left, update the facing direction immediately
            player.facing_left = true;
        } else if clamped_x > 0.0 {
            // Player is moving right, update the facing direction immediately
            player.facing_left = false;
        }
    }

    fn handle_kill(&mut self, id: Uuid, target_id: Uuid) {
        if !matches!(self.phase, GamePhase::Playing) {
            return;
        }

        let Some(actor) = self.players.get(&id).cloned() else {
            return;
        };
        let Some(target) = self.players.get(&target_id).cloned() else {
            return;
        };

        if !matches!(actor.state, PlayerState::Alive) || !matches!(target.state, PlayerState::Alive)
        {
            return;
        }

        if !matches!(actor.role, PlayerRole::Imposter | PlayerRole::Sheriff) {
            return;
        }

        if actor.kill_cooldown_ends_at_tick > self.tick {
            return;
        }

        if distance_sq(actor.x, actor.z, target.x, target.z) > KILL_RANGE * KILL_RANGE {
            return;
        }

        // Mark the victim as a ghost immediately so they can keep moving after death.
        if let Some(victim) = self.players.get_mut(&target_id) {
            victim.state = PlayerState::Ghost;
            victim.move_x = 0.0;
            victim.move_z = 0.0;
        }

        if let Some(killer) = self.players.get_mut(&id) {
            killer.kill_cooldown_ends_at_tick = self.tick + (self.tick_rate as u64 * 30);
        }

        let body_id = Uuid::new_v4();
        self.dead_bodies.insert(
            body_id,
            DeadBody {
                id: body_id,
                player_id: target_id,
                x: target.x,
                z: target.z,
                reported: false,
            },
        );

        info!(
            tick = self.tick,
            killer_id = %id,
            victim_id = %target_id,
            victim_role = ?target.role,
            body_id = %body_id,
            "SERVER STATE: player killed"
        );

        self.check_win_condition();
    }

    fn handle_report(&mut self, id: Uuid, body_id: Uuid) {
        if !matches!(self.phase, GamePhase::Playing) {
            return;
        }

        let Some(actor) = self.players.get(&id) else {
            return;
        };

        if !matches!(actor.state, PlayerState::Alive) {
            return;
        }

        let Some(body) = self.dead_bodies.get(&body_id).cloned() else {
            return;
        };

        if body.reported
            || distance_sq(actor.x, actor.z, body.x, body.z) > REPORT_RANGE * REPORT_RANGE
        {
            return;
        }

        if let Some(body_state) = self.dead_bodies.get_mut(&body_id) {
            body_state.reported = true;
        }

        // Freeze the match into a meeting until votes resolve or the timer expires.
        let ends_at_tick = self.tick + (self.tick_rate as u64 * 120);
        self.phase = GamePhase::Meeting;
        self.meeting = Some(MeetingState {
            reported_body_id: body_id,
            started_at_tick: self.tick,
            ends_at_tick,
            votes: HashMap::new(),
            chat: Vec::new(),
        });

        for player in self.players.values_mut() {
            player.move_x = 0.0;
            player.move_z = 0.0;
        }

        // Remove every body now that the meeting has started so the arena is cleaned up immediately.
        self.dead_bodies.clear();

        info!(
            tick = self.tick,
            phase = ?self.phase,
            reported_by = %id,
            body_id = %body_id,
            "SERVER STATE TRANSITION: meeting started"
        );

        let _ = self
            .event_tx
            .send(ServerEvent::Broadcast(ServerResponse::MeetingStarted {
                reported_body_id: body_id,
            }));
    }

    fn handle_vote(&mut self, id: Uuid, target: VoteTarget) {
        if !matches!(self.phase, GamePhase::Meeting) {
            return;
        }

        let Some(voter) = self.players.get(&id) else {
            return;
        };

        if !matches!(voter.state, PlayerState::Alive) {
            return;
        }

        let alive_players = self.count_alive_players();
        let Some(meeting) = self.meeting.as_mut() else {
            return;
        };

        if meeting.votes.contains_key(&id) {
            return;
        }

        if let VoteTarget::Player(target_id) = target {
            let Some(target_player) = self.players.get(&target_id) else {
                return;
            };

            if !matches!(target_player.state, PlayerState::Alive) {
                return;
            }
        }

        meeting.votes.insert(id, target);
        let _ = self
            .event_tx
            .send(ServerEvent::Broadcast(ServerResponse::VoteUpdate {
                votes_cast: meeting.votes.len(),
                total_voters: alive_players,
            }));

        if meeting.votes.len() >= alive_players {
            self.resolve_meeting();
        }
    }

    fn handle_meeting_chat(&mut self, id: Uuid, message: String) {
        if !matches!(self.phase, GamePhase::Meeting) {
            return;
        }

        let Some(player) = self.players.get(&id) else {
            return;
        };

        let trimmed = message.trim();
        if trimmed.is_empty() {
            return;
        }

        let Some(meeting) = self.meeting.as_mut() else {
            return;
        };

        let entry = MeetingChatMessage {
            player_id: id,
            name: player.name.clone(),
            message: trimmed.chars().take(120).collect(),
            server_time: self.tick * 1000 / self.tick_rate as u64,
        };

        meeting.chat.push(entry.clone());
        if meeting.chat.len() > 20 {
            meeting.chat.remove(0);
        }

        let _ = self
            .event_tx
            .send(ServerEvent::Broadcast(ServerResponse::MeetingChat {
                player_id: entry.player_id,
                name: entry.name,
                message: entry.message,
                server_time: entry.server_time,
            }));
    }

    fn handle_sabotage(&mut self, id: Uuid, kind: SabotageKind) {
        if !matches!(self.phase, GamePhase::Playing) {
            return;
        }

        let Some(actor) = self.players.get(&id) else {
            return;
        };

        if !matches!(actor.role, PlayerRole::Imposter) || !matches!(actor.state, PlayerState::Alive)
        {
            return;
        }

        // Keep sabotage simple for the slice: one active instance per kind with a fixed timer.
        if self
            .active_sabotages
            .iter()
            .any(|sabotage| sabotage.kind == kind)
        {
            return;
        }

        self.active_sabotages.push(ActiveSabotage {
            kind,
            started_at_tick: self.tick,
            ends_at_tick: self.tick + (self.tick_rate as u64 * 10),
        });
    }

    fn handle_start_puzzle(&mut self, id: Uuid, station_id: Uuid) {
        if !matches!(self.phase, GamePhase::Playing) || self.active_station_for_player(id).is_some()
        {
            return;
        }

        let Some(player) = self.players.get(&id).cloned() else {
            return;
        };

        // Only crew-side players may work tasks, and only while close enough to the station.
        if !can_work_puzzles(&player)
            || player.completed_puzzle_station_ids.contains(&station_id)
            || player.completed_puzzle_station_ids.len() >= TOTAL_PUZZLES_PER_PLAYER
        {
            return;
        }

        let Some(station) = self
            .puzzle_stations
            .iter_mut()
            .find(|station| station.id == station_id)
        else {
            return;
        };

        if station.occupant.is_some()
            || distance_sq(player.x, player.z, station.x, station.z) > PUZZLE_RANGE * PUZZLE_RANGE
        {
            return;
        }

        // Start a fresh authoritative puzzle session for this player at this station.
        station.occupant = Some(PuzzleOccupant {
            player_id: id,
            state: match station.kind {
                PuzzleKind::Timer => ActivePuzzleState::Timer(TimerPuzzleState {
                    started_at_tick: self.tick,
                    target_start: pick_timer_target_start(station.id, id),
                }),
                PuzzleKind::Wires => ActivePuzzleState::Wires(create_wires_state(station.id, id)),
            },
        });
    }

    fn handle_puzzle_tap(&mut self, id: Uuid) {
        // Ignore puzzle input unless the round is actively playing.
        if !matches!(self.phase, GamePhase::Playing) {
            return;
        }

        let Some(station_index) = self.active_station_for_player(id) else {
            return;
        };

        let (station_id, solved) = {
            let Some(station) = self.puzzle_stations.get_mut(station_index) else {
                return;
            };

            let solved = match station.occupant.as_mut() {
                Some(PuzzleOccupant {
                    player_id,
                    state: ActivePuzzleState::Timer(timer),
                }) if *player_id == id => angle_in_arc(
                    current_timer_angle(self.tick, timer),
                    timer.target_start,
                    TIMER_TARGET_SIZE,
                ),
                _ => return,
            };

            (station.id, solved)
        };

        if solved {
            self.complete_puzzle(id, station_id);
            return;
        }

        // Reset the timer timing window on a miss so the player must wait for a new pass.
        if let Some(station) = self.puzzle_stations.get_mut(station_index) {
            if let Some(PuzzleOccupant {
                state: ActivePuzzleState::Timer(timer),
                ..
            }) = station.occupant.as_mut()
            {
                timer.started_at_tick = self.tick;
            }
        }
    }

    fn handle_puzzle_connect(&mut self, id: Uuid, from_index: usize, to_index: usize) {
        // Ignore puzzle input unless the round is actively playing.
        if !matches!(self.phase, GamePhase::Playing) {
            return;
        }

        let Some(station_index) = self.active_station_for_player(id) else {
            return;
        };

        let (station_id, solved) = {
            let Some(station) = self.puzzle_stations.get_mut(station_index) else {
                return;
            };

            let solved = match station.occupant.as_mut() {
                Some(PuzzleOccupant {
                    player_id,
                    state: ActivePuzzleState::Wires(wires),
                }) if *player_id == id => {
                    if from_index >= wires.left_colors.len()
                        || to_index >= wires.right_colors.len()
                        || wires
                            .connected_pairs
                            .iter()
                            .any(|pair| pair.from_index == from_index || pair.to_index == to_index)
                        || wires.left_colors[from_index] != wires.right_colors[to_index]
                    {
                        return;
                    }

                    wires.connected_pairs.push(WireConnection {
                        from_index,
                        to_index,
                    });
                    wires.connected_pairs.len() == wires.left_colors.len()
                }
                _ => return,
            };

            (station.id, solved)
        };

        if solved {
            self.complete_puzzle(id, station_id);
        }
    }

    fn sync_puzzle_sessions(&mut self) {
        // Release every active puzzle whenever the round is not in live free-move play.
        if !matches!(self.phase, GamePhase::Playing) {
            for station in &mut self.puzzle_stations {
                station.occupant = None;
            }
            return;
        }

        let mut players_to_release = Vec::new();
        for station in &self.puzzle_stations {
            let Some(occupant) = station.occupant.as_ref() else {
                continue;
            };

            let Some(player) = self.players.get(&occupant.player_id) else {
                players_to_release.push(occupant.player_id);
                continue;
            };

            // Keep sessions active only while the authoritative player remains eligible and nearby.
            if !can_work_puzzles(player)
                || distance_sq(player.x, player.z, station.x, station.z)
                    > PUZZLE_RANGE * PUZZLE_RANGE
            {
                players_to_release.push(occupant.player_id);
            }
        }

        for player_id in players_to_release {
            self.release_puzzle_for_player(player_id);
        }
    }

    fn active_station_for_player(&self, player_id: Uuid) -> Option<usize> {
        self.puzzle_stations.iter().position(|station| {
            station
                .occupant
                .as_ref()
                .map(|occupant| occupant.player_id == player_id)
                .unwrap_or(false)
        })
    }

    fn release_puzzle_for_player(&mut self, player_id: Uuid) {
        if let Some(station_index) = self.active_station_for_player(player_id) {
            self.puzzle_stations[station_index].occupant = None;
        }
    }

    fn complete_puzzle(&mut self, player_id: Uuid, station_id: Uuid) {
        if let Some(player) = self.players.get_mut(&player_id) {
            // Track task completion per station so each crew member must clear all ten stations once.
            player.completed_puzzle_station_ids.insert(station_id);
        }

        self.release_puzzle_for_player(player_id);
        self.check_win_condition();
    }

    /// Syncs world state to all clients.
    pub fn sync(&mut self) {
        let payload = ServerResponse::WorldSnapshot {
            snapshot: WorldSnapshot {
                tick: self.tick,
                server_time: self.tick * 1000 / self.tick_rate as u64,
                phase: self.phase,
                // Tell clients whether this snapshot is still pre-match or already in-match.
                sub_state: self.current_sub_state(),
                // Send player progress so pre-match UI can show waiting status.
                joined_players: self.players.len(),
                expected_players: MAX_PLAYERS,
                map_half_extent: self.current_map_half_extent(),
                lobby_countdown_ends_at: self
                    .lobby_countdown_ends_at_tick
                    .map(|tick| tick * 1000 / self.tick_rate as u64),
                players: self
                    .players
                    .values()
                    .map(|player| SnapshotPlayer {
                        id: player.id,
                        name: player.name.clone(),
                        color: player.color.clone(),
                        role: player.role,
                        x: player.x,
                        z: player.z,
                        facing_left: player.facing_left,
                        state: player.state,
                        current_borrow_id: None,
                        // Send cooldown in rendered server-time units so the client can gate kills accurately.
                        kill_cooldown_ends_at: player.kill_cooldown_ends_at_tick * 1000
                            / self.tick_rate as u64,
                        last_processed_seq: player.last_seq,
                        completed_puzzle_count: player.completed_puzzle_station_ids.len(),
                        total_puzzle_count: TOTAL_PUZZLES_PER_PLAYER,
                    })
                    .collect::<Vec<_>>(),
                // Keep kiwi borrows aligned with the same playable LDtk space as tasks.
                kiwi_borrows: create_kiwi_borrows(),
                dead_bodies: self
                    .dead_bodies
                    .values()
                    .map(|body| SnapshotDeadBody {
                        id: body.id,
                        player_id: body.player_id,
                        x: body.x,
                        z: body.z,
                        reported: body.reported,
                    })
                    .collect::<Vec<_>>(),
                puzzle_stations: self
                    .puzzle_stations
                    .iter()
                    .map(|station| PuzzleStationSnapshot {
                        id: station.id,
                        kind: station.kind,
                        x: station.x,
                        z: station.z,
                        occupied_by: station.occupant.as_ref().map(|occupant| occupant.player_id),
                        completed_by: self
                            .join_order
                            .iter()
                            .filter(|player_id| {
                                self.players
                                    .get(player_id)
                                    .map(|player| {
                                        player.completed_puzzle_station_ids.contains(&station.id)
                                    })
                                    .unwrap_or(false)
                            })
                            .copied()
                            .collect::<Vec<_>>(),
                        projection: station.occupant.as_ref().map(|occupant| {
                            match &occupant.state {
                                ActivePuzzleState::Timer(timer) => PuzzleProjectionState::Timer {
                                    dial_angle: current_timer_angle(self.tick, timer),
                                    target_start: timer.target_start,
                                    target_size: TIMER_TARGET_SIZE,
                                },
                                ActivePuzzleState::Wires(wires) => PuzzleProjectionState::Wires {
                                    left_colors: wires.left_colors.to_vec(),
                                    right_colors: wires.right_colors.to_vec(),
                                    connected_pairs: wires.connected_pairs.clone(),
                                },
                            }
                        }),
                    })
                    .collect::<Vec<_>>(),
                active_sabotages: self.active_sabotages.clone(),
                meeting: self.meeting.as_ref().map(|meeting| MeetingSnapshot {
                    reported_body_id: meeting.reported_body_id,
                    started_at_tick: meeting.started_at_tick,
                    ends_at_tick: meeting.ends_at_tick,
                    votes_cast: meeting.votes.len(),
                    total_voters: self.count_alive_players(),
                    vote_counts: self.current_vote_counts(meeting),
                    chat: meeting.chat.clone(),
                }),
                win: self.win.clone(),
            },
        };

        let _ = self.event_tx.send(ServerEvent::Broadcast(payload));
    }

    fn current_sub_state(&self) -> GameSubState {
        // Keep lobby snapshots marked until the simulation enters the first live round.
        if matches!(self.phase, GamePhase::Lobby) {
            GameSubState::Lobby
        } else {
            GameSubState::InGame
        }
    }

    fn current_map_half_extent(&self) -> f32 {
        // Use the authored LDtk map extents for both lobby and active matches.
        self.lobby_map_half_extent
    }

    fn try_start_match(&mut self) {
        // Only lobby snapshots with enough players can own an active start countdown.
        if !matches!(self.phase, GamePhase::Lobby) || self.round_locked {
            self.lobby_countdown_ends_at_tick = None;
            return;
        }

        if self.players.len() < MIN_PLAYERS {
            self.lobby_countdown_ends_at_tick = None;
            return;
        }

        if self.lobby_countdown_ends_at_tick.is_none() {
            self.lobby_countdown_ends_at_tick =
                Some(self.tick + (self.tick_rate as u64 * LOBBY_COUNTDOWN_SECONDS));
        }

        if self.tick
            < self
                .lobby_countdown_ends_at_tick
                .expect("countdown just initialized")
        {
            return;
        }

        self.lobby_countdown_ends_at_tick = None;
        self.phase = GamePhase::Playing;
        self.dead_bodies.clear();
        self.active_sabotages.clear();
        self.meeting = None;
        self.ejection = None;
        self.win = None;
        for station in &mut self.puzzle_stations {
            station.occupant = None;
        }

        info!(
            tick = self.tick,
            player_count = self.players.len(),
            "SERVER STATE TRANSITION: game started (Lobby -> Playing)"
        );

        // Keep the first slice deterministic: use join order for role assignment.
        let role_ids = self.join_order.clone();
        for (index, player_id) in role_ids.into_iter().enumerate() {
            let role = if index == 0 {
                PlayerRole::Imposter
            } else if index == 1 {
                PlayerRole::Sheriff
            } else {
                PlayerRole::Crewmate
            };

            if let Some(player) = self.players.get_mut(&player_id) {
                player.role = role;
                player.state = PlayerState::Alive;
                player.kill_cooldown_ends_at_tick = 0;
                player.move_x = 0.0;
                player.move_z = 0.0;
                player.completed_puzzle_station_ids.clear();
            }

            info!(
                tick = self.tick,
                player_id = %player_id,
                role = ?role,
                "SERVER STATE: player assigned role"
            );

            let _ = self.event_tx.send(ServerEvent::Direct {
                to: player_id,
                message: ServerResponse::GameStarted { role },
            });
        }
    }

    fn resolve_meeting(&mut self) {
        let Some(meeting) = self.meeting.take() else {
            return;
        };

        let mut counts: HashMap<Option<Uuid>, usize> = HashMap::new();
        for vote in meeting.votes.values() {
            let key = match vote {
                VoteTarget::Player(player_id) => Some(*player_id),
                VoteTarget::Skip => None,
            };
            *counts.entry(key).or_insert(0) += 1;
        }

        let mut winner: Option<(Option<Uuid>, usize)> = None;
        let mut tied = false;
        for (target, count) in counts {
            match winner {
                None => winner = Some((target, count)),
                Some((_, best_count)) if count > best_count => {
                    winner = Some((target, count));
                    tied = false;
                }
                Some((_, best_count)) if count == best_count => {
                    tied = true;
                }
                _ => {}
            }
        }

        let ejected_player_id = if tied {
            None
        } else {
            winner.and_then(|(target, _)| target)
        };

        let was_imposter = ejected_player_id.and_then(|player_id| {
            self.players
                .get(&player_id)
                .map(|player| matches!(player.role, PlayerRole::Imposter))
        });

        if let Some(player_id) = ejected_player_id {
            if let Some(player) = self.players.get_mut(&player_id) {
                player.state = PlayerState::Ejected;
                player.move_x = 0.0;
                player.move_z = 0.0;
            }
        }

        self.phase = GamePhase::Ejection;
        self.ejection = Some(EjectionState {
            ends_at_tick: self.tick + (self.tick_rate as u64 * 5),
            ejected_player_id,
        });

        info!(
            tick = self.tick,
            phase = ?self.phase,
            ejected_player_id = ?ejected_player_id,
            was_imposter = ?was_imposter,
            "SERVER STATE TRANSITION: meeting resolved (Meeting -> Ejection)"
        );

        let _ = self
            .event_tx
            .send(ServerEvent::Broadcast(ServerResponse::EjectionResult {
                player_id: ejected_player_id,
                was_imposter,
            }));
    }

    fn current_vote_counts(&self, meeting: &MeetingState) -> Vec<MeetingVoteCount> {
        let mut counts: HashMap<Option<Uuid>, usize> = HashMap::new();
        for vote in meeting.votes.values() {
            let key = match vote {
                VoteTarget::Player(player_id) => Some(*player_id),
                VoteTarget::Skip => None,
            };
            *counts.entry(key).or_insert(0) += 1;
        }

        let mut result = counts
            .into_iter()
            .map(|(target, votes)| MeetingVoteCount { target, votes })
            .collect::<Vec<_>>();
        result.sort_by_key(|entry| {
            entry
                .target
                .map(|id| id.to_string())
                .unwrap_or_else(|| "skip".to_string())
        });
        result
    }

    fn advance_meeting_if_needed(&mut self) {
        let should_resolve = self
            .meeting
            .as_ref()
            .map(|meeting| self.tick >= meeting.ends_at_tick)
            .unwrap_or(false);

        if should_resolve {
            self.resolve_meeting();
        }
    }

    fn advance_ejection_if_needed(&mut self) {
        let Some(ejection) = self.ejection.clone() else {
            return;
        };

        if self.tick < ejection.ends_at_tick {
            return;
        }

        if let Some(player_id) = ejection.ejected_player_id {
            if let Some(player) = self.players.get_mut(&player_id) {
                player.state = PlayerState::Ghost;
            }
        }

        self.ejection = None;
        self.check_win_condition();

        self.phase = GamePhase::Playing;

        info!(
            tick = self.tick,
            phase = ?self.phase,
            "SERVER STATE TRANSITION: ejection ended (Ejection -> Playing)"
        );
    }

    fn expire_sabotages(&mut self) {
        self.active_sabotages
            .retain(|sabotage| sabotage.ends_at_tick > self.tick);
    }

    fn count_alive_players(&self) -> usize {
        self.players
            .values()
            .filter(|player| matches!(player.state, PlayerState::Alive))
            .count()
    }

    fn check_win_condition(&mut self) {
        if matches!(self.phase, GamePhase::Lobby) {
            return;
        }

        let total_task_players = self
            .players
            .values()
            .filter(|player| is_task_role(player.role))
            .count();
        let all_tasks_complete = total_task_players > 0
            && self
                .players
                .values()
                .filter(|player| is_task_role(player.role))
                .all(|player| {
                    player.completed_puzzle_station_ids.len() >= TOTAL_PUZZLES_PER_PLAYER
                });

        let alive_imposters = self
            .players
            .values()
            .filter(|player| {
                matches!(player.state, PlayerState::Alive)
                    && matches!(player.role, PlayerRole::Imposter)
            })
            .count();
        let alive_non_imposters = self
            .players
            .values()
            .filter(|player| {
                matches!(player.state, PlayerState::Alive)
                    && !matches!(player.role, PlayerRole::Imposter)
            })
            .count();

        let win = if all_tasks_complete {
            Some(WinMessage {
                winner: Faction::Crew,
                reason: "all_tasks_complete".to_string(),
            })
        } else if alive_imposters == 0 {
            Some(WinMessage {
                winner: Faction::Crew,
                reason: "all_imposters_ejected".to_string(),
            })
        } else if alive_imposters >= alive_non_imposters {
            Some(WinMessage {
                winner: Faction::Imposters,
                reason: "imposter_parity".to_string(),
            })
        } else {
            None
        };

        if let Some(win_message) = win {
            self.meeting = None;
            self.ejection = None;
            self.win = Some(win_message.clone());

            info!(
                tick = self.tick,
                winner = ?win_message.winner,
                reason = %win_message.reason,
                "SERVER STATE TRANSITION: game ended (win condition met)"
            );

            let _ = self
                .event_tx
                .send(ServerEvent::Broadcast(ServerResponse::Win {
                    winner: win_message.winner,
                    reason: win_message.reason,
                }));
            self.reset_to_lobby();
            self.round_locked = true;
        }
    }

    fn reset_to_lobby(&mut self) {
        // Clear the completed round so the next match can start from a clean lobby.
        self.phase = GamePhase::Lobby;
        self.lobby_countdown_ends_at_tick = None;
        self.meeting = None;
        self.ejection = None;
        self.win = None;
        self.dead_bodies.clear();
        self.active_sabotages.clear();
        for station in &mut self.puzzle_stations {
            station.occupant = None;
        }

        info!(
            tick = self.tick,
            player_count = self.players.len(),
            "SERVER STATE TRANSITION: reset to lobby"
        );

        // Restore every connected player to a fresh lobby state.
        for (index, player_id) in self.join_order.iter().copied().enumerate() {
            if let Some(player) = self.players.get_mut(&player_id) {
                let (spawn_x, spawn_z) = pick_spawn_position(index);
                player.x = spawn_x;
                player.z = spawn_z;
                player.move_x = 0.0;
                player.move_z = 0.0;
                player.last_seq = 0;
                player.role = PlayerRole::Crewmate;
                player.state = PlayerState::Alive;
                player.kill_cooldown_ends_at_tick = 0;
                player.completed_puzzle_station_ids.clear();
            }
        }
    }

    fn maybe_unlock_round(&mut self) {
        // Allow a fresh round only after the lobby has dropped below the minimum size again.
        if self.players.len() < MIN_PLAYERS {
            self.round_locked = false;
        }
    }
}

fn can_work_puzzles(player: &Player) -> bool {
    is_task_role(player.role) && matches!(player.state, PlayerState::Alive | PlayerState::Ghost)
}

fn is_task_role(role: PlayerRole) -> bool {
    matches!(role, PlayerRole::Crewmate | PlayerRole::Sheriff)
}

fn current_timer_angle(tick: u64, timer: &TimerPuzzleState) -> f32 {
    ((tick.saturating_sub(timer.started_at_tick) as f32) * TIMER_ROTATION_PER_TICK).rem_euclid(TAU)
}

fn angle_in_arc(angle: f32, arc_start: f32, arc_size: f32) -> bool {
    let normalized_angle = angle.rem_euclid(TAU);
    let normalized_start = arc_start.rem_euclid(TAU);
    let delta = (normalized_angle - normalized_start).rem_euclid(TAU);
    delta <= arc_size
}

fn pick_timer_target_start(station_id: Uuid, player_id: Uuid) -> f32 {
    // Derive a deterministic target arc from station and player ids so every session is authoritative.
    let seed = station_id.as_u128() ^ player_id.as_u128();
    ((seed % 360) as f32).to_radians()
}

fn create_wires_state(station_id: Uuid, player_id: Uuid) -> WiresPuzzleState {
    let right_colors = [
        WireColor::Red,
        WireColor::Blue,
        WireColor::Yellow,
        WireColor::Green,
    ];
    let mut left_colors = right_colors;
    let seed = (station_id.as_u128() ^ player_id.as_u128()) as usize;
    let len = left_colors.len();

    // Rotate and swap deterministically so each player gets a stable but shuffled wire layout.
    left_colors.rotate_left(seed % len);
    left_colors.swap(seed % len, (seed / len.max(1)) % len);

    WiresPuzzleState {
        left_colors,
        right_colors,
        connected_pairs: Vec::new(),
    }
}

fn create_puzzle_stations() -> Vec<PuzzleStation> {
    // Place every station within walkable cells of the authored LDtk layout.
    const LAYOUT: [(PuzzleKind, f32, f32); TOTAL_PUZZLES_PER_PLAYER] = [
        (PuzzleKind::Timer, -5.5, -4.5),
        (PuzzleKind::Wires, -2.5, -4.5),
        (PuzzleKind::Timer, 0.5, -4.5),
        (PuzzleKind::Wires, 3.5, -4.5),
        (PuzzleKind::Timer, -5.5, -0.5),
        (PuzzleKind::Wires, 3.5, -0.5),
        (PuzzleKind::Timer, -5.5, 3.5),
        (PuzzleKind::Wires, -2.5, 3.5),
        (PuzzleKind::Timer, 0.5, 3.5),
        (PuzzleKind::Wires, 3.5, 3.5),
    ];

    LAYOUT
        .into_iter()
        .enumerate()
        .map(|(index, (kind, x, z))| PuzzleStation {
            id: Uuid::from_u128((index + 1) as u128),
            kind,
            x,
            z,
            occupant: None,
        })
        .collect()
}

fn create_kiwi_borrows() -> Vec<KiwiBorrowSnapshot> {
    // Expose a small vent network that sits inside the LDtk walkable corridors.
    vec![
        KiwiBorrowSnapshot {
            id: Uuid::from_u128(101),
            x: -4.5,
            z: -2.0,
            links: vec![KiwiBorrowLink {
                direction: BorrowDirection::Right,
                borrow_id: Uuid::from_u128(102),
            }],
        },
        KiwiBorrowSnapshot {
            id: Uuid::from_u128(102),
            x: 1.0,
            z: -2.0,
            links: vec![
                KiwiBorrowLink {
                    direction: BorrowDirection::Left,
                    borrow_id: Uuid::from_u128(101),
                },
                KiwiBorrowLink {
                    direction: BorrowDirection::Down,
                    borrow_id: Uuid::from_u128(103),
                },
            ],
        },
        KiwiBorrowSnapshot {
            id: Uuid::from_u128(103),
            x: 1.0,
            z: 3.5,
            links: vec![KiwiBorrowLink {
                direction: BorrowDirection::Up,
                borrow_id: Uuid::from_u128(102),
            }],
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiple_players_move_and_sync_in_same_tick() {
        let (event_tx, mut event_rx) = broadcast::channel(16);
        let mut world = World::new(event_tx);
        world.phase = GamePhase::Playing;

        let player_ids = [Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4()];
        for (index, player_id) in player_ids.iter().copied().enumerate() {
            world.join_order.push(player_id);
            world.players.insert(
                player_id,
                Player {
                    id: player_id,
                    name: format!("Player-{index}"),
                    color: "#fff".to_string(),
                    x: 0.0,
                    z: 0.0,
                    facing_left: false,
                    move_x: 0.0,
                    move_z: 0.0,
                    last_seq: 0,
                    role: PlayerRole::Crewmate,
                    state: PlayerState::Alive,
                    kill_cooldown_ends_at_tick: 0,
                    completed_puzzle_station_ids: HashSet::new(),
                },
            );
        }

        world.handle_input(player_ids[0], 1, 1.0, 0.0);
        world.handle_input(player_ids[1], 1, 0.0, 1.0);
        world.handle_input(player_ids[2], 1, -1.0, 0.0);
        world.tick();
        world.sync();

        let event = event_rx.try_recv().expect("world snapshot broadcasted");
        let ServerEvent::Broadcast(ServerResponse::WorldSnapshot { snapshot }) = event else {
            panic!("expected world snapshot broadcast");
        };

        let players = snapshot
            .players
            .into_iter()
            .map(|player| (player.id, player))
            .collect::<HashMap<_, _>>();
        let distance_per_tick = MOVE_SPEED / TICK_RATE as f32;

        let east = players.get(&player_ids[0]).expect("east player present");
        assert!((east.x - distance_per_tick).abs() < f32::EPSILON);
        assert!(east.z.abs() < f32::EPSILON);
        assert_eq!(east.last_processed_seq, 1);

        let north = players.get(&player_ids[1]).expect("north player present");
        assert!(north.x.abs() < f32::EPSILON);
        assert!((north.z - distance_per_tick).abs() < f32::EPSILON);
        assert_eq!(north.last_processed_seq, 1);

        let west = players.get(&player_ids[2]).expect("west player present");
        assert!((west.x + distance_per_tick).abs() < f32::EPSILON);
        assert!(west.z.abs() < f32::EPSILON);
        assert_eq!(west.last_processed_seq, 1);
    }

    #[test]
    fn win_state_returns_to_lobby_without_restarting() {
        let (event_tx, _) = broadcast::channel(16);
        let mut world = World::new(event_tx);

        let player_id = Uuid::new_v4();
        world.join_order.push(player_id);
        world.players.insert(
            player_id,
            Player {
                id: player_id,
                name: "Player-1".to_string(),
                color: "#fff".to_string(),
                x: 10.0,
                z: -4.0,
                facing_left: false,
                move_x: 1.0,
                move_z: 1.0,
                last_seq: 12,
                role: PlayerRole::Imposter,
                state: PlayerState::Ghost,
                kill_cooldown_ends_at_tick: 99,
                completed_puzzle_station_ids: HashSet::new(),
            },
        );
        world.phase = GamePhase::Playing;
        world.dead_bodies.insert(
            Uuid::new_v4(),
            DeadBody {
                id: Uuid::new_v4(),
                player_id,
                x: 1.0,
                z: 2.0,
                reported: false,
            },
        );
        world.active_sabotages.push(ActiveSabotage {
            kind: SabotageKind::LightsOff,
            started_at_tick: 0,
            ends_at_tick: 10,
        });

        world.check_win_condition();

        assert_eq!(world.phase, GamePhase::Lobby);
        assert!(world.win.is_none());
        assert!(world.meeting.is_none());
        assert!(world.ejection.is_none());
        assert!(world.dead_bodies.is_empty());
        assert!(world.active_sabotages.is_empty());
        assert!(world.round_locked);

        let player = world.players.get(&player_id).expect("player still present");
        assert_eq!(player.role, PlayerRole::Crewmate);
        assert_eq!(player.state, PlayerState::Alive);
        assert_eq!(player.move_x, 0.0);
        assert_eq!(player.move_z, 0.0);
        assert_eq!(player.last_seq, 0);
        assert_eq!((player.x, player.z), pick_spawn_position(0));
    }

    #[test]
    fn lobby_countdown_waits_one_second_before_starting() {
        let (event_tx, _) = broadcast::channel(16);
        let mut world = World::new(event_tx);

        for index in 0..MIN_PLAYERS {
            let player_id = Uuid::new_v4();
            world.join_order.push(player_id);
            world.players.insert(
                player_id,
                Player {
                    id: player_id,
                    name: format!("Player-{index}"),
                    color: "#fff".to_string(),
                    x: 0.0,
                    z: 0.0,
                    facing_left: false,
                    move_x: 0.0,
                    move_z: 0.0,
                    last_seq: 0,
                    role: PlayerRole::Crewmate,
                    state: PlayerState::Alive,
                    kill_cooldown_ends_at_tick: 0,
                    completed_puzzle_station_ids: HashSet::new(),
                },
            );
        }

        world.try_start_match();
        assert_eq!(world.phase, GamePhase::Lobby);
        assert_eq!(
            world.lobby_countdown_ends_at_tick,
            Some(world.tick + (world.tick_rate as u64 * LOBBY_COUNTDOWN_SECONDS))
        );

        world.tick = world
            .lobby_countdown_ends_at_tick
            .expect("countdown present")
            - 1;
        world.try_start_match();
        assert_eq!(world.phase, GamePhase::Lobby);

        world.tick += 1;
        world.try_start_match();
        assert_eq!(world.phase, GamePhase::Playing);
        assert!(world.lobby_countdown_ends_at_tick.is_none());
    }

    #[test]
    fn lobby_countdown_clears_when_lobby_drops_below_minimum() {
        let (event_tx, _) = broadcast::channel(16);
        let mut world = World::new(event_tx);

        world.lobby_countdown_ends_at_tick = Some(42);
        world.players.insert(
            Uuid::new_v4(),
            Player {
                id: Uuid::new_v4(),
                name: "Player-0".to_string(),
                color: "#fff".to_string(),
                x: 0.0,
                z: 0.0,
                facing_left: false,
                move_x: 0.0,
                move_z: 0.0,
                last_seq: 0,
                role: PlayerRole::Crewmate,
                state: PlayerState::Alive,
                kill_cooldown_ends_at_tick: 0,
                completed_puzzle_station_ids: HashSet::new(),
            },
        );

        world.try_start_match();
        assert_eq!(world.phase, GamePhase::Lobby);
        assert!(world.lobby_countdown_ends_at_tick.is_none());
    }

    #[test]
    fn kill_turns_victim_into_ghost_and_sets_snapshot_cooldown() {
        let (event_tx, mut event_rx) = broadcast::channel(16);
        let mut world = World::new(event_tx);

        let killer_id = Uuid::new_v4();
        let victim_id = Uuid::new_v4();
        let witness_id = Uuid::new_v4();
        let witness_two_id = Uuid::new_v4();
        world.phase = GamePhase::Playing;
        world.join_order.push(killer_id);
        world.join_order.push(victim_id);
        world.join_order.push(witness_id);
        world.join_order.push(witness_two_id);
        world.players.insert(
            killer_id,
            Player {
                id: killer_id,
                name: "RED".to_string(),
                color: "#ef4444".to_string(),
                x: 0.0,
                z: 0.0,
                facing_left: false,
                move_x: 0.0,
                move_z: 0.0,
                last_seq: 0,
                role: PlayerRole::Imposter,
                state: PlayerState::Alive,
                kill_cooldown_ends_at_tick: 0,
                completed_puzzle_station_ids: HashSet::new(),
            },
        );
        world.players.insert(
            victim_id,
            Player {
                id: victim_id,
                name: "BLUE".to_string(),
                color: "#3b82f6".to_string(),
                x: 1.0,
                z: 1.0,
                facing_left: false,
                move_x: 0.5,
                move_z: 0.5,
                last_seq: 0,
                role: PlayerRole::Crewmate,
                state: PlayerState::Alive,
                kill_cooldown_ends_at_tick: 0,
                completed_puzzle_station_ids: HashSet::new(),
            },
        );
        world.players.insert(
            witness_id,
            Player {
                id: witness_id,
                name: "GREEN".to_string(),
                color: "#22c55e".to_string(),
                x: 8.0,
                z: 8.0,
                facing_left: false,
                move_x: 0.0,
                move_z: 0.0,
                last_seq: 0,
                role: PlayerRole::Crewmate,
                state: PlayerState::Alive,
                kill_cooldown_ends_at_tick: 0,
                completed_puzzle_station_ids: HashSet::new(),
            },
        );
        world.players.insert(
            witness_two_id,
            Player {
                id: witness_two_id,
                name: "YELLOW".to_string(),
                color: "#eab308".to_string(),
                x: -8.0,
                z: 8.0,
                facing_left: false,
                move_x: 0.0,
                move_z: 0.0,
                last_seq: 0,
                role: PlayerRole::Crewmate,
                state: PlayerState::Alive,
                kill_cooldown_ends_at_tick: 0,
                completed_puzzle_station_ids: HashSet::new(),
            },
        );

        world.handle_kill(killer_id, victim_id);

        let victim = world.players.get(&victim_id).expect("victim present");
        assert_eq!(victim.state, PlayerState::Ghost);
        assert_eq!(victim.move_x, 0.0);
        assert_eq!(victim.move_z, 0.0);
        assert_eq!(world.dead_bodies.len(), 1);

        let killer = world.players.get(&killer_id).expect("killer present");
        assert_eq!(
            killer.kill_cooldown_ends_at_tick,
            world.tick + (world.tick_rate as u64 * 30)
        );

        world.sync();

        let ServerEvent::Broadcast(ServerResponse::WorldSnapshot { snapshot }) =
            event_rx.try_recv().expect("world snapshot broadcasted")
        else {
            panic!("expected world snapshot event");
        };

        let snapshot_killer = snapshot
            .players
            .iter()
            .find(|player| player.id == killer_id)
            .expect("killer in snapshot");
        let snapshot_victim = snapshot
            .players
            .iter()
            .find(|player| player.id == victim_id)
            .expect("victim in snapshot");

        assert_eq!(snapshot_victim.state, PlayerState::Ghost);
        assert_eq!(snapshot.dead_bodies.len(), 1);
        assert_eq!(snapshot_killer.kill_cooldown_ends_at, 30_000);
    }

    #[test]
    fn timer_puzzle_tap_completes_station_for_player() {
        let (event_tx, _) = broadcast::channel(16);
        let mut world = World::new(event_tx);
        let player_id = Uuid::new_v4();
        let station_id = world.puzzle_stations[0].id;

        world.players.insert(
            player_id,
            Player {
                id: player_id,
                name: "Crewmate".to_string(),
                color: "#fff".to_string(),
                x: world.puzzle_stations[0].x,
                z: world.puzzle_stations[0].z,
                facing_left: false,
                move_x: 0.0,
                move_z: 0.0,
                last_seq: 0,
                role: PlayerRole::Crewmate,
                state: PlayerState::Alive,
                kill_cooldown_ends_at_tick: 0,
                completed_puzzle_station_ids: HashSet::new(),
            },
        );
        world.phase = GamePhase::Playing;
        world.puzzle_stations[0].occupant = Some(PuzzleOccupant {
            player_id,
            state: ActivePuzzleState::Timer(TimerPuzzleState {
                started_at_tick: 0,
                target_start: 0.0,
            }),
        });

        world.handle_puzzle_tap(player_id);

        assert!(
            world
                .players
                .get(&player_id)
                .expect("player present")
                .completed_puzzle_station_ids
                .contains(&station_id)
        );
        assert!(world.puzzle_stations[0].occupant.is_none());
    }

    #[test]
    fn all_completed_tasks_emit_crew_win() {
        let (event_tx, _) = broadcast::channel(16);
        let mut event_rx = event_tx.subscribe();
        let mut world = World::new(event_tx);
        let completed_ids = world
            .puzzle_stations
            .iter()
            .map(|station| station.id)
            .collect::<HashSet<_>>();

        let crew_id = Uuid::new_v4();
        let imposter_id = Uuid::new_v4();
        world.join_order.push(crew_id);
        world.join_order.push(imposter_id);
        world.players.insert(
            crew_id,
            Player {
                id: crew_id,
                name: "Crewmate".to_string(),
                color: "#fff".to_string(),
                x: 0.0,
                z: 0.0,
                facing_left: false,
                move_x: 0.0,
                move_z: 0.0,
                last_seq: 0,
                role: PlayerRole::Crewmate,
                state: PlayerState::Alive,
                kill_cooldown_ends_at_tick: 0,
                completed_puzzle_station_ids: completed_ids,
            },
        );
        world.players.insert(
            imposter_id,
            Player {
                id: imposter_id,
                name: "Imposter".to_string(),
                color: "#f00".to_string(),
                x: 4.0,
                z: 0.0,
                facing_left: false,
                move_x: 0.0,
                move_z: 0.0,
                last_seq: 0,
                role: PlayerRole::Imposter,
                state: PlayerState::Alive,
                kill_cooldown_ends_at_tick: 0,
                completed_puzzle_station_ids: HashSet::new(),
            },
        );
        world.phase = GamePhase::Playing;

        world.check_win_condition();

        let win_event = event_rx
            .try_recv()
            .expect("win event should be broadcast after all tasks complete");
        match win_event {
            ServerEvent::Broadcast(ServerResponse::Win { winner, reason }) => {
                assert_eq!(winner, Faction::Crew);
                assert_eq!(reason, "all_tasks_complete");
            }
            other => panic!("unexpected event: {other:?}"),
        }
        assert_eq!(world.phase, GamePhase::Lobby);
        assert!(world.round_locked);
    }

    #[test]
    fn lobby_movement_stops_at_ldtk_walls() {
        let (event_tx, _) = broadcast::channel(16);
        let mut world = World::new(event_tx);
        let player_id = Uuid::new_v4();

        world.join_order.push(player_id);
        world.players.insert(
            player_id,
            Player {
                id: player_id,
                name: "Player-0".to_string(),
                color: "#fff".to_string(),
                x: -5.2,
                z: -6.5,
                facing_left: false,
                move_x: 1.0,
                move_z: 0.0,
                last_seq: 0,
                role: PlayerRole::Crewmate,
                state: PlayerState::Alive,
                kill_cooldown_ends_at_tick: 0,
                completed_puzzle_station_ids: HashSet::new(),
            },
        );
        world.phase = GamePhase::Lobby;

        world.tick();

        let player = world.players.get(&player_id).expect("player present");
        assert!(player.x <= -5.0, "player should stop before the wall, got x={}", player.x);
    }
}

fn distance_sq(ax: f32, az: f32, bx: f32, bz: f32) -> f32 {
    let dx = ax - bx;
    let dz = az - bz;
    (dx * dx) + (dz * dz)
}

fn resolve_position_for_phase(
    current_x: f32,
    current_z: f32,
    target_x: f32,
    target_z: f32,
    map_half_extent: f32,
    lobby_collision: &LobbyCollisionMap,
) -> (f32, f32) {
    let clamped_target_x = target_x.clamp(-map_half_extent, map_half_extent);
    let clamped_target_z = target_z.clamp(-map_half_extent, map_half_extent);

    // Resolve one axis at a time so players can still slide against authored LDtk walls.
    let mut next_x = current_x;
    let mut next_z = current_z;
    if !lobby_cell_is_solid(lobby_collision, clamped_target_x, current_z) {
        next_x = clamped_target_x;
    }
    if !lobby_cell_is_solid(lobby_collision, next_x, clamped_target_z) {
        next_z = clamped_target_z;
    }
    (next_x, next_z)
}

fn lobby_cell_is_solid(collision: &LobbyCollisionMap, x: f32, z: f32) -> bool {
    const PLAYER_HALF_EXTENT: f32 = 0.375;

    let min_cell_x = ((x - PLAYER_HALF_EXTENT) + collision.half_width).floor() as isize;
    let max_cell_x = ((x + PLAYER_HALF_EXTENT) + collision.half_width).floor() as isize;
    let min_cell_z = ((z - PLAYER_HALF_EXTENT) + collision.half_height).floor() as isize;
    let max_cell_z = ((z + PLAYER_HALF_EXTENT) + collision.half_height).floor() as isize;

    for cell_z in min_cell_z..=max_cell_z {
        for cell_x in min_cell_x..=max_cell_x {
            if cell_x < 0
                || cell_z < 0
                || cell_x >= collision.width as isize
                || cell_z >= collision.height as isize
            {
                return true;
            }

            if collision.solid[(cell_z as usize * collision.width) + cell_x as usize] {
                return true;
            }
        }
    }

    false
}

fn load_lobby_collision_map() -> LobbyCollisionMap {
    let project: LdtkProject =
        serde_json::from_str(LOBBY_LDTK_JSON).expect("lobby LDtk must deserialize");
    let level = project
        .levels
        .into_iter()
        .next()
        .expect("lobby LDtk must contain one level");
    let level_width = level.px_wid;
    let level_height = level.px_hei;
    let collisions = level
        .layer_instances
        .into_iter()
        .find(|layer| layer.identifier == "Collisions")
        .expect("lobby LDtk must contain collisions layer");
    let width = if collisions.width > 0 {
        collisions.width
    } else {
        (level_width / collisions.grid_size) as usize
    };
    let height = if collisions.height > 0 {
        collisions.height
    } else {
        (level_height / collisions.grid_size) as usize
    };

    LobbyCollisionMap {
        width,
        height,
        half_width: width as f32 / 2.0,
        half_height: height as f32 / 2.0,
        solid: collisions
            .int_grid_csv
            .into_iter()
            .map(|value| value != 0)
            .collect(),
    }
}

fn facing_yaw_from_movement(move_x: f32, move_z: f32) -> f32 {
    move_x.atan2(move_z)
}

fn pick_player_color(index: usize) -> (&'static str, &'static str) {
    // Use bright pastel colors so players stay readable and vibrant in-game.
    const COLORS: [(&str, &str); 6] = [
        ("RED", "#fb7185"),
        ("BLUE", "#60a5fa"),
        ("GREEN", "#4ade80"),
        ("YELLOW", "#fde047"),
        ("PURPLE", "#c084fc"),
        ("ORANGE", "#fdba74"),
    ];
    COLORS[index % COLORS.len()]
}

fn pick_spawn_position(index: usize) -> (f32, f32) {
    const SPAWNS: [(f32, f32); 10] = [
        (0.0, 0.0),
        (4.0, 0.0),
        (-4.0, 0.0),
        (0.0, 4.0),
        (0.0, -4.0),
        (6.0, 3.0),
        (-6.0, 3.0),
        (6.0, -3.0),
        (-6.0, -3.0),
        (0.0, 7.0),
    ];
    SPAWNS[index % SPAWNS.len()]
}
