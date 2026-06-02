mod axiom_layer;
mod ca;
mod cmd;
mod config;
mod deps;
mod dns;
mod error;
mod executor;
mod group;
mod host;
mod host_env;
mod http;
mod idle_pool;
mod ids;
mod image_hash;
mod io_limits;
mod kmsg_log;
mod lock;
mod network_log_drain;
mod network_log_manager;
mod network_logs;
mod paths;
mod prefetch;
mod process;
mod profile;
mod provider;
mod proxy;
mod r2_cache;
mod resource_budget;
mod retry;
mod runner_dirname;
mod runtime_overrides;
mod status;
mod storage_cache;
mod telemetry;
mod types;
mod workspace_mount;

use std::path::Path;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use tracing_subscriber::Layer as _;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

const RUNNER_FMT_MAX_LEVEL: LevelFilter = LevelFilter::INFO;

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
    /// Build rootfs and snapshot into a unified image
    Build(cmd::BuildArgs),
    /// Generate runner.yaml from a pre-built image hash
    Config(cmd::ConfigArgs),
    /// Run a single bash command in a VM for benchmarking
    Benchmark(cmd::BenchmarkArgs),
    /// Execute a command inside a running VM for debugging
    Exec(cmd::ExecArgs),
    /// Start the runner and poll for jobs (must run setup + build first)
    Start(Box<cmd::StartArgs>),
    /// Manage the runner as a systemd service
    Service(cmd::ServiceArgs),
    /// Kill a running sandbox
    Kill(cmd::KillArgs),
    /// Clean up unused image directories
    Gc(cmd::GcArgs),
    /// Runtime health diagnostics for all runners on the host
    Doctor(cmd::DoctorArgs),
    /// Local file-queue provider commands
    Local(cmd::LocalArgs),
}

/// Extract the runner `name` field from a runner config YAML.
///
/// Called before tracing is initialized, so warnings go to stderr directly.
/// The returned value is sanitized to contain only `[a-zA-Z0-9_-]` characters
/// so it is safe for use as a log file prefix.
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
    let raw = match serde_yaml_ng::from_str::<Partial>(&content) {
        Ok(p) => p.name,
        Err(e) => {
            eprintln!(
                "warn: could not parse runner name from {}: {e}",
                path.display()
            );
            return "default".into();
        }
    };
    sanitize_name(&raw)
}

/// Replace non-`[a-zA-Z0-9_-]` characters with `-`.
/// Returns `"default"` if the result is empty.
fn sanitize_name(raw: &str) -> String {
    let sanitized: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "default".into()
    } else {
        sanitized
    }
}

/// Initialize tracing with a tee writer (stderr + rolling log file) plus an
/// optional Axiom layer.
///
/// Returns the [`tracing_appender::non_blocking::WorkerGuard`] that must be
/// held alive until the process exits so buffered logs are flushed.
fn init_tracing_with_file(
    config_path: &Path,
    axiom_layer: Option<axiom_layer::AxiomLayer>,
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

    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_filter(RUNNER_FMT_MAX_LEVEL);
    let axiom_layer = axiom_layer.map(axiom_layer::with_ingest_filter);
    tracing_subscriber::registry()
        .with(fmt_layer)
        .with(axiom_layer)
        .init();

    Ok(guard)
}

/// Initialize tracing with stderr output only (no rolling log file on disk),
/// plus an optional Axiom layer.
///
/// Explicitly writes to stderr so commands like `runner exec` — which pipe the
/// guest program's stdout through verbatim — don't have tracing lines
/// interleaved into captured output. The `fmt::layer()` default writer is
/// stdout, which is the wrong sink for a CLI tool.
fn init_tracing_stderr(axiom_layer: Option<axiom_layer::AxiomLayer>) {
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_writer(std::io::stderr)
        .with_filter(RUNNER_FMT_MAX_LEVEL);
    let axiom_layer = axiom_layer.map(axiom_layer::with_ingest_filter);
    tracing_subscriber::registry()
        .with(fmt_layer)
        .with(axiom_layer)
        .init();
}

