//! Runs the acct server inside a desktop app, on the app's async runtime.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use acct_server::AppState;
use acct_store::Store;
use tokio::sync::oneshot;

/// A server running in this process. Dropping it stops the server.
pub struct RunningServer {
    /// Where it's listening. With an unspecified bind address (`0.0.0.0`), this is too.
    pub addr: SocketAddr,
    pub store: Arc<Store>,
    stop: Option<oneshot::Sender<()>>,
}

impl RunningServer {
    /// The URL this computer uses to reach the server.
    pub fn local_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.addr.port())
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

/// Opens (creating if need be) the database at `db` and serves it on `bind`.
pub async fn start(db: &Path, bind: SocketAddr) -> Result<RunningServer, String> {
    if let Some(dir) = db.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    }
    let store = Store::open(db)
        .await
        .map_err(|e| format!("Couldn't open the database {}: {e}", db.display()))?;
    start_with(Arc::new(store), bind).await
}

/// Serves an already-open store on `bind`.
pub async fn start_with(store: Arc<Store>, bind: SocketAddr) -> Result<RunningServer, String> {
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| format!("Couldn't listen on {bind}: {e}. Is another acct master running?"))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let (stop, stopped) = oneshot::channel::<()>();
    let state = AppState {
        store: store.clone(),
    };
    tokio::spawn(async move {
        let shutdown = async {
            let _ = stopped.await;
        };
        if let Err(e) = acct_server::serve(listener, state, shutdown).await {
            tracing::error!("the acct server stopped: {e}");
        }
    });
    tracing::info!("acct server listening on http://{addr}");
    Ok(RunningServer {
        addr,
        store,
        stop: Some(stop),
    })
}

/// Whether the practice has been set up (`initialise` has run).
pub async fn is_initialised(store: &Store) -> Result<bool, String> {
    let mut conn = store.reader().await.map_err(|e| e.to_string())?;
    let practice = acct_store::practice::get(&mut conn)
        .await
        .map_err(|e| e.to_string())?;
    Ok(practice.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::check_master;

    #[tokio::test]
    async fn a_started_server_answers_health_and_serves_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let server = start(&dir.path().join("acct.db"), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap();
        assert!(!is_initialised(&server.store).await.unwrap());

        let health = check_master(&server.local_url()).await.unwrap();
        assert_eq!(health.version, crate::VERSION);
        let index = reqwest::get(format!("{}/", server.local_url()))
            .await
            .unwrap();
        assert_eq!(index.status(), 200);
        assert!(index.text().await.unwrap().contains("<div id=\"root\">"));

        let url = server.local_url();
        drop(server);
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(check_master(&url).await.is_err());
    }
}
