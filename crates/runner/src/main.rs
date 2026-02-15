mod api;
mod cmd;
mod config;
mod deps;
mod error;
mod executor;
mod lock;
mod paths;
mod proxy;
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
#[command(name = "runner", version)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Download Firecracker, kernel, and verify host prerequisites
    Setup,
    /// Build rootfs and snapshot in one step
    Build(cmd::BuildArgs),
    /// Build squashfs rootfs only (without snapshot)
    Rootfs(cmd::RootfsArgs),
    /// Create a Firecracker VM snapshot for fast sandbox boot
    Snapshot(cmd::SnapshotArgs),
    /// Run a single bash command in a VM for benchmarking
    Benchmark(cmd::BenchmarkArgs),
    /// Start the runner and poll for jobs (must run setup + build first)
    Start(Box<cmd::StartArgs>),
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
        Command::Setup => cmd::run_setup().await.map(|()| ExitCode::SUCCESS),
        Command::Build(args) => cmd::run_build(args).await.map(|()| ExitCode::SUCCESS),
        Command::Rootfs(args) => cmd::run_rootfs(args).await.map(|_| ExitCode::SUCCESS),
        Command::Snapshot(args) => cmd::run_snapshot(args).await.map(|_| ExitCode::SUCCESS),
        Command::Benchmark(args) => cmd::run_benchmark(args).await,
        Command::Start(args) => cmd::run_start(*args).await.map(|()| ExitCode::SUCCESS),
    };

    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
