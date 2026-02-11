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
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Instant;

use clap::{Args, Parser, Subcommand};
use tracing_subscriber::fmt::time::FormatTime;

use crate::error::{RunnerError, RunnerResult};
use crate::paths::RunnerPaths;
use crate::runner::RunConfig;
use crate::status::StatusTracker;

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
    /// Start the runner and poll for jobs
    Start(Box<StartArgs>),
    /// Download Firecracker, kernel, and verify host prerequisites
    Setup(SetupArgs),
    /// Build squashfs rootfs for Firecracker VMs
    BuildRootfs(build_rootfs::BuildRootfsArgs),
}

#[derive(Args)]
struct StartArgs {
    /// Path to the Firecracker binary
    #[arg(long)]
    firecracker: PathBuf,
    /// Path to the guest kernel image
    #[arg(long)]
    kernel: PathBuf,
    /// Path to the root filesystem image
    #[arg(long)]
    rootfs: PathBuf,
    /// vm0 API URL
    #[arg(long, env = "VM0_API_URL")]
    api_url: String,
    /// Runner authentication token
    #[arg(long, env = "VM0_RUNNER_TOKEN")]
    token: String,
    /// Runner group in scope/name format (e.g. "acme/production")
    #[arg(long)]
    group: String,
    /// Base directory for runtime data
    #[arg(long)]
    base_dir: PathBuf,
    /// Snapshot directory to restore from
    #[arg(long)]
    snapshot_dir: Option<PathBuf>,
    /// Maximum concurrent job executions
    #[arg(long, default_value_t = 4)]
    max_concurrent: usize,
    /// vCPUs per sandbox
    #[arg(long, default_value_t = 2)]
    vcpu: u32,
    /// Memory (MiB) per sandbox
    #[arg(long, default_value_t = 2048)]
    memory_mb: u32,
    /// HTTP/HTTPS proxy port for network security
    #[arg(long)]
    proxy_port: Option<u16>,
}

#[derive(Args)]
struct SetupArgs {
    /// Fail on missing optional dependencies (for CI)
    #[arg(long)]
    strict: bool,
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
        Command::Start(args) => run_start(*args).await,
        Command::Setup(args) => setup::run_setup(args.strict).await,
        Command::BuildRootfs(args) => build_rootfs::run_build_rootfs(args).await,
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}

async fn run_start(args: StartArgs) -> RunnerResult<()> {
    let firecracker = resolve_path(args.firecracker).await?;
    let kernel = resolve_path(args.kernel).await?;
    let rootfs = resolve_path(args.rootfs).await?;
    let base_dir = resolve_or_create(args.base_dir).await?;

    let snapshot = match args.snapshot_dir {
        Some(dir) => {
            let dir = resolve_path(dir).await?;
            let output = sandbox_fc::SnapshotOutputPaths::new(dir.clone());
            let work = sandbox_fc::SandboxPaths::new(dir.join("work"));
            Some(sandbox_fc::SnapshotConfig {
                snapshot_path: output.snapshot(),
                memory_path: output.memory(),
                overlay_path: output.overlay(),
                overlay_bind_path: work.overlay(),
                vsock_bind_dir: work.vsock_dir(),
            })
        }
        None => None,
    };

    let fc_config = sandbox_fc::FirecrackerConfig {
        binary_path: firecracker,
        kernel_path: kernel,
        rootfs_path: rootfs,
        base_dir: base_dir.clone(),
        concurrency: args.max_concurrent,
        proxy_port: args.proxy_port,
        snapshot,
    };

    let paths = RunnerPaths::new(base_dir);
    let status = Arc::new(StatusTracker::new(paths.status()));

    let config = RunConfig {
        api_url: args.api_url,
        token: args.token,
        group: args.group,
        fc_config,
        max_concurrent: args.max_concurrent,
        vcpu: args.vcpu,
        memory_mb: args.memory_mb,
        status,
    };

    runner::run(config).await?;

    Ok(())
}

async fn resolve_path(path: PathBuf) -> RunnerResult<PathBuf> {
    tokio::fs::canonicalize(&path)
        .await
        .map_err(|e| RunnerError::Config(format!("resolve path {}: {e}", path.display())))
}

async fn resolve_or_create(path: PathBuf) -> RunnerResult<PathBuf> {
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| RunnerError::Config(format!("create dir {}: {e}", path.display())))?;
    resolve_path(path).await
}
