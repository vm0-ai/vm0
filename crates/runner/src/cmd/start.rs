use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::Args;
use sandbox::SandboxFactory;
use sandbox_fc::FirecrackerFactory;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};

use crate::config;
use crate::deps;
use crate::error::{RunnerError, RunnerResult};
use crate::executor::{self, ExecutorConfig};
use crate::lock;
use crate::paths::{HomePaths, RunnerPaths};
use crate::provider::{ApiProvider, JobProvider, LocalProvider};
use crate::proxy;
use crate::retry::{RetryState, recv_retry, sleep_until_retry};
use crate::status::{RunnerMode, StatusTracker};

/// Initial backoff before retrying mitmproxy after a crash.
const MITM_BACKOFF_INITIAL: Duration = Duration::from_secs(1);
/// Maximum backoff between mitmproxy restart attempts.
const MITM_BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Stop retrying mitmproxy after this many consecutive failures.
const MITM_MAX_CONSECUTIVE_FAILURES: u32 = 20;

#[derive(Args)]
pub struct StartArgs {
    /// Path to runner.yaml config file
    #[arg(long, short)]
    pub(crate) config: PathBuf,
    /// vm0 API URL (overrides config)
    #[arg(long, env = "VM0_API_URL")]
    api_url: Option<String>,
    /// Runner authentication token (overrides config)
    #[arg(long, env = "VM0_RUNNER_TOKEN")]
    token: Option<String>,
    /// Use local file queue provider instead of API (for testing)
    #[arg(long)]
    local: bool,
    /// Enable active balloon memory reclaim per sandbox
    #[arg(long)]
    balloon_reclaim: bool,
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

    // Exclusive lock — prevents two runner processes from sharing the same base_dir.
    // Canonicalize so that equivalent paths (e.g. with `..`) produce the same lock.
    let base_dir_canonical = runner_config.base_dir.canonicalize().map_err(|e| {
        RunnerError::Config(format!(
            "canonicalize base_dir {}: {e}",
            runner_config.base_dir.display()
        ))
    })?;
    let home = HomePaths::new()?;
    let _base_dir_lock = lock::try_acquire(home.base_dir_lock(&base_dir_canonical))
        .await
        .map_err(|e| {
            RunnerError::Config(format!(
                "cannot lock base_dir {}: {e}",
                runner_config.base_dir.display()
            ))
        })?;
    // Shared locks on rootfs/snapshot — allows `runner gc` to detect in-use resources.
    let _rootfs_lock =
        if let Some(hash) = home.extract_rootfs_hash(&runner_config.firecracker.rootfs) {
            let lock = lock::acquire_shared(home.rootfs_lock(&hash)).await?;
            crate::paths::touch_mtime(&home.rootfs_dir().join(&hash));
            Some(lock)
        } else {
            None
        };
    let _snapshot_lock = if let Some(ref snap) = runner_config.firecracker.snapshot
        && let Some(hash) = home.extract_snapshot_hash(&snap.snapshot_path)
    {
        let lock = lock::acquire_shared(home.snapshot_lock(&hash)).await?;
        crate::paths::touch_mtime(&home.snapshots_dir().join(&hash));
        Some(lock)
    } else {
        None
    };

    let log_paths = crate::paths::LogPaths::new(home.logs_dir());
    tokio::fs::create_dir_all(log_paths.dir())
        .await
        .map_err(|e| {
            RunnerError::Config(format!(
                "create logs_dir {}: {e}",
                log_paths.dir().display()
            ))
        })?;

    // Start background prefetch so memory.bin is in page cache before the first VM.
    if let Some(snapshot) = &runner_config.firecracker.snapshot {
        let path = snapshot.memory_path.clone();
        tokio::task::spawn_blocking(move || crate::prefetch::prefetch_memory(&path));
    }

