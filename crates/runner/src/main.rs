mod api;
mod build;
mod config;
mod deps;
mod error;
mod executor;
mod paths;
mod rootfs;
mod runner;
mod setup;
mod snapshot;
mod status;
mod types;

use std::fmt;
use std::process::ExitCode;
use std::time::Instant;

use clap::{Parser, Subcommand};
use tracing_subscriber::fmt::time::FormatTime;

struct Elapsed(Instant);

impl FormatTime for Elapsed {
    fn format_time(&self, w: &mut tracing_subscriber::fmt::format::Writer<'_>) -> fmt::Result {
        let d = self.0.elapsed();
        let total_secs = d.as_secs();
        let mins = total_secs / 60;
        let secs = total_secs % 60;
        let millis = d.subsec_millis();
        write!(w, "[{mins:02}:{secs:02}:{millis:03}]")
    }
}

#[derive(Parser)]
#[command(name = "runner")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Download Firecracker, kernel, and verify host prerequisites
    Setup,
    /// Build rootfs and snapshot in one step
    Build(build::BuildArgs),
    /// Build squashfs rootfs only (without snapshot)
    Rootfs(rootfs::RootfsArgs),
    /// Create a Firecracker VM snapshot for fast sandbox boot
    Snapshot(snapshot::SnapshotArgs),
    /// Start the runner and poll for jobs (must run setup + build first)
    Start(Box<runner::StartArgs>),
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_timer(Elapsed(Instant::now()))
        .init();

    if nix::unistd::getuid().is_root() {
        eprintln!("error: runner must not be run as root (it calls sudo internally as needed)");
        return ExitCode::FAILURE;
    }

    let cli = Cli::parse();

    let result = match cli.command {
        Command::Setup => setup::run_setup().await,
        Command::Build(args) => build::run_build(args).await,
        Command::Rootfs(args) => rootfs::run_rootfs(args).await.map(drop),
        Command::Snapshot(args) => snapshot::run_snapshot(args).await.map(drop),
        Command::Start(args) => runner::run_start(*args).await,
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}
