//! Mock Codex app-server for testing.
//!
//! The binary speaks newline-delimited JSON-RPC over stdio and persists mock
//! session artifacts under the resolved Codex home. The artifact root is
//! resolved as follows: a non-empty `$CODEX_HOME` takes precedence; an empty
//! `$CODEX_HOME` is treated as unset, so `$HOME/.codex` is used, falling back to
//! `/home/user/.codex` when `$HOME` is unavailable. Behavior is selected with
//! `MOCK_CODEX_APP_SERVER_SCENARIO`.

use clap::{Parser, Subcommand};
use guest_mock_codex::run_app_server;
use std::io;

#[derive(Parser, Debug)]
#[command(name = "guest-mock-codex", version)]
struct Cli {
    /// Codex config override (accepted, ignored).
    #[arg(short = 'c', long = "config", global = true)]
    config: Vec<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Mirrors `codex app-server`.
    AppServer(AppServerArgs),
}

#[derive(clap::Args, Debug)]
struct AppServerArgs {
    /// Listen URL (mock supports stdio://).
    #[arg(long, default_value = "stdio://")]
    listen: String,

    /// Use stdio transport.
    #[arg(long)]
    stdio: bool,
}

fn main() -> io::Result<()> {
    let Cli { command, config: _ } = Cli::parse();

    match command {
        Command::AppServer(AppServerArgs { listen, stdio: _ }) => run_app_server(&listen),
    }
}
