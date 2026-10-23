//! `acctd`: serves the API. `acctd init` sets up a new server's practice and first practice admin.
//! `acctd add-overseer` adds an overseer (us, running the service: every business and every view).
//! `acctd ai-eval [file]` runs the configured AI provider over the labelled set (ADR 009).
//! `acctd backup <path>` and `acctd restore-check <path>` are the backup and restore drill
//! (docs/operations.md).

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

    if std::env::args().nth(1).as_deref() == Some("ai-eval") {
        return ai_eval(std::env::args().nth(2)).await;
    }

    let db = PathBuf::from(std::env::var("ACCT_DB").unwrap_or_else(|_| DEFAULT_DB.to_owned()));

    // These open their own read-only connection, so they work beside a running server and never
    // create or migrate a database.
    match std::env::args().nth(1).as_deref() {
        Some("backup") => return backup(&db, std::env::args().nth(2)).await,
        Some("restore-check") => return restore_check(std::env::args().nth(2)).await,
        _ => {}
    }

    if let Some(dir) = db.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let store = Store::open(&db).await?;

    match std::env::args().nth(1).as_deref() {
        None => serve(store).await,
        Some("init") => init(&store).await,
        Some("add-overseer") => add_overseer(&store).await,
        Some(other) => Err(format!(
            "unknown command {other:?}; try `acctd`, `acctd init`, `acctd add-overseer`,              `acctd backup <path>`, `acctd restore-check <path>` or `acctd ai-eval`"
        )
        .into()),
    }
}

/// `acctd backup <path>`: copies the database at `ACCT_DB` to `path` with `VACUUM INTO`. Safe
/// while the server is running. Never overwrites a file.
async fn backup(db: &std::path::Path, dest: Option<String>) -> Result<(), BoxError> {
    use acct_store::sqlx::Connection;

    let dest = PathBuf::from(dest.ok_or("usage: acctd backup <path>")?);
    // `main` prints errors with `Debug`, so turn ours into their readable message first.
    let mut conn = acct_store::backup::open_read_only(db)
        .await
        .map_err(|e| e.to_string())?;
    let seq = acct_store::backup::backup_into(&mut conn, &dest)
        .await
        .map_err(|e| e.to_string())?;
    conn.close().await?;
    println!("Backed up {} to {}", db.display(), dest.display());
    println!("latest seq: {seq}");
    Ok(())
}

/// `acctd restore-check <path>`: opens a database (a backup, or the live one) read-only and prints
/// what the restore drill compares: the latest seq, the number of commands and a SHA-256 over
/// `command_log` in seq order.
async fn restore_check(path: Option<String>) -> Result<(), BoxError> {
    use acct_store::sqlx::Connection;
    use sha2::{Digest, Sha256};

    let path = PathBuf::from(path.ok_or("usage: acctd restore-check <path>")?);
    let mut conn = acct_store::backup::open_read_only(&path)
        .await
        .map_err(|e| e.to_string())?;
    let integrity = acct_store::backup::integrity_check(&mut conn).await?;
    let mut hasher = Sha256::new();
    let summary =
        acct_store::backup::summarise_log(&mut conn, &mut |bytes| hasher.update(bytes)).await?;
    conn.close().await?;
    let hash: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    println!("database:         {}", path.display());
    println!("integrity:        {integrity}");
    println!("latest seq:       {}", summary.head_seq);
    println!("command_log rows: {}", summary.rows);
    println!("command_log hash: {hash}");
    if integrity != "ok" {
        return Err("the database failed SQLite's integrity check".into());
    }
    Ok(())
}

const DEFAULT_LABELLED_SET: &str = "fixtures/ai/labelled-lines.json";