#[tokio::main]
async fn main() -> ExitCode {
    // Initialize Sentry panic reporting before anything else.
    // Disabled (zero overhead) when SENTRY_DSN is not set.
    let _sentry_guard = sentry::init((
        std::env::var("SENTRY_DSN").unwrap_or_default(),
        sentry::ClientOptions {
            release: Some(env!("CARGO_PKG_VERSION").into()),
            default_integrations: false,
            ..Default::default()
        }
        .add_integration(sentry::integrations::panic::PanicIntegration::default()),
    ));

    if !nix::unistd::getuid().is_root() {
        eprintln!("error: runner must be run as root");
        return ExitCode::FAILURE;
    }

    let cli = Cli::parse();

    // Axiom layer (dual-write with fmt). Returns None — zero overhead — when
    // AXIOM_TOKEN_TELEMETRY / AXIOM_DATASET_SUFFIX are unset.
    let (axiom_layer, axiom_guard) = match axiom_layer::init() {
        Some((layer, guard)) => (Some(layer), Some(guard)),
        None => (None, None),
    };

    let was_enabled = axiom_layer.is_some();
    let (_guard, axiom_installed) = match &cli.command {
        Command::Start(args) => match init_tracing_with_file(&args.config, axiom_layer) {
            Ok(guard) => (Some(guard), was_enabled),
            Err(e) => {
                // The failed `init_tracing_with_file` already consumed `axiom_layer`,
                // so the stderr fallback runs without Axiom — acceptable degraded
                // mode (home/log-dir setup is already broken at this point).
                init_tracing_stderr(None);
                tracing::warn!("file logging unavailable, using stderr only: {e}");
                (None, false)
            }
        },
        _ => {
            init_tracing_stderr(axiom_layer);
            (None, was_enabled)
        }
    };

    if axiom_installed {
        tracing::info!("axiom telemetry enabled");
    } else {
        tracing::info!("axiom telemetry disabled");
    }

    let result = match cli.command {
        Command::Setup => cmd::run_setup().await.map(|()| ExitCode::SUCCESS),
        Command::Build(args) => cmd::run_build(args, &sandbox_fc::FirecrackerSnapshotProvider)
            .await
            .map(|()| ExitCode::SUCCESS),
        Command::Config(args) => cmd::run_config(args).await.map(|()| ExitCode::SUCCESS),
        Command::Benchmark(args) => {
            cmd::run_benchmark(args, &sandbox_fc::FirecrackerRuntimeProvider).await
        }
        Command::Exec(args) => cmd::run_exec(args, &sandbox_fc::FirecrackerControl).await,
        Command::Kill(args) => cmd::run_kill(args, &sandbox_fc::FirecrackerControl).await,
        Command::Start(args) => cmd::run_start(*args, &sandbox_fc::FirecrackerRuntimeProvider)
            .await
            .map(|()| ExitCode::SUCCESS),
        Command::Service(args) => cmd::run_service(args).await.map(|()| ExitCode::SUCCESS),
        Command::Gc(args) => cmd::run_gc(args).await.map(|()| ExitCode::SUCCESS),
        Command::Doctor(args) => cmd::run_doctor(args).await,
        Command::Local(args) => cmd::run_local(args).await,
    };

    let exit = match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    };

    if let Some(g) = axiom_guard {
        g.shutdown().await;
    }

    exit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_name_passthrough() {
        assert_eq!(sanitize_name("my-runner_01"), "my-runner_01");
    }

    #[test]
    fn sanitize_name_replaces_slashes() {
        assert_eq!(sanitize_name("foo/bar"), "foo-bar");
    }

    #[test]
    fn sanitize_name_replaces_path_traversal() {
        assert_eq!(sanitize_name("../../etc/passwd"), "------etc-passwd");
    }

    #[test]
    fn sanitize_name_replaces_non_ascii() {
        assert_eq!(sanitize_name("runner-日本語"), "runner----");
    }

    #[test]
    fn sanitize_name_empty_returns_default() {
        assert_eq!(sanitize_name(""), "default");
    }

    #[test]
    fn runner_name_missing_file_returns_default() {
        assert_eq!(
            runner_name_from_config(Path::new("/nonexistent.yaml")),
            "default"
        );
    }
}
