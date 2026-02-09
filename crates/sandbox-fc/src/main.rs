use std::fmt;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use clap::{Parser, Subcommand};
use sandbox::{ExecRequest, ResourceLimits, SandboxConfig, SandboxFactory};
use tracing_subscriber::fmt::time::FormatTime;
use uuid::Uuid;

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
#[command(name = "sandbox-fc")]
struct Cli {
    /// Path to the Firecracker binary
    #[arg(long)]
    firecracker: PathBuf,
    /// Path to the guest kernel image
    #[arg(long)]
    kernel: PathBuf,
    /// Path to the root filesystem image
    #[arg(long)]
    rootfs: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug)]
struct SharedPaths {
    firecracker: PathBuf,
    kernel: PathBuf,
    rootfs: PathBuf,
}

#[derive(Subcommand)]
enum Command {
    /// Create a snapshot from a fresh VM boot
    Snapshot {
        /// Directory where snapshot artifacts will be written
        output_dir: PathBuf,
        /// Number of vCPUs for the VM
        #[arg(long, default_value_t = 1)]
        vcpu_count: u32,
        /// Memory size in MiB for the VM
        #[arg(long, default_value_t = 256)]
        memory_mb: u32,
    },
    /// Boot a VM and execute a command
    Exec {
        /// Command to execute inside the VM
        cmd: String,
        /// Base directory for runtime data
        #[arg(long)]
        base_dir: PathBuf,
        /// Snapshot directory to restore from (created by `snapshot` subcommand)
        #[arg(long)]
        snapshot_dir: Option<PathBuf>,
        /// Number of vCPUs for the VM
        #[arg(long, default_value_t = 1)]
        vcpu_count: u32,
        /// Memory size in MiB for the VM
        #[arg(long, default_value_t = 256)]
        memory_mb: u32,
        /// Execution timeout in milliseconds
        #[arg(long, default_value_t = 5000)]
        timeout: u32,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_timer(Elapsed(Instant::now()))
        .init();

    if nix::unistd::getuid().is_root() {
        eprintln!("error: sandbox-fc must not be run as root (it calls sudo internally as needed)");
        return ExitCode::FAILURE;
    }

    let cli = Cli::parse();

    let paths = SharedPaths {
        firecracker: cli.firecracker,
        kernel: cli.kernel,
        rootfs: cli.rootfs,
    };

    let result = match cli.command {
        Command::Snapshot {
            output_dir,
            vcpu_count,
            memory_mb,
        } => run_snapshot(paths, output_dir, vcpu_count, memory_mb).await,
        Command::Exec {
            cmd,
            base_dir,
            snapshot_dir,
            vcpu_count,
            memory_mb,
            timeout,
        } => {
            run_exec(
                paths,
                base_dir,
                &cmd,
                snapshot_dir,
                vcpu_count,
                memory_mb,
                timeout,
            )
            .await
        }
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}

/// Resolve a path to absolute. Creates parent directories for `output_dir`-style
/// paths that may not exist yet — callers should use [`resolve_or_create`] for those.
async fn resolve_path(path: PathBuf) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(tokio::fs::canonicalize(&path)
        .await
        .map_err(|e| format!("resolve path {}: {e}", path.display()))?)
}

/// Create the directory if needed, then resolve to absolute.
async fn resolve_or_create(path: PathBuf) -> Result<PathBuf, Box<dyn std::error::Error>> {
    tokio::fs::create_dir_all(&path).await?;
    resolve_path(path).await
}

async fn run_snapshot(
    paths: SharedPaths,
    output_dir: PathBuf,
    vcpu_count: u32,
    memory_mb: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    let config = sandbox_fc::SnapshotCreateConfig {
        binary_path: resolve_path(paths.firecracker).await?,
        kernel_path: resolve_path(paths.kernel).await?,
        rootfs_path: resolve_path(paths.rootfs).await?,
        output_dir: resolve_or_create(output_dir).await?,
        vcpu_count,
        memory_mb,
    };

    let snapshot = sandbox_fc::create_snapshot(config).await?;

    println!("snapshot:       {}", snapshot.snapshot_path.display());
    println!("memory:         {}", snapshot.memory_path.display());
    println!("overlay:        {}", snapshot.overlay_path.display());
    println!("overlay_bind:   {}", snapshot.overlay_bind_path.display());
    println!("vsock_bind_dir: {}", snapshot.vsock_bind_dir.display());

    Ok(())
}

async fn run_exec(
    paths: SharedPaths,
    base_dir: PathBuf,
    cmd: &str,
    snapshot_dir: Option<PathBuf>,
    vcpu_count: u32,
    memory_mb: u32,
    timeout: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    let firecracker = resolve_path(paths.firecracker).await?;
    let kernel = resolve_path(paths.kernel).await?;
    let rootfs = resolve_path(paths.rootfs).await?;
    let base_dir = resolve_or_create(base_dir).await?;
    let snapshot_dir = match snapshot_dir {
        Some(d) => Some(resolve_path(d).await?),
        None => None,
    };

    let snapshot = snapshot_dir.map(|dir| {
        let output = sandbox_fc::SnapshotOutputPaths::new(dir.clone());
        let work = sandbox_fc::SandboxPaths::new(dir.join("work"));
        sandbox_fc::SnapshotConfig {
            snapshot_path: output.snapshot(),
            memory_path: output.memory(),
            overlay_path: output.overlay(),
            overlay_bind_path: work.overlay(),
            vsock_bind_dir: work.vsock_dir(),
        }
    });

    let config = sandbox_fc::FirecrackerConfig {
        binary_path: firecracker,
        kernel_path: kernel,
        rootfs_path: rootfs,
        base_dir,
        concurrency: 1,
        proxy_port: None,
        snapshot,
    };

    let factory = sandbox_fc::FirecrackerFactory::new(config).await?;

    let sandbox_config = SandboxConfig {
        id: Uuid::new_v4(),
        resources: ResourceLimits {
            cpu_count: vcpu_count,
            memory_mb,
            // Sandbox-level lifetime cap (distinct from per-exec timeout_ms).
            timeout_ms: 30_000,
        },
    };

    let mut sandbox = factory.create(sandbox_config).await?;
    sandbox.start().await?;

    let result = sandbox
        .exec(&ExecRequest {
            cmd,
            timeout_ms: timeout,
        })
        .await?;

    println!("exit_code: {}", result.exit_code);
    println!("stdout: {}", result.stdout);
    println!("stderr: {}", result.stderr);

    sandbox.stop().await?;
    factory.destroy(sandbox).await;
    factory.cleanup().await;

    Ok(())
}