/// ADR 009's bake-off: runs the provider that `AI_PROVIDER`, `AI_MODEL`, `AI_BASE_URL` and
/// `AI_API_KEY` configure over the labelled set, and prints accuracy, the share declined and the
/// cost. It sends real requests, so it costs real money (cents). Prices come from
/// `AI_PRICE_INPUT`, `AI_PRICE_OUTPUT`, `AI_PRICE_CACHE_READ` and `AI_PRICE_CACHE_WRITE` (USD per
/// million tokens), or from the list prices ADR 009 checked.
async fn ai_eval(path: Option<String>) -> Result<(), BoxError> {
    use acct_ai::eval::{self, LabelledSet, Prices};

    let config = acct_ai::Config::from_vars(|name| std::env::var(name).ok())?
        .ok_or("set AI_PROVIDER and AI_API_KEY (and AI_MODEL) to choose what to evaluate")?;
    let suggester = config.suggester()?;
    let path = path.unwrap_or_else(|| DEFAULT_LABELLED_SET.to_owned());
    let set = LabelledSet::parse(
        &std::fs::read_to_string(&path).map_err(|e| format!("couldn't read {path}: {e}"))?,
    )?;

    let price = |name: &str| -> Result<Option<u64>, BoxError> {
        match std::env::var(name) {
            Ok(v) => Ok(Some(
                Prices::parse_usd(&v).ok_or(format!("{name} isn't an amount of dollars: {v:?}"))?,
            )),
            Err(_) => Ok(None),
        }
    };
    let known = Prices::known(suggester.model());
    let prices = match (price("AI_PRICE_INPUT")?, price("AI_PRICE_OUTPUT")?) {
        (Some(input), Some(output)) => Some(Prices {
            input,
            output,
            cache_read: price("AI_PRICE_CACHE_READ")?.unwrap_or(input / 10),
            cache_write: price("AI_PRICE_CACHE_WRITE")?.unwrap_or(input / 4 * 5),
        }),
        _ => known,
    };

    println!(
        "Sending {} labelled lines to {} ({}), {} at a time.{}",
        set.lines.len(),
        config.provider_name,
        suggester.model(),
        eval::BATCH,
        if config.provider == acct_ai::Provider::Fake {
            " It's the fake, so nothing leaves this machine."
        } else {
            " This costs real money."
        }
    );
    let report = eval::run(suggester.as_ref(), &set).await;
    print!("{}", report.render(prices));
    Ok(())
}

async fn serve(store: Store) -> Result<(), BoxError> {
    let bind: SocketAddr = std::env::var("ACCT_BIND")
        .unwrap_or_else(|_| DEFAULT_BIND.to_owned())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!("acctd listening on http://{bind}");

    let state = AppState::new(Arc::new(store));
    acct_server::serve(listener, state, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}

/// Asks for the practice name and the first practice admin's details, then submits them as the
/// `initialise` command. Only works on a server that hasn't been set up.
async fn init(store: &Store) -> Result<(), BoxError> {
    println!("Setting up a new acct server. The first user is a practice admin.");
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
        role: Role::PracticeAdmin,
    };
    match pipeline::submit(store, &system, envelope, chrono::Utc::now()).await {
        Ok(_) => {
            println!("Done. Start the server with `acctd` and log in.");
            Ok(())
        }
        Err(e) => Err(e.body().message.into()),
    }
}

/// Adds an overseer, submitted as `create_user` by the server itself. The web app can't make one:
/// only an overseer can (crate::access), so the first comes from here, on the server.
async fn add_overseer(store: &Store) -> Result<(), BoxError> {
    println!("Adding an overseer: they see and change every business, and every practice view.");
    let username = ask("Username: ")?;
    let display_name = ask("Full name: ")?;
    let password = rpassword::prompt_password("Password: ")?;
    if rpassword::prompt_password("Password again: ")? != password {
        return Err("the passwords don't match; nothing was saved".into());
    }
    let envelope = CommandEnvelope {
        id: uuid::Uuid::now_v7().to_string(),
        command: Command::CreateUser {
            username,
            display_name,
            password,
            role: Role::Overseer,
        },
    };
    let system = Actor {
        user_id: None,
        role: Role::Overseer,
    };
    match pipeline::submit(store, &system, envelope, chrono::Utc::now()).await {
        Ok(_) => {
            println!("Done. They can log in now.");
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