    // Start proxy before factory so proxy_port is available for netns pool.
    let paths = RunnerPaths::new(runner_config.base_dir.clone());
    let (mut mitm, mitm_crash_rx) = proxy::MitmProxy::new(proxy::ProxyConfig {
        mitmdump_bin: home.mitmdump_bin(deps::MITMPROXY_VERSION),
        ca_dir: runner_config.ca_dir.clone(),
        addon_path: paths.mitm_addon(),
        registry_path: paths.proxy_registry(),
        registry_lock_path: paths.proxy_registry_lock(),
        api_url: Some(server.url.clone()),
    })
    .await?;
    mitm.start().await?;
    info!(port = mitm.port(), "proxy ready");

    let mut fc_config = runner_config.firecracker_config();
    fc_config.proxy_port = Some(mitm.port());
    fc_config.balloon_reclaim = args.balloon_reclaim;
    let registry_handle = mitm.registry_handle();

    // Destructure — no clones needed
    let config::RunnerConfig {
        name,
        group,
        sandbox,
        ..
    } = runner_config;
    let config::SandboxConfig {
        max_concurrent,
        vcpu,
        memory_mb,
        concurrency_factor,
    } = sandbox;
    let max_concurrent = if max_concurrent == 0 {
        let host_cpus = crate::host::cpu_count()?;
        let host_memory_mb = crate::host::memory_mb()?;
        let computed = crate::host::compute_max_concurrent(
            host_cpus,
            host_memory_mb,
            vcpu,
            memory_mb,
            concurrency_factor,
        );
        info!(
            host_cpus,
            host_memory_mb,
            vcpu,
            memory_mb,
            concurrency_factor,
            computed,
            "auto-detected max_concurrent"
        );
        computed
    } else {
        max_concurrent
    };
    fc_config.concurrency = max_concurrent;
    let mut status = StatusTracker::new(paths.status(), max_concurrent);
    status.set_proxy_port(mitm.port()).await;
    let status = Arc::new(status);

    // Create provider — handles discovery + claim + complete
    let cancel = CancellationToken::new();
    let http = crate::http::HttpClient::new(server.url.clone())?;
    let (provider, group_name): (Arc<dyn JobProvider>, String) = if args.local {
        let group_dir = home.groups_dir().join(&group);
        std::fs::create_dir_all(&group_dir).map_err(|e| {
            RunnerError::Config(format!("create group dir {}: {e}", group_dir.display()))
        })?;
        let provider = LocalProvider::new(group_dir, cancel.clone());
        (provider, group)
    } else {
        let group_name = group.clone();
        let provider = ApiProvider::new(http.clone(), server.token, group, cancel.clone()).await;
        (provider, group_name)
    };

    let is_snapshot = fc_config.snapshot.is_some();
    let exec_config = Arc::new(ExecutorConfig {
        api_url: server.url,
        vcpu,
        memory_mb,
        is_snapshot,
        registry: registry_handle,
        http,
        log_paths,
    });

    let config = RunConfig {
        name,
        group: group_name,
        fc_config,
        max_concurrent,
        status,
        mitm,
        mitm_crash_rx,
        provider,
        cancel,
        exec_config,
    };

    run(config).await
}

struct RunConfig {
    name: String,
    group: String,
    fc_config: sandbox_fc::FirecrackerConfig,
    max_concurrent: usize,
    status: Arc<StatusTracker>,
    mitm: proxy::MitmProxy,
    mitm_crash_rx: tokio::sync::mpsc::Receiver<()>,
    provider: Arc<dyn JobProvider>,
    cancel: CancellationToken,
    exec_config: Arc<ExecutorConfig>,
}

type MitmRestartHandle = tokio::task::JoinHandle<RunnerResult<tokio::process::Child>>;

