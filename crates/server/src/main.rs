//! `acctd`: serves the API. `acctd init` sets up a new server's practice and first master user.
//! `acctd ai-eval [file]` runs the configured AI provider over the labelled set (ADR 009).

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
    if let Some(dir) = db.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let store = Store::open(&db).await?;

    match std::env::args().nth(1).as_deref() {
        None => serve(store).await,
        Some("init") => init(&store).await,
        Some(other) => Err(format!(
            "unknown command {other:?}; try `acctd`, `acctd init` or `acctd ai-eval`"
        )
        .into()),
    }
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
