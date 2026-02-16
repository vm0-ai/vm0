use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Args;
use sandbox::SandboxFactory;
use sandbox_fc::FirecrackerFactory;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::{error, info, warn};

use crate::api::ApiClient;
use crate::config;
use crate::deps;
use crate::error::{RunnerError, RunnerResult};
use crate::executor::{self, ExecutorConfig};
use crate::paths::{HomePaths, RunnerPaths};
use crate::proxy::{self, ProxyRegistryHandle};
use crate::status::{RunnerMode, StatusTracker};

/// Poll interval when Ably is connected (safety net).
const POLL_SLOW: Duration = Duration::from_secs(30);
/// Poll interval when Ably is disconnected or unavailable (primary mechanism).
const POLL_FAST: Duration = Duration::from_secs(5);
/// Initial backoff before retrying Ably connection.
const ABLY_BACKOFF_INITIAL: Duration = Duration::from_secs(5);
/// Maximum backoff between Ably reconnection attempts.
const ABLY_BACKOFF_MAX: Duration = Duration::from_secs(60);
/// Initial backoff before retrying mitmproxy after a crash.
const MITM_BACKOFF_INITIAL: Duration = Duration::from_secs(1);
/// Maximum backoff between mitmproxy restart attempts.
const MITM_BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Stop retrying mitmproxy after this many consecutive failures.
const MITM_MAX_CONSECUTIVE_FAILURES: u32 = 20;

/// Groups the backoff / retry state for a restartable background task.
struct RetryState<H> {
    handle: Option<H>,
    restart_at: Option<Instant>,
    backoff: Duration,
    backoff_initial: Duration,
    backoff_max: Duration,
    consecutive_failures: u32,
    /// `None` = retry forever (Ably), `Some(n)` = circuit breaker (mitm).
    max_failures: Option<u32>,
}

impl<H> RetryState<H> {
    fn new(initial: Duration, max: Duration, max_failures: Option<u32>) -> Self {
        Self {
            handle: None,
            restart_at: None,
            backoff: initial,
            backoff_initial: initial,
            backoff_max: max,
            consecutive_failures: 0,
            max_failures,
        }
    }

    /// Schedule a restart after the current backoff delay.
    fn schedule(&mut self) {
        self.restart_at = Some(Instant::now() + self.backoff);
    }

    /// Reset backoff and failure count after a successful restart.
    fn on_success(&mut self) {
        self.backoff = self.backoff_initial;
        self.consecutive_failures = 0;
    }

    /// Record a failure, double the backoff (capped), and schedule a retry.
    /// Returns `false` if the circuit breaker has tripped.
    #[must_use]
    fn on_failure(&mut self) -> bool {
        self.consecutive_failures += 1;
        if let Some(max) = self.max_failures
            && self.consecutive_failures >= max
        {
            return false;
        }
        self.schedule();
        self.backoff = (self.backoff * 2).min(self.backoff_max);
        true
    }

    /// `true` if the restart timer has fired and no task is in flight.
    fn timer_ready(&self) -> bool {
        self.handle.is_none() && self.restart_at.is_some_and(|at| Instant::now() >= at)
    }

    /// Clear the timer after spawning a restart task.
    fn clear_timer(&mut self) {
        self.restart_at = None;
    }
}

/// Sleep until a restart timer fires, or pend forever if none is scheduled.
///
/// Free function (not a method) so the borrow on `restart_at` is disjoint
/// from `&mut retry.handle` inside `tokio::select!`.
async fn sleep_until_retry(restart_at: &Option<Instant>) {
    match restart_at {
        Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(*at)).await,
        None => std::future::pending().await,
    }
}

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

    let home = HomePaths::new()?;
    let log_paths = crate::paths::LogPaths::new(home.logs_dir());
    tokio::fs::create_dir_all(log_paths.dir())
        .await
        .map_err(|e| {
            RunnerError::Config(format!(
                "create logs_dir {}: {e}",
                log_paths.dir().display()
            ))
        })?;

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
    } = sandbox;
    let config::ServerConfig {
        url: api_url,
        token,
    } = server;

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
        registry: registry_handle,
        log_paths,
        mitm,
        mitm_crash_rx,
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
    registry: ProxyRegistryHandle,
    log_paths: crate::paths::LogPaths,
    mitm: proxy::MitmProxy,
    mitm_crash_rx: tokio::sync::mpsc::Receiver<()>,
}