async fn run(config: RunConfig) -> RunnerResult<()> {
    let RunConfig {
        name,
        group,
        fc_config,
        max_concurrent,
        status,
        mut mitm,
        mut mitm_crash_rx,
        provider,
        cancel,
        exec_config,
    } = config;

    let mut factory = FirecrackerFactory::new(fc_config).await?;
    factory.startup().await?;
    let factory = Arc::new(factory);

    let semaphore = Arc::new(Semaphore::new(max_concurrent));
    let mut jobs = JoinSet::new();

    status.write_initial().await;
    info!(
        name = %name,
        group = %group,
        max_concurrent,
        "runner started"
    );

    // -----------------------------------------------------------------------
    // Mitmproxy crash-restart state
    // -----------------------------------------------------------------------
    let mut mitm_retry: RetryState<MitmRestartHandle> = RetryState::new(
        MITM_BACKOFF_INITIAL,
        MITM_BACKOFF_MAX,
        Some(MITM_MAX_CONSECUTIVE_FAILURES),
    );

    // -----------------------------------------------------------------------
    // Signal handling
    // -----------------------------------------------------------------------
    let (mode_tx, mut mode_rx) = tokio::sync::watch::channel(RunnerMode::Running);
    let signal_cancel = cancel.clone();

    tokio::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};

        let mut sigterm = signal(SignalKind::terminate()).ok();
        let mut sigint = signal(SignalKind::interrupt()).ok();
        let mut sigusr1 = signal(SignalKind::user_defined1()).ok();

        tokio::select! {
            _ = recv_signal(&mut sigterm) => {
                info!("received SIGTERM, draining");
            }
            _ = recv_signal(&mut sigint) => {
                info!("received SIGINT, draining");
            }
            _ = recv_signal(&mut sigusr1) => {
                info!("received SIGUSR1, draining");
            }
        }
        let _ = mode_tx.send(RunnerMode::Draining);
        signal_cancel.cancel();
    });

    // -----------------------------------------------------------------------
    // Main loop
    // -----------------------------------------------------------------------
    let mut current_mode = RunnerMode::Running;
    loop {
        let mode = *mode_rx.borrow_and_update();
        if mode != current_mode {
            current_mode = mode;
            status.set_mode(mode).await;
        }
        match mode {
            RunnerMode::Draining | RunnerMode::Stopped => break,
            RunnerMode::Running => {}
        }

        // Spawn background restart task when timer fires
        maybe_spawn_mitm_restart(&mut mitm, &mut mitm_crash_rx, &mut mitm_retry).await;

        // If all permits are taken, wait for a job to finish or mode change
        if semaphore.available_permits() == 0 {
            tokio::select! {
                _ = mode_rx.changed() => {}
                result = jobs.join_next() => {
                    if let Some(Err(e)) = result {
                        error!(error = %e, "job task panicked");
                    }
                }
                _ = mitm_crash_rx.recv() => {
                    warn!("mitmproxy exited unexpectedly, scheduling restart");
                    mitm_retry.schedule();
                }
                result = recv_retry(&mut mitm_retry.handle) => {
                    handle_mitm_restart_result(result, &mut mitm, &mut mitm_retry);
                }
                () = sleep_until_retry(&mitm_retry.restart_at) => {}
            }
            continue;
        }

        tokio::select! {
            // Job discovery via provider (Ably push + poll).
            // discover() has no server-side side effects — safe to cancel.
            discovered = provider.discover() => {
                let Some(run_id) = discovered else { break }; // provider shutdown
                // claim() runs in the branch handler — non-interruptible,
                // so a successful claim is always paired with complete().
                let Some(context) = provider.claim(run_id).await else {
                    continue; // already claimed by another runner
                };
                info!(run_id = %run_id, "job claimed, acquiring permit");
                // Acquire permit in the main loop *before* spawning. Permits are
                // only acquired here and released by completing tasks, so since
                // we checked available_permits() > 0 above, this succeeds
                // immediately.
                let permit = match Arc::clone(&semaphore).acquire_owned().await {
                    Ok(p) => p,
                    Err(_) => {
                        error!(run_id = %run_id, "semaphore closed unexpectedly");
                        provider.complete(run_id, 1, Some("runner internal error: semaphore closed")).await;
                        break;
                    }
                };
                info!(run_id = %run_id, "spawning executor");
                status.add_run(run_id).await;
                spawn_job(
                    context, &provider, &factory, &exec_config,
                    permit, &mut jobs, &status,
                );
            }
            // Mitmproxy crash detection
            _ = mitm_crash_rx.recv() => {
                warn!("mitmproxy exited unexpectedly, scheduling restart");
                mitm_retry.schedule();
            }
            // Mitmproxy restart result (background task)
            result = recv_retry(&mut mitm_retry.handle) => {
                handle_mitm_restart_result(result, &mut mitm, &mut mitm_retry);
            }
            // Mitmproxy restart timer
            () = sleep_until_retry(&mitm_retry.restart_at) => {}
            // Mode changes (signals)
            _ = mode_rx.changed() => {}
        }
    }

    // -----------------------------------------------------------------------
    // Shutdown — release discovery resources, then drain running jobs
    // -----------------------------------------------------------------------
    provider.shutdown().await;

    let remaining = jobs.len();
    if remaining > 0 {
        info!(remaining, "waiting for running jobs to finish");
        while !jobs.is_empty() {
            maybe_spawn_mitm_restart(&mut mitm, &mut mitm_crash_rx, &mut mitm_retry).await;

            tokio::select! {
                result = jobs.join_next() => {
                    if let Some(Err(e)) = result {
                        error!(error = %e, "job task panicked during drain");
                    }
                }
                _ = mitm_crash_rx.recv() => {
                    warn!("mitmproxy exited unexpectedly, scheduling restart");
                    mitm_retry.schedule();
                }
                result = recv_retry(&mut mitm_retry.handle) => {
                    handle_mitm_restart_result(result, &mut mitm, &mut mitm_retry);
                }
                () = sleep_until_retry(&mitm_retry.restart_at) => {}
            }
        }
    }
    if let Some(h) = mitm_retry.handle {
        h.abort();
    }

    info!("shutting down factory");
    let mut factory = Arc::try_unwrap(factory)
        .map_err(|_| RunnerError::Internal("factory still referenced at shutdown".into()))?;
    factory.shutdown().await;

    // Stop proxy after all jobs have drained and factory is shut down.
    if let Err(e) = mitm.stop().await {
        warn!(error = %e, "proxy stop failed");
    }

    status.set_mode(RunnerMode::Stopped).await;
    info!("runner stopped");

    Ok(())
}

