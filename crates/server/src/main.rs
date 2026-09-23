use std::net::SocketAddr;

use tracing_subscriber::EnvFilter;

const DEFAULT_BIND: &str = "127.0.0.1:8080";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let bind: SocketAddr = std::env::var("ACCT_BIND")
        .unwrap_or_else(|_| DEFAULT_BIND.to_owned())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("acctd listening on http://{bind}");

    axum::serve(listener, acct_server::app())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