type AblyReconnectHandle =
    tokio::task::JoinHandle<Result<ably_subscriber::Subscription, ably_subscriber::Error>>;

type MitmRestartHandle = tokio::task::JoinHandle<RunnerResult<tokio::process::Child>>;

async fn run(mut config: RunConfig) -> RunnerResult<()> {
    let mut factory = FirecrackerFactory::new(config.fc_config.clone()).await?;
    factory.startup().await?;
    let factory = Arc::new(factory);

    let http = crate::http::HttpClient::new(config.api_url.clone())?;
    let api = ApiClient::new(http.clone(), config.token.clone());
    let semaphore = Arc::new(Semaphore::new(config.max_concurrent));
    let mut jobs = JoinSet::new();

    let is_snapshot = config.fc_config.snapshot.is_some();
    let exec_config = Arc::new(ExecutorConfig {
        api_url: config.api_url.clone(),
        vcpu: config.vcpu,
        memory_mb: config.memory_mb,
        is_snapshot,
        registry: config.registry.clone(),
        http,
        log_paths: config.log_paths.clone(),
    });

    config.status.write_initial().await;
    info!(
        name = %config.name,
        group = %config.group,
        max_concurrent = config.max_concurrent,
        "runner started"
    );

    // -----------------------------------------------------------------------
    // Ably subscription (non-fatal — poll-only mode if unavailable)
    // -----------------------------------------------------------------------
    let mut ably_retry: RetryState<AblyReconnectHandle> =
        RetryState::new(ABLY_BACKOFF_INITIAL, ABLY_BACKOFF_MAX, None);

    let ably_config = make_ably_config(&api, &config.group);
    let mut ably = match ably_subscriber::subscribe(ably_config).await {
        Ok(sub) => {
            info!("ably connected");
            Some(sub)
        }
        Err(e) => {
            warn!(error = %e, "ably unavailable, will retry");
            // Don't use on_failure() here — it would double the backoff, but the
            // initial connection attempt should retry with the initial delay.
            ably_retry.schedule();
            ably_retry.consecutive_failures = 1;
            None
        }
    };
    let mut ably_connected = ably.is_some();

    // -----------------------------------------------------------------------
    // Mitmproxy crash-restart state (same shape as Ably)
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
    // Main loop
    // -----------------------------------------------------------------------
    let mut poll_now = true; // immediate first poll to clear any backlog
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
                // Don't accept new jobs, wait for running ones to complete.
                // Still restart mitmproxy — running jobs need the proxy.
                if jobs.is_empty() {
                    info!("all jobs drained");
                    break;
                }

                // Spawn background restart task when timer fires
                maybe_spawn_mitm_restart(
                    &mut config.mitm,
                    &mut config.mitm_crash_rx,
                    &mut mitm_retry,
                )
                .await;

                tokio::select! {
                    _ = mode_rx.changed() => {}
                    result = jobs.join_next() => {
                        if let Some(Err(e)) = result {
                            error!(error = %e, "job task panicked");
                        }
                    }
                    _ = config.mitm_crash_rx.recv() => {
                        warn!("mitmproxy exited unexpectedly, scheduling restart");
                        mitm_retry.schedule();
                    }
                    result = recv_retry(&mut mitm_retry.handle) => {
                        handle_mitm_restart_result(result, &mut config.mitm, &mut mitm_retry);
                    }
                    _ = sleep_until_retry(&mitm_retry.restart_at) => {}
                }
                continue;
            }
            RunnerMode::Running => {}
        }

        // Spawn a background Ably reconnection task when the timer fires
        maybe_spawn_ably_reconnect(&ably, &api, &config.group, &mut ably_retry);

        // Spawn background restart task when timer fires
        maybe_spawn_mitm_restart(&mut config.mitm, &mut config.mitm_crash_rx, &mut mitm_retry)
            .await;

        // If all permits are taken, wait for a job to finish or mode change
        if semaphore.available_permits() == 0 {
            tokio::select! {
                _ = mode_rx.changed() => {}
                result = jobs.join_next() => {
                    if let Some(Err(e)) = result {
                        error!(error = %e, "job task panicked");
                    }
                }
                _ = config.mitm_crash_rx.recv() => {
                    warn!("mitmproxy exited unexpectedly, scheduling restart");
                    mitm_retry.schedule();
                }
                result = recv_retry(&mut mitm_retry.handle) => {
                    handle_mitm_restart_result(result, &mut config.mitm, &mut mitm_retry);
                }
                _ = sleep_until_retry(&mitm_retry.restart_at) => {}
            }
            continue;
        }

        // poll_now is only reset in the timer branch below so that Ably
        // events never consume the immediate-poll intent (select! picks a
        // random ready branch when Duration::ZERO races with a buffered event).
        let sleep_dur = if poll_now {
            Duration::ZERO
        } else if ably_connected {
            POLL_SLOW
        } else {
            POLL_FAST
        };

        tokio::select! {
            // Ably push notification
            event = recv_ably(&mut ably) => {
                match event {
                    Some(ably_subscriber::Event::Message(msg)) => {
                        if let Some(run_id) = parse_job_run_id(&msg) {
                            info!(run_id = %run_id, "ably: job notification");
                            claim_and_spawn(
                                run_id, &api, &factory, &config, &exec_config,
                                &semaphore, &mut jobs,
                            ).await;
                        }
                    }
                    Some(ably_subscriber::Event::Connected) => {
                        if !ably_connected {
                            ably_connected = true;
                            info!("ably reconnected");
                        }
                    }
                    Some(ably_subscriber::Event::Disconnected { reason }) => {
                        ably_connected = false;
                        warn!(
                            reason = reason.as_deref().unwrap_or("unknown"),
                            "ably disconnected, switching to fast poll"
                        );
                    }
                    Some(ably_subscriber::Event::Error { code, message }) => {
                        error!(code, message = %message, "ably fatal error, will reconnect");
                        ably = None;
                        ably_connected = false;
                        ably_retry.schedule();
                    }
                    None => {
                        warn!("ably subscription closed, will reconnect");
                        ably = None;
                        ably_connected = false;
                        ably_retry.schedule();
                    }
                }
                continue;
            }
            // Poll fallback (adaptive interval)
            _ = tokio::time::sleep(sleep_dur) => {
                poll_now = false;
                match api.poll(&config.group).await {
                    Ok(Some(job)) => {
                        info!(run_id = %job.run_id, "poll: job found");
                        claim_and_spawn(
                            job.run_id, &api, &factory, &config, &exec_config,
                            &semaphore, &mut jobs,
                        ).await;
                        poll_now = true;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        error!(error = %e, "poll failed");
                    }
                }
            }
            // Ably reconnection result (background task)
            result = recv_retry(&mut ably_retry.handle) => {
                handle_ably_reconnect_result(result, &mut ably, &mut ably_connected, &mut ably_retry);
            }
            // Mitmproxy crash detection
            _ = config.mitm_crash_rx.recv() => {
                warn!("mitmproxy exited unexpectedly, scheduling restart");
                mitm_retry.schedule();
            }
            // Mitmproxy restart result (background task)
            result = recv_retry(&mut mitm_retry.handle) => {
                handle_mitm_restart_result(result, &mut config.mitm, &mut mitm_retry);
            }
            // Mitmproxy restart timer
            _ = sleep_until_retry(&mitm_retry.restart_at) => {}
            // Mode changes (signals)
            _ = mode_rx.changed() => {}
        }
    }

    // -----------------------------------------------------------------------
    // Shutdown
    // -----------------------------------------------------------------------
    // Close Ably subscription and cancel any in-flight reconnection
    drop(ably);
    if let Some(h) = ably_retry.handle {
        h.abort();
    }
    if let Some(h) = mitm_retry.handle {
        h.abort();
    }

    // Drain running jobs
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

    // Stop proxy after all jobs have drained and factory is shut down.
    if let Err(e) = config.mitm.stop().await {
        warn!(error = %e, "proxy stop failed");
    }

    config.status.set_mode(RunnerMode::Stopped).await;
    info!("runner stopped");

    Ok(())
}