/// Spawn a job executor task.
///
/// The provider has already claimed the job and the caller has acquired
/// a semaphore permit — this function spawns the executor and reports
/// completion via the provider when done.
fn spawn_job(
    context: crate::types::ExecutionContext,
    provider: &Arc<dyn JobProvider>,
    factory: &Arc<FirecrackerFactory>,
    exec_config: &Arc<ExecutorConfig>,
    permit: OwnedSemaphorePermit,
    jobs: &mut JoinSet<()>,
    status: &Arc<StatusTracker>,
) {
    let run_id = context.run_id;

    let provider = Arc::clone(provider);
    let factory = Arc::clone(factory);
    let exec_config = Arc::clone(exec_config);
    let status = Arc::clone(status);

    jobs.spawn(async move {
        // Inner spawn isolates panics: if execute_job panics, the outer task
        // still reports completion and cleans up status/permit.
        let inner = tokio::spawn(async move {
            executor::execute_job(factory.as_ref(), context, &exec_config).await
        });

        let (exit_code, err) = match inner.await {
            Ok((code, err)) => (code, err),
            Err(e) => {
                error!(run_id = %run_id, error = %e, "executor task panicked");
                (1, Some(format!("internal error: {e}")))
            }
        };

        // Structural guarantee: claim (in provider) is always paired with complete.
        provider.complete(run_id, exit_code, err.as_deref()).await;
        status.remove_run(run_id).await;
        drop(permit);
    });
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

/// Spawn a background mitm restart task when the backoff timer fires
/// and no restart is already in flight.
async fn maybe_spawn_mitm_restart(
    mitm: &mut proxy::MitmProxy,
    crash_rx: &mut tokio::sync::mpsc::Receiver<()>,
    retry: &mut RetryState<MitmRestartHandle>,
) {
    if !retry.timer_ready() {
        return;
    }
    retry.clear_timer();
    // Drain any stale crash notifications from the previous process to prevent
    // a spurious restart cycle after this one completes.
    while crash_rx.try_recv().is_ok() {}
    let params = mitm.begin_restart().await;
    retry.handle = Some(tokio::spawn(params.spawn()));
}

/// Handle the result of a background mitm restart task.
fn handle_mitm_restart_result(
    result: Result<tokio::process::Child, String>,
    mitm: &mut proxy::MitmProxy,
    retry: &mut RetryState<MitmRestartHandle>,
) {
    match result {
        Ok(child) => {
            if retry.consecutive_failures() > 0 {
                info!(
                    attempts = retry.consecutive_failures(),
                    "mitmproxy restarted after failures"
                );
            } else {
                info!("mitmproxy restarted");
            }
            mitm.complete_restart(child);
            retry.on_success();
        }
        Err(e) => {
            // Capture before on_failure() — matches the delay actually scheduled.
            let next_secs = retry.backoff().as_secs();
            if !retry.on_failure() {
                error!(
                    error = %e,
                    failures = retry.consecutive_failures(),
                    "mitmproxy restart abandoned after too many failures"
                );
                return;
            }
            if retry.consecutive_failures() >= 5 {
                error!(
                    error = %e,
                    failures = retry.consecutive_failures(),
                    next_attempt_secs = next_secs,
                    "mitmproxy restart failing persistently"
                );
            } else {
                warn!(
                    error = %e,
                    next_attempt_secs = next_secs,
                    "mitmproxy restart failed"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a MitmProxy for testing (does not start mitmdump).
    async fn test_mitm() -> (
        proxy::MitmProxy,
        tokio::sync::mpsc::Receiver<()>,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let (mitm, rx) = proxy::MitmProxy::new(proxy::ProxyConfig {
            mitmdump_bin: PathBuf::from("true"),
            ca_dir: dir.path().to_path_buf(),
            addon_path: dir.path().join("addon.py"),
            registry_path: dir.path().join("registry.json"),
            registry_lock_path: dir.path().join("registry.lock"),
            api_url: None,
        })
        .await
        .unwrap();
        (mitm, rx, dir)
    }

    #[tokio::test]
    async fn mitm_restart_success_resets_backoff() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );
        retry.backoff = Duration::from_secs(16);
        retry.consecutive_failures = 5;

        let child = tokio::process::Command::new("true")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();

        handle_mitm_restart_result(Ok(child), &mut mitm, &mut retry);

        assert_eq!(retry.backoff, MITM_BACKOFF_INITIAL);
        assert_eq!(retry.consecutive_failures, 0);
    }

    #[tokio::test]
    async fn mitm_restart_failure_schedules_retry_with_backoff() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );

        handle_mitm_restart_result(Err("spawn failed".into()), &mut mitm, &mut retry);

        assert_eq!(retry.consecutive_failures, 1);
        assert!(retry.restart_at.is_some());
        assert_eq!(retry.backoff, MITM_BACKOFF_INITIAL * 2);
    }

    #[tokio::test]
    async fn mitm_restart_backoff_caps_at_max() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );
        retry.backoff = MITM_BACKOFF_MAX;
        retry.consecutive_failures = 10;

        handle_mitm_restart_result(Err("spawn failed".into()), &mut mitm, &mut retry);

        assert_eq!(retry.backoff, MITM_BACKOFF_MAX);
        assert!(retry.restart_at.is_some());
    }

    #[tokio::test]
    async fn mitm_restart_circuit_breaker_stops_retrying() {
        let (mut mitm, _rx, _dir) = test_mitm().await;
        let mut retry: RetryState<MitmRestartHandle> = RetryState::new(
            MITM_BACKOFF_INITIAL,
            MITM_BACKOFF_MAX,
            Some(MITM_MAX_CONSECUTIVE_FAILURES),
        );
        retry.backoff = MITM_BACKOFF_MAX;
        retry.consecutive_failures = 19;

        handle_mitm_restart_result(Err("binary missing".into()), &mut mitm, &mut retry);

        assert_eq!(retry.consecutive_failures, 20);
        assert!(
            retry.restart_at.is_none(),
            "circuit breaker should prevent further retries"
        );
    }
}
