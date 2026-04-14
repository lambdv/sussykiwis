use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let addr = "127.0.0.1:3000".to_string();
    let listener = tokio::net::TcpListener::bind(addr.clone()).await?;
    info!(%addr, "server listening");

    let app = myserver::get_app();
    axum::serve(listener, app).await?;
    Ok(())
}
