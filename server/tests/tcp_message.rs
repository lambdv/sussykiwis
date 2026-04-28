use axum_test::TestServer;
use myserver;

#[tokio::test]
async fn tcp_ping_pong() {
    let app = myserver::get_app();

    let server = TestServer::new(app);

    let response = server.get("/ping").await;
    response.assert_status_ok();
    response.assert_text("pong");
}
