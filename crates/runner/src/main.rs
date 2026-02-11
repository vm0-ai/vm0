mod api;
mod build_rootfs;
mod error;
mod executor;
mod paths;
mod runner;
mod setup;
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
    /// Build squashfs rootfs for Firecracker VMs
    BuildRootfs(build_rootfs::BuildRootfsArgs),
    /// Start the runner and poll for jobs
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
        Command::Start(args) => runner::run_start(*args).await,
        Command::Setup => setup::run_setup().await,
        Command::BuildRootfs(args) => build_rootfs::run_build_rootfs(args).await,
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}