/// Claim a job and spawn an executor task.
async fn claim_and_spawn(
    run_id: uuid::Uuid,
    api: &ApiClient,
    factory: &Arc<FirecrackerFactory>,
    config: &RunConfig,
    exec_config: &Arc<ExecutorConfig>,
    semaphore: &Arc<Semaphore>,
    jobs: &mut JoinSet<()>,
) {
    // Acquire permit BEFORE claiming so that a claim is never left without
    // a corresponding complete (the spawned task guarantees the pairing).
    let permit = match semaphore.clone().acquire_owned().await {
        Ok(p) => p,
        Err(_) => {
            error!("semaphore closed unexpectedly");
            return;
        }
    };

    let context = match api.claim(run_id).await {
        Ok(ctx) => ctx,
        Err(RunnerError::AlreadyClaimed) => {
            info!(run_id = %run_id, "already claimed, skipping");
            return;
        }
        Err(e) => {
            error!(run_id = %run_id, error = %e, "claim failed");
            return;
        }
    };

    info!(run_id = %run_id, "job claimed, spawning executor");

    config.status.add_run(run_id).await;

    let api = api.clone();
    let factory = Arc::clone(factory);
    let exec_config = Arc::clone(exec_config);
    let status = Arc::clone(&config.status);
    let sandbox_token = context.sandbox_token.clone();

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

        // Structural guarantee: claim (above) is always paired with complete.
        report_complete(&api, &sandbox_token, run_id, exit_code, err.as_deref()).await;
        status.remove_run(run_id).await;
        drop(permit);
    });
}

