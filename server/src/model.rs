pub enum RequestModel {
    Join,
    UpdatePosition(Position),
}
pub struct Position {
    x: f32,
    y: f32,
}
