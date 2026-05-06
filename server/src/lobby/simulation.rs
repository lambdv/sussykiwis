/// Simulates the authoritative game world.
use std::collections::HashMap;
use std::time::Duration;

use tokio::sync::{broadcast, mpsc};
use tokio::time;
use tracing::{debug, info};
use uuid::Uuid;

use crate::lobby::networking::model::{
    ActiveSabotage, Faction, GamePhase, GameSubState, MeetingChatMessage, MeetingSnapshot,
    MeetingVoteCount, PlayerRole, PlayerState, SabotageKind, ServerEvent, ServerResponse,
    SnapshotDeadBody, SnapshotPlayer, WinMessage, WorldSnapshot,
};

const MIN_PLAYERS: usize = 4;
const KILL_RANGE: f32 = 4.0;
const REPORT_RANGE: f32 = 4.0;
pub const TICK_RATE: u32 = 20;
pub const MOVE_SPEED: f32 = 10.0;

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
}

#[derive(Clone)]
struct Player {
    id: Uuid,
    name: String,
    color: String,
    x: f32,
    z: f32,
    move_x: f32,
    move_z: f32,
    last_seq: u32,
    role: PlayerRole,
    state: PlayerState,
    kill_cooldown_ends_at_tick: u64,
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
    active_sabotages: Vec<ActiveSabotage>,
    phase: GamePhase,
    meeting: Option<MeetingState>,
    ejection: Option<EjectionState>,
    win: Option<WinMessage>,
    tick: u64,
    tick_rate: u32,
    move_speed: f32,
    map_half_extent: f32,
    event_tx: broadcast::Sender<ServerEvent>,
}

impl World {
    pub fn new(event_tx: broadcast::Sender<ServerEvent>) -> Self {
        Self {
            players: HashMap::new(),
            join_order: Vec::new(),
            dead_bodies: HashMap::new(),
            active_sabotages: Vec::new(),
            phase: GamePhase::Lobby,
            meeting: None,
            ejection: None,
            win: None,
            tick: 0,
            tick_rate: TICK_RATE,
            move_speed: MOVE_SPEED,
            map_half_extent: 60.0,
            event_tx,
        }
    }