/// Report job completion to the API with one retry on failure.
async fn report_complete(
    api: &ApiClient,
    sandbox_token: &str,
    run_id: uuid::Uuid,
    exit_code: i32,
    error: Option<&str>,
) {
    if let Err(e) = api.complete(sandbox_token, run_id, exit_code, error).await {
        warn!(run_id = %run_id, error = %e, "completion report failed, retrying");
        tokio::time::sleep(Duration::from_secs(2)).await;
        if let Err(e) = api.complete(sandbox_token, run_id, exit_code, error).await {
            error!(run_id = %run_id, error = %e, "failed to report completion after retry");
        }
    }
}

/// Parse `run_id` from an Ably job notification message.
fn parse_job_run_id(msg: &ably_subscriber::Message) -> Option<uuid::Uuid> {
    if msg.name.as_deref() != Some("job") {
        return None;
    }
    let raw = msg.data.get("runId").and_then(|v| v.as_str());
    match raw {
        Some(s) => match s.parse() {
            Ok(id) => Some(id),
            Err(e) => {
                warn!(value = %s, error = %e, "ably: invalid runId");
                None
            }
        },
        None => {
            warn!(data = %msg.data, "ably: job message missing runId");
            None
        }
    }
}

/// Receive from Ably subscription, or pend forever if not connected.
async fn recv_ably(
    ably: &mut Option<ably_subscriber::Subscription>,
) -> Option<ably_subscriber::Event> {
    match ably {
        Some(sub) => sub.next().await,
        None => std::future::pending().await,
    }
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

/// Await a background retry task, or pend forever if none is running.
async fn recv_retry<T, E: std::fmt::Display>(
    handle: &mut Option<tokio::task::JoinHandle<Result<T, E>>>,
) -> Result<T, String> {
    match handle {
        Some(h) => {
            let result = match h.await {
                Ok(Ok(val)) => Ok(val),
                Ok(Err(e)) => Err(e.to_string()),
                Err(e) => Err(format!("retry task panicked: {e}")),
            };
            *handle = None;
            result
        }
        None => std::future::pending().await,
    }
}

/// Handle the result of a background Ably reconnection task.
fn handle_ably_reconnect_result(
    result: Result<ably_subscriber::Subscription, String>,
    ably: &mut Option<ably_subscriber::Subscription>,
    ably_connected: &mut bool,
    retry: &mut RetryState<AblyReconnectHandle>,
) {
    match result {
        Ok(sub) => {
            if retry.consecutive_failures > 0 {
                info!(
                    attempts = retry.consecutive_failures,
                    "ably reconnected after failures"
                );
            } else {
                info!("ably reconnected");
            }
            *ably = Some(sub);
            *ably_connected = true;
            retry.on_success();
        }
        Err(e) => {
            // Capture before on_failure() — matches the delay actually scheduled.
            let next_secs = retry.backoff.as_secs();
            // Ably retries forever (max_failures = None), so this always returns true.
            let _ = retry.on_failure();
            if retry.consecutive_failures >= 10 {
                error!(
                    error = %e,
                    failures = retry.consecutive_failures,
                    next_attempt_secs = next_secs,
                    "ably reconnection failing persistently"
                );
            } else {
                warn!(error = %e, next_attempt_secs = next_secs, "ably reconnect failed");
            }
        }
    }
}

/// Spawn a background Ably reconnection task when the timer fires.
fn maybe_spawn_ably_reconnect(
    ably: &Option<ably_subscriber::Subscription>,
    api: &ApiClient,
    group: &str,
    retry: &mut RetryState<AblyReconnectHandle>,
) {
    if ably.is_some() || !retry.timer_ready() {
        return;
    }
    retry.clear_timer();
    let ably_config = make_ably_config(api, group);
    retry.handle = Some(tokio::spawn(ably_subscriber::subscribe(ably_config)));
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
            if retry.consecutive_failures > 0 {
                info!(
                    attempts = retry.consecutive_failures,
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
            let next_secs = retry.backoff.as_secs();
            if !retry.on_failure() {
                error!(
                    error = %e,
                    failures = retry.consecutive_failures,
                    "mitmproxy restart abandoned after too many failures"
                );
                return;
            }
            if retry.consecutive_failures >= 5 {
                error!(
                    error = %e,
                    failures = retry.consecutive_failures,
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

/// Create a fresh `SubscribeConfig` for Ably connection.
///
/// `SubscribeConfig` is consumed by `subscribe()` and is not `Clone`,
/// so we recreate it for each connection attempt.
fn make_ably_config(api: &ApiClient, group: &str) -> ably_subscriber::SubscribeConfig {
    let api = api.clone();
    let channel = format!("runner-group:{group}");
    let group = group.to_owned();
    let get_token: Box<dyn Fn() -> ably_subscriber::TokenFuture + Send + Sync> =
        Box::new(move || {
            let api = api.clone();
            let group = group.clone();
            Box::pin(async move {
                api.realtime_token(&group)
                    .await
                    .map_err(|e| Box::new(e) as ably_subscriber::BoxError)
            })
        });
    ably_subscriber::SubscribeConfig::new(get_token, channel)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_message(name: Option<&str>, data: serde_json::Value) -> ably_subscriber::Message {
        ably_subscriber::Message {
            name: name.map(String::from),
            data,
            id: None,
            client_id: None,
            timestamp: None,
        }
    }

    #[test]
    fn parse_job_run_id_valid() {
        let msg = make_message(
            Some("job"),
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000001" }),
        );
        let id = parse_job_run_id(&msg).unwrap();
        assert_eq!(id.to_string(), "00000000-0000-0000-0000-000000000001");
    }

    #[test]
    fn parse_job_run_id_wrong_event_name() {
        let msg = make_message(
            Some("status"),
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000001" }),
        );
        assert!(parse_job_run_id(&msg).is_none());
    }

    #[test]
    fn parse_job_run_id_missing_name() {
        let msg = make_message(
            None,
            serde_json::json!({ "runId": "00000000-0000-0000-0000-000000000001" }),
        );
        assert!(parse_job_run_id(&msg).is_none());
    }

    #[test]
    fn parse_job_run_id_invalid_uuid() {
        let msg = make_message(Some("job"), serde_json::json!({ "runId": "not-a-uuid" }));
        assert!(parse_job_run_id(&msg).is_none());
    }

    #[test]
    fn parse_job_run_id_missing_field() {
        let msg = make_message(Some("job"), serde_json::json!({ "other": "data" }));
        assert!(parse_job_run_id(&msg).is_none());
    }

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
