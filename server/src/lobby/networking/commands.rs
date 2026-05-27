use axum::extract::ws::Message;
use futures_util::SinkExt;
use uuid::Uuid;

use crate::lobby::networking::model::{ClientRequest, ServerResponse};
use crate::lobby::simulation::{GameCommand, VoteTarget};

/// Maps a validated client request to a game command for the simulation loop.
/// Returns None for requests that are handled directly (Join, ClientLog).
pub fn request_to_command(id: Uuid, request: ClientRequest) -> Option<GameCommand> {
    match request {
        ClientRequest::Input {
            seq,
            move_x,
            move_y,
        } => Some(GameCommand::PlayerInput {
            id,
            seq,
            move_x,
            move_z: move_y,
        }),
        ClientRequest::Kill { target_id } => Some(GameCommand::Kill { id, target_id }),
        ClientRequest::ReportBody { body_id } => Some(GameCommand::ReportBody { id, body_id }),
        ClientRequest::Vote { target } => {
            parse_vote_target(&target).map(|target| GameCommand::Vote { id, target })
        }
        ClientRequest::MeetingChat { message } => Some(GameCommand::MeetingChat { id, message }),
        ClientRequest::Sabotage { kind } => Some(GameCommand::Sabotage { id, kind }),
        ClientRequest::StartPuzzle { station_id } => {
            Some(GameCommand::StartPuzzle { id, station_id })
        }
        ClientRequest::CancelPuzzle => Some(GameCommand::CancelPuzzle { id }),
        ClientRequest::PuzzleTap => Some(GameCommand::PuzzleTap { id }),
        ClientRequest::PuzzleSolved => Some(GameCommand::PuzzleSolved { id }),
        ClientRequest::PuzzleConnect {
            from_index,
            to_index,
        } => Some(GameCommand::PuzzleConnect {
            id,
            from_index,
            to_index,
        }),
        ClientRequest::EnterBorrow { borrow_id } => Some(GameCommand::EnterBorrow { id, borrow_id }),
        ClientRequest::TraverseBorrow { direction } => {
            Some(GameCommand::TraverseBorrow { id, direction })
        }
        ClientRequest::ExitBorrow => Some(GameCommand::ExitBorrow { id }),
        ClientRequest::Join { .. } | ClientRequest::ClientLog { .. } => None,
    }
}

fn parse_vote_target(raw: &str) -> Option<VoteTarget> {
    if raw == "skip" {
        return Some(VoteTarget::Skip);
    }
    Uuid::parse_str(raw).ok().map(VoteTarget::Player)
}

/// Serializes and sends one server message to a websocket sink.
pub async fn send_message(
    sender: &mut futures_util::stream::SplitSink<axum::extract::ws::WebSocket, Message>,
    message: &ServerResponse,
) -> Result<(), axum::Error> {
    let payload = serde_json::to_string(message).expect("server response must serialize");
    sender.send(Message::Text(payload.into())).await
}