    /// Advances the world by one fixed simulation tick.
    pub fn tick(&mut self) {
        self.tick += 1;

        // Allow movement in pre-match lobby and active gameplay phases.
        if matches!(self.phase, GamePhase::Lobby | GamePhase::Playing) {
            let dt = 1.0 / self.tick_rate as f32;

            // Integrate the latest input for movable player states.
            for player in self.players.values_mut() {
                if !matches!(player.state, PlayerState::Alive | PlayerState::Ghost) {
                    continue;
                }

                player.x += player.move_x * self.move_speed * dt;
                player.z += player.move_z * self.move_speed * dt;
                player.x = player.x.clamp(-self.map_half_extent, self.map_half_extent);
                player.z = player.z.clamp(-self.map_half_extent, self.map_half_extent);
            }
        }

        self.expire_sabotages();
        self.advance_meeting_if_needed();
        self.advance_ejection_if_needed();

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
        }
    }

    fn handle_join(&mut self, id: Uuid, name: String) {
        let color = pick_player_color(self.players.len());
        let (spawn_x, spawn_z) = pick_spawn_position(self.join_order.len());

        // Spawn the player into the lobby with no role until the match starts.
        let player = Player {
            id,
            name: name.clone(),
            color: color.clone(),
            x: spawn_x,
            z: spawn_z,
            move_x: 0.0,
            move_z: 0.0,
            last_seq: 0,
            role: PlayerRole::Crewmate,
            state: PlayerState::Alive,
            kill_cooldown_ends_at_tick: 0,
        };

        self.players.insert(id, player);
        self.join_order.push(id);

        info!(
            player_id = %id,
            player_name = %name,
            color = %color,
            player_count = self.players.len(),
            "SERVER STATE TRANSITION: player joined"
        );

        let _ = self.event_tx.send(ServerEvent::Direct {
            to: id,
            message: ServerResponse::Welcome {
                player_id: id,
                name,
                tick_rate: self.tick_rate,
                move_speed: self.move_speed,
                observer: false,
            },
        });

        self.try_start_match();
    }

    fn handle_leave(&mut self, id: Uuid) {
        self.players.remove(&id);
        self.join_order.retain(|player_id| *player_id != id);

        // Drop votes from disconnected players so meetings can still resolve.
        if let Some(meeting) = self.meeting.as_mut() {
            meeting.votes.remove(&id);
        }

        info!(
            player_id = %id,
            player_count = self.players.len(),
            "SERVER STATE TRANSITION: player left"
        );

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

        if body.reported || distance_sq(actor.x, actor.z, body.x, body.z) > REPORT_RANGE * REPORT_RANGE {
            return;
        }

        if let Some(body_state) = self.dead_bodies.get_mut(&body_id) {
            body_state.reported = true;
        }

        // Freeze the match into a meeting until votes resolve or the timer expires.
        let ends_at_tick = self.tick + (self.tick_rate as u64 * 20);
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

        let _ = self.event_tx.send(ServerEvent::Broadcast(ServerResponse::MeetingChat {
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
        if self.active_sabotages.iter().any(|sabotage| sabotage.kind == kind) {
            return;
        }

        self.active_sabotages.push(ActiveSabotage {
            kind,
            started_at_tick: self.tick,
            ends_at_tick: self.tick + (self.tick_rate as u64 * 10),
        });
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
                expected_players: MIN_PLAYERS,
                players: self
                    .players
                    .values()
                    .map(|player| SnapshotPlayer {
                        id: player.id,
                        name: player.name.clone(),
                        color: player.color.clone(),
                        x: player.x,
                        z: player.z,
                        state: player.state,
                        last_processed_seq: player.last_seq,
                    })
                    .collect::<Vec<_>>(),
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

    fn try_start_match(&mut self) {
        if !matches!(self.phase, GamePhase::Lobby) || self.players.len() < MIN_PLAYERS {
            return;
        }

        self.phase = GamePhase::Playing;
        self.dead_bodies.clear();
        self.active_sabotages.clear();
        self.meeting = None;
        self.ejection = None;
        self.win = None;

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
            }

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
        result.sort_by_key(|entry| entry.target.map(|id| id.to_string()).unwrap_or_else(|| "skip".to_string()));
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

        if !matches!(self.phase, GamePhase::Win) {
            self.phase = GamePhase::Playing;
        }
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
        if matches!(self.phase, GamePhase::Lobby | GamePhase::Win) {
            return;
        }

        let alive_imposters = self
            .players
            .values()
            .filter(|player| {
                matches!(player.state, PlayerState::Alive) && matches!(player.role, PlayerRole::Imposter)
            })
            .count();
        let alive_non_imposters = self
            .players
            .values()
            .filter(|player| {
                matches!(player.state, PlayerState::Alive) && !matches!(player.role, PlayerRole::Imposter)
            })
            .count();

        let win = if alive_imposters == 0 {
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
            self.phase = GamePhase::Win;
            self.meeting = None;
            self.ejection = None;
            self.win = Some(win_message.clone());
            let _ = self
                .event_tx
                .send(ServerEvent::Broadcast(ServerResponse::Win {
                    winner: win_message.winner,
                    reason: win_message.reason,
                }));
        }
    }
}

fn distance_sq(ax: f32, az: f32, bx: f32, bz: f32) -> f32 {
    let dx = ax - bx;
    let dz = az - bz;
    (dx * dx) + (dz * dz)
}

fn pick_player_color(index: usize) -> String {
    // Cycle through a fixed palette so clients can distinguish players.
    const COLORS: [&str; 6] = ["#ebb0ff", "#8fd3ff", "#ffd37a", "#9cffb0", "#ff9aa2", "#c7b8ff"];
    COLORS[index % COLORS.len()].to_string()
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
