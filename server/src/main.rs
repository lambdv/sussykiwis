use myserver::{start_server, Config};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    start_server(Config {
        port: 8080,
        tick_rate: 30,
    })
    .await
}