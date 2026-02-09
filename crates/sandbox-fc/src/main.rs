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
        } => run_snapshot(firecracker, kernel, rootfs, output_dir).await,
        Command::Exec {
            firecracker,
            kernel,
            rootfs,
            base_dir,
            cmd,
        } => run_exec(firecracker, kernel, rootfs, base_dir, &cmd).await,
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}

async fn run_snapshot(
    firecracker: PathBuf,
    kernel: PathBuf,
    rootfs: PathBuf,
    output_dir: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
    let config = sandbox_fc::SnapshotCreateConfig {
        binary_path: firecracker,
        kernel_path: kernel,
        rootfs_path: rootfs,
        output_dir,
        vcpu_count: 1,
        memory_mb: 256,
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
) -> Result<(), Box<dyn std::error::Error>> {
    let config = sandbox_fc::FirecrackerConfig {
        binary_path: firecracker,
        kernel_path: kernel,
        rootfs_path: rootfs,
        base_dir,
        instance_index: 0,
        concurrency: 1,
        proxy_port: None,
        snapshot: None,
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
