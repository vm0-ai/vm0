use std::fmt;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Instant;

use sandbox::{ExecRequest, ResourceLimits, SandboxConfig, SandboxFactory};
use tracing_subscriber::fmt::time::FormatTime;
use uuid::Uuid;

use sandbox_fc::FirecrackerConfig;

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

/// Usage: sandbox-fc <firecracker> <kernel> <rootfs> <base_dir> <cmd>
#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_timer(Elapsed(Instant::now()))
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 5 {
        eprintln!("usage: sandbox-fc <firecracker> <kernel> <rootfs> <base_dir> <cmd>");
        return ExitCode::FAILURE;
    }

    if let Err(e) = run(&args).await {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }

    ExitCode::SUCCESS
}

fn arg(args: &[String], idx: usize) -> Result<&String, &'static str> {
    args.get(idx).ok_or("missing argument")
}

async fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    let config = FirecrackerConfig {
        binary_path: PathBuf::from(arg(args, 0)?),
        kernel_path: PathBuf::from(arg(args, 1)?),
        rootfs_path: PathBuf::from(arg(args, 2)?),
        base_dir: PathBuf::from(arg(args, 3)?),
        instance_index: 0,
        concurrency: 1,
        proxy_port: None,
        snapshot: None,
    };
    let cmd = arg(args, 4)?;

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
