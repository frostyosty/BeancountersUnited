//! `acctd`: serves the API. `acctd init` sets up a new server's practice and first master user.

use std::io::{BufRead, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use acct_server::AppState;
use acct_server::commands::{Command, CommandEnvelope};
use acct_server::pipeline::{self, Actor};
use acct_store::Store;
use acct_store::users::Role;
use tracing_subscriber::EnvFilter;

const DEFAULT_BIND: &str = "127.0.0.1:8080";
const DEFAULT_DB: &str = "data/acct.db";

type BoxError = Box<dyn std::error::Error>;

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let db = PathBuf::from(std::env::var("ACCT_DB").unwrap_or_else(|_| DEFAULT_DB.to_owned()));
    if let Some(dir) = db.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let store = Store::open(&db).await?;

    match std::env::args().nth(1).as_deref() {
        None => serve(store).await,
        Some("init") => init(&store).await,
        Some(other) => {
            Err(format!("unknown command {other:?}; try `acctd` or `acctd init`").into())
        }
    }
}

async fn serve(store: Store) -> Result<(), BoxError> {
    let bind: SocketAddr = std::env::var("ACCT_BIND")
        .unwrap_or_else(|_| DEFAULT_BIND.to_owned())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("acctd listening on http://{bind}");

    let state = AppState {
        store: Arc::new(store),
    };
    acct_server::serve(listener, state, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}

/// Asks for the practice name and the first master user's details, then submits them as the
/// `initialise` command. Only works on a server that hasn't been set up.
async fn init(store: &Store) -> Result<(), BoxError> {
    println!("Setting up a new acct server. The first user is a master user.");
    let practice_name = ask("Practice name: ")?;
    let username = ask("Username: ")?;
    let display_name = ask("Full name: ")?;
    let password = rpassword::prompt_password("Password: ")?;
    if rpassword::prompt_password("Password again: ")? != password {
        return Err("the passwords don't match; nothing was saved".into());
    }
    let envelope = CommandEnvelope {
        id: uuid::Uuid::now_v7().to_string(),
        command: Command::Initialise {
            practice_name,
            username,
            display_name,
            password,
        },
    };
    let system = Actor {
        user_id: None,
        role: Role::Master,
    };
    match pipeline::submit(store, &system, envelope, chrono::Utc::now()).await {
        Ok(_) => {
            println!("Done. Start the server with `acctd` and log in.");
            Ok(())
        }
        Err(e) => Err(e.body().message.into()),
    }
}

fn ask(prompt: &str) -> Result<String, BoxError> {
    print!("{prompt}");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().lock().read_line(&mut line)?;
    Ok(line.trim().to_owned())
}
