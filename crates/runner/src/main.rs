mod api;
mod cmd;
mod config;
mod deps;
mod error;
mod executor;
mod http;
mod lock;
mod network_logs;
mod paths;
mod proxy;
mod status;
mod telemetry;
mod types;

use std::fmt;
use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;

use clap::{Parser, Subcommand};
use tracing_subscriber::fmt::time::FormatTime;
use tracing_subscriber::fmt::writer::MakeWriterExt;

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
    /// Manage the runner as a systemd service
    Service(cmd::ServiceArgs),
}

/// Extract the runner `name` field from a runner config YAML.
///
/// Called before tracing is initialized, so warnings go to stderr directly.
fn runner_name_from_config(path: &Path) -> String {
    #[derive(serde::Deserialize)]
    struct Partial {
        name: String,
    }
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "warn: could not read config for runner name: {}: {e}",
                path.display()
            );
            return "default".into();
        }
    };
    match serde_yaml_ng::from_str::<Partial>(&content) {
        Ok(p) => p.name,
        Err(e) => {
            eprintln!(
                "warn: could not parse runner name from {}: {e}",
                path.display()
            );
            "default".into()
        }
    }
}

/// Initialize tracing with a tee writer (stderr + rolling log file).
///
/// Returns the [`tracing_appender::non_blocking::WorkerGuard`] that must be
/// held alive until the process exits so buffered logs are flushed.
fn init_tracing_with_file(
    config_path: &Path,
) -> Result<tracing_appender::non_blocking::WorkerGuard, Box<dyn std::error::Error>> {
    let home = paths::HomePaths::new()?;
    let log_dir = home.logs_dir();
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("create {}: {e}", log_dir.display()))?;

    let name = runner_name_from_config(config_path);
    let prefix = format!("runner-{name}");

    let file_appender = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix(prefix)
        .filename_suffix("log")
        .max_log_files(7)
        .build(log_dir)?;

    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    let writer = std::io::stderr.and(non_blocking);

    tracing_subscriber::fmt()
        .with_timer(Elapsed(Instant::now()))
        .with_writer(writer)
        .with_ansi(false)
        .init();

    Ok(guard)
}

fn init_tracing_stderr() {
    tracing_subscriber::fmt()
        .with_timer(Elapsed(Instant::now()))
        .init();
}

#[tokio::main]
async fn main() -> ExitCode {
    if nix::unistd::getuid().is_root() {
        eprintln!("error: runner must not be run as root (it calls sudo internally as needed)");
        return ExitCode::FAILURE;
    }

    let cli = Cli::parse();

    let _guard = match &cli.command {
        Command::Start(args) => match init_tracing_with_file(&args.config) {
            Ok(guard) => Some(guard),
            Err(e) => {
                init_tracing_stderr();
                tracing::warn!("file logging unavailable, using stderr only: {e}");
                None
            }
        },
        _ => {
            init_tracing_stderr();
            None
        }
    };

    let result = match cli.command {
        Command::Setup => cmd::run_setup().await.map(|()| ExitCode::SUCCESS),
        Command::Build(args) => cmd::run_build(args).await.map(|()| ExitCode::SUCCESS),
        Command::Rootfs(args) => cmd::run_rootfs(args).await.map(|_| ExitCode::SUCCESS),
        Command::Snapshot(args) => cmd::run_snapshot(args).await.map(|_| ExitCode::SUCCESS),
        Command::Benchmark(args) => cmd::run_benchmark(args).await,
        Command::Start(args) => cmd::run_start(*args).await.map(|()| ExitCode::SUCCESS),
        Command::Service(args) => cmd::run_service(args).await.map(|()| ExitCode::SUCCESS),
    };

    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
