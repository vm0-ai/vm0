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
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create a snapshot from a fresh VM boot
    Snapshot {
        /// Path to the Firecracker binary
        firecracker: PathBuf,
        /// Path to the guest kernel image
        kernel: PathBuf,
        /// Path to the root filesystem image
        rootfs: PathBuf,
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
        /// Path to the Firecracker binary
        firecracker: PathBuf,
        /// Path to the guest kernel image
        kernel: PathBuf,
        /// Path to the root filesystem image
        rootfs: PathBuf,
        /// Base directory for runtime data
        base_dir: PathBuf,
        /// Command to execute inside the VM
        cmd: String,
        /// Snapshot directory to restore from (created by `snapshot` subcommand)
        #[arg(long)]
        snapshot_dir: Option<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_timer(Elapsed(Instant::now()))
        .init();

    let cli = Cli::parse();

    let result = match cli.command {
        Command::Snapshot {
            firecracker,
            kernel,
            rootfs,
            output_dir,
            vcpu_count,
            memory_mb,
        } => {
            run_snapshot(
                firecracker,
                kernel,
                rootfs,
                output_dir,
                vcpu_count,
                memory_mb,
            )
            .await
        }
        Command::Exec {
            firecracker,
            kernel,
            rootfs,
            base_dir,
            cmd,
            snapshot_dir,
        } => run_exec(firecracker, kernel, rootfs, base_dir, &cmd, snapshot_dir).await,
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
    firecracker: PathBuf,
    kernel: PathBuf,
    rootfs: PathBuf,
    output_dir: PathBuf,
    vcpu_count: u32,
    memory_mb: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    let config = sandbox_fc::SnapshotCreateConfig {
        binary_path: resolve_path(firecracker).await?,
        kernel_path: resolve_path(kernel).await?,
        rootfs_path: resolve_path(rootfs).await?,
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
    firecracker: PathBuf,
    kernel: PathBuf,
    rootfs: PathBuf,
    base_dir: PathBuf,
    cmd: &str,
    snapshot_dir: Option<PathBuf>,
) -> Result<(), Box<dyn std::error::Error>> {
    let firecracker = resolve_path(firecracker).await?;
    let kernel = resolve_path(kernel).await?;
    let rootfs = resolve_path(rootfs).await?;
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
        instance_index: 0,
        concurrency: 1,
        proxy_port: None,
        snapshot,
    };

    let factory = sandbox_fc::FirecrackerFactory::new(config).await?;

    let sandbox_config = SandboxConfig {
        id: Uuid::new_v4(),
        resources: ResourceLimits {
            cpu_count: 1,
            memory_mb: 256,
            timeout_secs: 30,
        },
    };

    let mut sandbox = factory.create(sandbox_config).await?;
    sandbox.start().await?;

    let result = sandbox
        .exec(&ExecRequest {
            cmd,
            timeout_ms: 5000,
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
