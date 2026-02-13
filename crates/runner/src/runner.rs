use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::Args;
use sandbox::SandboxFactory;
use sandbox_fc::FirecrackerFactory;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::{error, info};

use crate::api::ApiClient;
use crate::config;
use crate::error::{RunnerError, RunnerResult};
use crate::executor::{self, ExecutorConfig};
use crate::paths::RunnerPaths;
use crate::status::{RunnerMode, StatusTracker};

const POLL_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Args)]
pub struct StartArgs {
    /// Path to runner.yaml config file
    #[arg(long, short)]
    config: PathBuf,
    /// vm0 API URL (overrides config)
    #[arg(long, env = "VM0_API_URL")]
    api_url: Option<String>,
    /// Runner authentication token (overrides config)
    #[arg(long, env = "VM0_RUNNER_TOKEN")]
    token: Option<String>,
}

/// Load config and run the main poll loop.
pub async fn run_start(args: StartArgs) -> RunnerResult<()> {
    let mut runner_config = config::load(&args.config).await?;

    // CLI / env overrides — take server out so we can mutate independently
    let mut server = runner_config.server.take().unwrap_or(config::ServerConfig {
        url: String::new(),
        token: String::new(),
    });
    if let Some(url) = args.api_url {
        server.url = url;
    }
    if let Some(token) = args.token {
        server.token = token;
    }

    // Validate required server fields
    if server.url.is_empty() {
        return Err(RunnerError::Config(
            "server.url is required (set in config or via --api-url / VM0_API_URL)".into(),
        ));
    }
    if server.token.is_empty() {
        return Err(RunnerError::Config(
            "server.token is required (set in config or via --token / VM0_RUNNER_TOKEN)".into(),
        ));
    }

    tokio::fs::create_dir_all(&runner_config.base_dir)
        .await
        .map_err(|e| {
            RunnerError::Config(format!(
                "create base_dir {}: {e}",
                runner_config.base_dir.display()
            ))
        })?;
    let fc_config = runner_config.firecracker_config();

    // Destructure — no clones needed
    let config::RunnerConfig {
        name,
        group,
        base_dir,
        sandbox,
        ..
    } = runner_config;
    let config::SandboxConfig {
        max_concurrent,
        vcpu,
        memory_mb,
    } = sandbox;
    let config::ServerConfig {
        url: api_url,
        token,
    } = server;

    let paths = RunnerPaths::new(base_dir);
    let status = Arc::new(StatusTracker::new(paths.status()));

    let config = RunConfig {
        name,
        api_url,
        token,
        group,
        fc_config,
        max_concurrent,
        vcpu,
        memory_mb,
        status,
    };

    run(config).await
}

struct RunConfig {
    name: String,
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
    let mut factory = FirecrackerFactory::new(config.fc_config.clone()).await?;
    factory.startup().await?;
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
        name = %config.name,
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

    info!("shutting down factory");
    let mut factory = Arc::try_unwrap(factory)
        .map_err(|_| RunnerError::Internal("factory still referenced at shutdown".into()))?;
    factory.shutdown().await;

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
