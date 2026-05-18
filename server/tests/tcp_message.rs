use axum_test::TestServer;
use myserver;

#[tokio::test]
async fn tcp_ping_pong() {
    let app = myserver::get_app();

    let server = TestServer::new(app);

    server
        .get("/ping")
        .await
        .assert_json(&serde_json::json!({ "message": "pong" }));
}
