#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "127.0.0.1:3000".to_string();
    let listener = tokio::net::TcpListener::bind(addr.clone()).await?;
    println!("Listening on port: {addr}");
    let app = myserver::get_app();
    axum::serve(listener, app).await?;
    Ok(())
}
