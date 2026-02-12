use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::Args;
use sandbox_fc::FirecrackerFactory;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::{error, info};

use crate::api::ApiClient;
use crate::error::{RunnerError, RunnerResult};
use crate::executor::{self, ExecutorConfig};
use crate::paths::RunnerPaths;
use crate::status::{RunnerMode, StatusTracker};

const POLL_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Args)]
pub struct StartArgs {
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

/// Build config from CLI args and run the main poll loop.
pub async fn run_start(args: StartArgs) -> RunnerResult<()> {
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

    run(config).await
}

struct RunConfig {
    api_url: String,
    token: String,
    group: String,
    fc_config: sandbox_fc::FirecrackerConfig,
    max_concurrent: usize,
    vcpu: u32,
    memory_mb: u32,
    status: Arc<StatusTracker>,
}

async fn run(config: RunConfig) -> RunnerResult<()> {
    let factory = FirecrackerFactory::new(config.fc_config.clone())
        .await
        .map_err(|e| RunnerError::Internal(format!("factory init: {e}")))?;
    let factory = Arc::new(factory);

    let api = ApiClient::new(config.api_url.clone(), config.token.clone())?;
    let semaphore = Arc::new(Semaphore::new(config.max_concurrent));
    let mut jobs = JoinSet::new();

    let is_snapshot = config.fc_config.snapshot.is_some();
    let exec_config = Arc::new(ExecutorConfig {
        api_url: config.api_url.clone(),
        vcpu: config.vcpu,
        memory_mb: config.memory_mb,
        is_snapshot,
    });

    config.status.write_initial().await;
    info!(
        group = %config.group,
        max_concurrent = config.max_concurrent,
        "runner started, polling for jobs"
    );

    // -----------------------------------------------------------------------
    // Signal handling
    // -----------------------------------------------------------------------
    let (mode_tx, mut mode_rx) = tokio::sync::watch::channel(RunnerMode::Running);

    tokio::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};

        let mut sigterm = signal(SignalKind::terminate()).ok();
        let mut sigint = signal(SignalKind::interrupt()).ok();
        let mut sigusr1 = signal(SignalKind::user_defined1()).ok();

        loop {
            tokio::select! {
                _ = recv_signal(&mut sigterm) => {
                    info!("received SIGTERM, stopping");
                    let _ = mode_tx.send(RunnerMode::Stopping);
                    return;
                }
                _ = recv_signal(&mut sigint) => {
                    info!("received SIGINT, stopping");
                    let _ = mode_tx.send(RunnerMode::Stopping);
                    return;
                }
                _ = recv_signal(&mut sigusr1) => {
                    info!("received SIGUSR1, draining (no new jobs)");
                    let _ = mode_tx.send(RunnerMode::Draining);
                }
            }
        }
    });

    // -----------------------------------------------------------------------
    // Poll loop
    // -----------------------------------------------------------------------
    let mut current_mode = RunnerMode::Running;
    loop {
        let mode = *mode_rx.borrow_and_update();
        if mode != current_mode {
            current_mode = mode;
            config.status.set_mode(mode).await;
        }
        match mode {
            RunnerMode::Stopping | RunnerMode::Stopped => break,
            RunnerMode::Draining => {
                // Don't accept new jobs, wait for running ones to complete
                if jobs.is_empty() {
                    info!("all jobs drained");
                    break;
                }
                tokio::select! {
                    _ = mode_rx.changed() => {}
                    result = jobs.join_next() => {
                        if let Some(Err(e)) = result {
                            error!(error = %e, "job task panicked");
                        }
                    }
                }
                continue;
            }
            RunnerMode::Running => {}
        }

        // If all permits are taken, wait for a job to finish or mode change
        if semaphore.available_permits() == 0 {
            tokio::select! {
                _ = mode_rx.changed() => {}
                result = jobs.join_next() => {
                    if let Some(Err(e)) = result {
                        error!(error = %e, "job task panicked");
                    }
                }
            }
            continue;
        }

        // Poll for a job
        let poll_result = tokio::select! {
            result = api.poll(&config.group) => result,
            _ = mode_rx.changed() => continue,
        };

        let job = match poll_result {
            Ok(Some(job)) => job,
            Ok(None) => {
                // No work available — wait before re-polling
                tokio::select! {
                    _ = tokio::time::sleep(POLL_INTERVAL) => {}
                    _ = mode_rx.changed() => {}
                }
                continue;
            }
            Err(e) => {
                error!(error = %e, "poll failed, retrying in 5s");
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(5)) => {}
                    _ = mode_rx.changed() => {}
                }
                continue;
            }
        };

        let run_id = job.run_id;
        info!(run_id = %run_id, "job received, claiming");

        // Claim the job
        let context = match api.claim(run_id).await {
            Ok(ctx) => ctx,
            Err(RunnerError::AlreadyClaimed) => {
                info!(run_id = %run_id, "job already claimed, skipping");
                continue;
            }
            Err(e) => {
                error!(run_id = %run_id, error = %e, "claim failed");
                continue;
            }
        };

        info!(run_id = %run_id, "job claimed, spawning executor");

        // Acquire semaphore permit
        let permit = match semaphore.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => {
                error!("semaphore closed unexpectedly");
                break;
            }
        };

        // Track active run
        config.status.add_run(run_id).await;

        let api = api.clone();
        let factory = Arc::clone(&factory);
        let exec_config = Arc::clone(&exec_config);
        let status = Arc::clone(&config.status);

        jobs.spawn(async move {
            executor::execute_job(&api, factory.as_ref(), context, &exec_config).await;
            status.remove_run(run_id).await;
            drop(permit);
        });
    }

    // -----------------------------------------------------------------------
    // Drain running jobs (for Stopping — Draining already drained above)
    // -----------------------------------------------------------------------
    let remaining = jobs.len();
    if remaining > 0 {
        info!(remaining, "waiting for running jobs to finish");
        while let Some(result) = jobs.join_next().await {
            if let Err(e) = result {
                error!(error = %e, "job task panicked during drain");
            }
        }
    }

    // Cleanup factory pools
    info!("cleaning up factory");
    factory.cleanup().await;

    config.status.set_mode(RunnerMode::Stopped).await;
    info!("runner stopped");

    Ok(())
}

/// Await a signal if registered, or pend forever if registration failed.
async fn recv_signal(sig: &mut Option<tokio::signal::unix::Signal>) {
    match sig {
        Some(s) => {
            s.recv().await;
        }
        None => std::future::pending().await,
    }
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
