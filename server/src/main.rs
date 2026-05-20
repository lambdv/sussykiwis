use myserver::{Config, start_server};

fn load_env() {
    // Load environment variables from `.env` if present. Ignore errors.
    dotenvy::dotenv().ok();
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    load_env();

    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("PORT")
        .unwrap_or_else(|_| "3000".to_string())
        .parse::<u16>()?;

    start_server(Config {
        host,
        port,
        tick_rate: 30,
    })
    .await
}
