//! Mock Codex CLI for testing.
//!
//! Emits Codex `exec --json` protocol events on stdout and persists a JSONL
//! session file under Codex's date-partitioned session tree
//! (`$CODEX_HOME/sessions/YYYY/MM/DD/<thread_id>.jsonl`).
//!
//! Resume can also append to runner-restored rollout filenames, matching the
//! real Codex CLI's filesystem resume candidates.
//!
//! Activated in guest VMs via `USE_MOCK_CODEX=true` (handled by guest-agent).
//! This binary itself runs whenever it's invoked — the env-var dispatch lives
//! in the consumer.
//!
//! Usage (mirrors real Codex CLI):
//! ```text
//!   guest-mock-codex exec [--json] [--sandbox <mode>] [--skip-git-repo-check]
//!                          [-C <dir>] [-m <model>] [-c <config>]
//!                          [--append-system-prompt <s>] [--last]
//!                          [-- <prompt>]
//!   guest-mock-codex exec resume <canonical-uuid-thread-id> [-- <prompt>]
//!   guest-mock-codex app-server --listen stdio:// [-c <config>]
//!   guest-mock-codex app-server --stdio [-c <config>]
//! ```
//!
//! Fixture mode: when `MOCK_CODEX_FIXTURE=<name>` is set in the env, the
//! synthetic 3-event sequence is replaced with a baked JSONL fixture by
//! that name. The thread id is taken from the fixture's
//! `thread.started` event; the fixture events are emitted to stdout and
//! persisted to the session file. Used by
//! `e2e/tests/03-runner/t-codex-event-mapping.bats` to exercise the
//! codex-event-parser branches that the synthetic sequence cannot reach.
//!
//! App-server mode speaks newline-delimited JSON-RPC on stdio. Failure
//! scenarios are selected with `MOCK_CODEX_APP_SERVER_SCENARIO`.

use clap::{Parser, Subcommand};
use guest_mock_codex::{
    AppServerOptions, join_prompt_cow, lookup_fixture, run_app_server, run_fixture, run_new,
    run_resume,
};
use std::io;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "guest-mock-codex", version)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Mirrors `codex exec`.
    Exec(ExecArgs),
    /// Mirrors `codex app-server`.
    AppServer(AppServerArgs),
}

#[derive(clap::Args, Debug)]
struct ExecArgs {
    #[command(subcommand)]
    sub: Option<ExecSub>,

    /// Emit JSONL output (accepted, mock always emits JSONL).
    #[arg(long)]
    json: bool,

    /// Sandbox mode (accepted, ignored).
    #[arg(long)]
    sandbox: Option<String>,

    /// Skip git-repo check (accepted, ignored).
    #[arg(long = "skip-git-repo-check")]
    skip_git_repo_check: bool,

    /// Working directory (accepted, ignored — mock writes session file under
    /// `$CODEX_HOME` regardless).
    #[arg(short = 'C', long = "cd")]
    cwd: Option<PathBuf>,

    /// Model override (accepted, ignored).
    #[arg(short = 'm', long)]
    model: Option<String>,

    /// Codex config override (accepted, ignored).
    #[arg(short = 'c', long = "config")]
    config: Vec<String>,

    /// Append-system-prompt (accepted, ignored).
    #[arg(long = "append-system-prompt")]
    append_system_prompt: Option<String>,

    /// Resume the most recent session (accepted, ignored — mock requires an
    /// explicit id via `resume <id>`).
    #[arg(long)]
    last: bool,

    /// Trailing positional prompt (everything after `--`, or after recognised
    /// flags). May be empty.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    prompt: Vec<String>,
}

#[derive(Subcommand, Debug)]
enum ExecSub {
    /// Mirrors `codex exec resume <thread_id>`. The id must be a canonical UUID.
    Resume {
        thread_id: String,

        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        prompt: Vec<String>,
    },
}

#[derive(clap::Args, Debug)]
struct AppServerArgs {
    /// Listen URL (mock supports stdio://).
    #[arg(long, default_value = "stdio://")]
    listen: String,

    /// Use stdio transport.
    #[arg(long)]
    stdio: bool,

    /// Codex config override (accepted, ignored).
    #[arg(short = 'c', long = "config")]
    config: Vec<String>,
}

fn main() -> io::Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Cmd::AppServer(AppServerArgs {
            listen,
            stdio,
            config: _,
        }) => run_app_server(AppServerOptions { listen, stdio }),
        Cmd::Exec(ExecArgs {
            sub: Some(ExecSub::Resume { thread_id, prompt }),
            ..
        }) => {
            if maybe_run_fixture()? {
                return Ok(());
            }
            let joined_prompt = join_prompt_cow(&prompt);
            run_resume(&thread_id, joined_prompt.as_ref())
        }
        Cmd::Exec(ExecArgs { prompt, .. }) => {
            if maybe_run_fixture()? {
                return Ok(());
            }
            let joined_prompt = join_prompt_cow(&prompt);
            run_new(joined_prompt.as_ref())
        }
    }
}

fn maybe_run_fixture() -> io::Result<bool> {
    // Fixture mode is specific to the one-shot `exec --json` event stream.
    if let Ok(fixture_name) = std::env::var("MOCK_CODEX_FIXTURE")
        && !fixture_name.is_empty()
    {
        if let Some(content) = lookup_fixture(&fixture_name) {
            run_fixture(content)?;
            return Ok(true);
        }
        eprintln!(
            "warning: MOCK_CODEX_FIXTURE={fixture_name:?} not found, falling through to synthetic events"
        );
    }
    Ok(false)
}
