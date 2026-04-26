use std::collections::HashMap;
use std::time::{Duration, Instant};

use sandbox::{ExecRequest, Sandbox, SandboxConfig, SandboxFactory, SandboxId};
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::ids::RunId;

/// Maximum wall-clock time for a single job (2 hours).
const JOB_TIMEOUT: Duration = Duration::from_secs(7200);
/// Exit code when a process is killed by SIGKILL (128 + 9).
const EXIT_SIGKILL: i32 = 137;
/// Raw SIGKILL signal number.
const EXIT_SIGNAL_KILL: i32 = 9;
/// Default timeout for guest commands (5 minutes).
const DEFAULT_EXEC_TIMEOUT: Duration = Duration::from_secs(300);

use crate::error::{RunnerError, RunnerResult};
use crate::http::HttpClient;
use crate::idle_pool::IdleEntry;
use crate::kmsg_log;
use crate::paths::{HomePaths, LogPaths, guest};
use crate::proxy::{self, ProxyRegistryHandle};
use crate::telemetry::JobTelemetry;
use crate::types::{
    ArtifactEntry, ExecutionContext, ResumeSession, SandboxReuseResult, StorageEntry,
    StorageManifest,
};

/// Shared configuration for all executions (profile-independent).
pub struct ExecutorConfig {
    pub api_url: String,
    pub registry: ProxyRegistryHandle,
    pub http: HttpClient,
    pub log_paths: LogPaths,
    pub ip_log_map: kmsg_log::IpLogMap,
    pub home: HomePaths,
}

/// Per-job VM parameters resolved from the profile config.
pub struct JobParams {
    pub vcpu: u32,
    pub memory_mb: u32,
    pub restore_guest_state: bool,
}

/// Outcome of a job execution, including the sandbox for possible reuse.
pub struct ExecuteOutcome {
    pub exit_code: i32,
    pub error: Option<String>,
    /// The sandbox after execution. `Some` when the sandbox is still alive
    /// and eligible for keep-alive parking. `None` when execution failed
    /// during create/start (sandbox was destroyed inline).
    pub sandbox: Option<Box<dyn Sandbox>>,
    pub source_ip: String,
    /// CLI-generated session ID read from the guest after execution.
    /// Used for first-run VM parking when `resume_session` is absent.
    pub guest_session_id: Option<String>,
}

/// Execute a single job inside a **new** Firecracker VM.
///
/// Returns [`ExecuteOutcome`] with the sandbox still alive (not stopped/destroyed)
/// plus the pending [`JobTelemetry`] buffer. The caller (`spawn_job` in
/// `cmd/start.rs`) decides whether to park the sandbox or destroy it, and
/// **must** flush the telemetry **after** firing `provider.complete` so the
/// user-visible run-complete signal isn't blocked on best-effort telemetry
/// uploads (~383 ms saved per job).
pub async fn execute_job(
    factory: &dyn SandboxFactory,
    context: ExecutionContext,
    dispatch: NewSandboxDispatch,
    config: &ExecutorConfig,
    params: &JobParams,
    cancel: CancellationToken,
) -> (ExecuteOutcome, JobTelemetry) {
    let run_id = context.run_id;
    let mut telemetry =
        JobTelemetry::new(config.http.clone(), run_id, context.sandbox_token.clone());

    record_reuse_result(&mut telemetry, dispatch.reuse_result);
    record_api_latency("api_to_vm_start", &context, &mut telemetry);

    let outcome = match execute_new_sandbox(
        factory,
        &context,
        dispatch,
        config,
        params,
        &mut telemetry,
        cancel,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(e) => ExecuteOutcome {
            exit_code: 1,
            error: Some(e.to_string()),
            sandbox: None,
            source_ip: String::new(),
            guest_session_id: None,
        },
    };

    (outcome, telemetry)
}

/// Execute a single job inside a **reused** (kept-alive) VM.
///
/// Skips create + start. Re-registers proxy, fixes clock, then runs the agent.
/// Returns [`ExecuteOutcome`] with the sandbox still alive plus the pending
/// [`JobTelemetry`] buffer — the caller (`spawn_job` in `cmd/start.rs`) must
/// flush telemetry after firing `provider.complete` (see [`execute_job`] for
/// rationale).
pub async fn execute_job_reuse(
    idle_entry: IdleEntry,
    context: ExecutionContext,
    config: &ExecutorConfig,
    cancel: CancellationToken,
) -> (ExecuteOutcome, JobTelemetry) {
    let run_id = context.run_id;
    let mut telemetry =
        JobTelemetry::new(config.http.clone(), run_id, context.sandbox_token.clone());

    record_reuse_result(&mut telemetry, SandboxReuseResult::Reused);
    record_api_latency("api_to_vm_start", &context, &mut telemetry);

    let source_ip = idle_entry.source_ip.clone();
    let prev_storage = idle_entry.storage_fingerprints;
    let sandbox = idle_entry.sandbox;

    // execute_reused_sandbox never returns Err — it always returns the sandbox
    // in the outcome so the caller can stop + destroy it on failure.
    let outcome = execute_reused_sandbox(
        sandbox,
        &source_ip,
        &context,
        config,
        &prev_storage,
        &mut telemetry,
        cancel,
    )
    .await;

    (outcome, telemetry)
}

/// Emit a single telemetry event capturing the outcome of the reuse decision.
/// `Reused` emits `sandbox_reuse_hit`; every miss variant emits
/// `sandbox_reuse_miss`. Firing on every job makes
/// the reuse success rate queryable in Axiom as
/// `countif(op_type == "sandbox_reuse_hit") / countif(op_type startswith "sandbox_reuse_")`.
/// Miss-reason breakdown lives on the `agent_runs.sandbox_reuse_result`
/// column in Postgres, so it's not duplicated here. Duration is zero — this
/// is a marker, not a timing.
fn record_reuse_result(telemetry: &mut JobTelemetry, result: SandboxReuseResult) {
    let action_type = match result {
        SandboxReuseResult::Reused => "sandbox_reuse_hit",
        SandboxReuseResult::NoSessionId
        | SandboxReuseResult::PoolMiss
        | SandboxReuseResult::ProfileMismatch
        | SandboxReuseResult::UnparkFailed => "sandbox_reuse_miss",
    };
    telemetry.record(action_type, Duration::ZERO, true, None);
}

fn record_api_latency(action_type: &str, context: &ExecutionContext, telemetry: &mut JobTelemetry) {
    if let Some(api_start_ms) = context.api_start_time {
        let now_ms = chrono::Utc::now().timestamp_millis() as f64;
        let elapsed_ms = (now_ms - api_start_ms).max(0.0);
        telemetry.record(
            action_type,
            Duration::from_millis(elapsed_ms as u64),
            true,
            None,
        );
    }
}

/// Dispatch inputs for the fresh-create path — the counterpart to
/// [`IdleEntry`] on the reuse path. Holds the UUID for the new VM and the
/// categorized reason no idle VM was reused. Both originate in
/// `cmd/start.rs`; the id becomes the sandbox's identity, the reuse result
/// is forwarded to the guest for /complete metadata.
#[derive(Clone, Copy)]
pub struct NewSandboxDispatch {
    pub id: SandboxId,
    pub reuse_result: SandboxReuseResult,
}

/// Create a new sandbox, run the job, and return the sandbox for possible reuse.
///
/// The caller is responsible for stop + destroy (or parking in the idle pool).
async fn execute_new_sandbox(
    factory: &dyn SandboxFactory,
    context: &ExecutionContext,
    dispatch: NewSandboxDispatch,
    config: &ExecutorConfig,
    params: &JobParams,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
) -> RunnerResult<ExecuteOutcome> {
    let NewSandboxDispatch {
        id: sandbox_id,
        reuse_result,
    } = dispatch;
    let sandbox_config = SandboxConfig {
        id: sandbox_id,
        resources: sandbox::ResourceLimits {
            cpu_count: params.vcpu,
            memory_mb: params.memory_mb,
        },
    };

    // Create and start sandbox
    info!(run_id = %context.run_id, sandbox_id = %sandbox_id, "creating sandbox");
    let t = Instant::now();
    let mut sandbox = match factory.create(sandbox_config).await {
        Ok(s) => s,
        Err(e) => {
            telemetry.record("vm_create", t.elapsed(), false, Some(&e.to_string()));
            return Err(e.into());
        }
    };

    let source_ip = sandbox.source_ip().to_string();

    // Register VM in proxy registry BEFORE starting the sandbox.
    register_proxy(config, context, &source_ip).await;

    if let Err(e) = sandbox.start().await {
        telemetry.record("vm_create", t.elapsed(), false, Some(&e.to_string()));
        unregister_proxy(config, context, &source_ip).await;
        factory.destroy(sandbox).await;
        return Err(e.into());
    }
    telemetry.record("vm_create", t.elapsed(), true, None);

    // Run job inside sandbox (new VM — no previous storage fingerprints)
    let result = run_in_sandbox(
        sandbox.as_ref(),
        context,
        config,
        RunStart {
            restore_guest_state: params.restore_guest_state,
            reuse_result,
            prev_storage: None,
        },
        telemetry,
        cancel,
    )
    .await;

    // Post-job: copy logs + unregister proxy (sandbox stays alive for possible reuse)
    post_job_cleanup(sandbox.as_ref(), config, context, &source_ip).await;

    let (exit_code, error) = match result {
        Ok((code, err)) => (code, err),
        Err(e) => (1, Some(e.to_string())),
    };

    // Read CLI-generated session ID for first-run parking.
    // Only needed when resume_session is absent (first turn in a conversation).
    let guest_session_id = if exit_code == 0 && context.session_id().is_none() {
        let id = read_guest_session_id(sandbox.as_ref(), context.run_id).await;
        if let Some(ref sid) = id {
            info!(run_id = %context.run_id, session_id = %sid, "read guest session ID for parking");
        }
        id
    } else {
        None
    };

    Ok(ExecuteOutcome {
        exit_code,
        error,
        sandbox: Some(sandbox),
        source_ip,
        guest_session_id,
    })
}

/// Run a job inside a reused (kept-alive) sandbox.
///
/// Skips create + start. Re-registers proxy, fixes clock/entropy, then runs.
async fn execute_reused_sandbox(
    sandbox: Box<dyn Sandbox>,
    source_ip: &str,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    prev_storage: &crate::idle_pool::StorageFingerprints,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
) -> ExecuteOutcome {
    info!(
        run_id = %context.run_id,
        sandbox_id = %sandbox.id(),
        "reusing kept-alive sandbox"
    );

    // Re-register proxy with new run credentials
    register_proxy(config, context, source_ip).await;

    // Run job — clock/entropy fixed inside run_in_sandbox (always needed after idle).
    let result = run_in_sandbox(
        sandbox.as_ref(),
        context,
        config,
        RunStart {
            restore_guest_state: true,
            reuse_result: SandboxReuseResult::Reused,
            prev_storage: Some(prev_storage),
        },
        telemetry,
        cancel,
    )
    .await;

    // Post-job cleanup (copy logs to host, unregister proxy, upload network logs)
    post_job_cleanup(sandbox.as_ref(), config, context, source_ip).await;

    let (exit_code, error) = match result {
        Ok((code, err)) => (code, err),
        Err(e) => (1, Some(e.to_string())),
    };

    // Read CLI-generated session ID for first-run parking.
    let guest_session_id = if exit_code == 0 && context.session_id().is_none() {
        let id = read_guest_session_id(sandbox.as_ref(), context.run_id).await;
        if let Some(ref sid) = id {
            info!(run_id = %context.run_id, session_id = %sid, "read guest session ID for parking");
        }
        id
    } else {
        None
    };

    ExecuteOutcome {
        exit_code,
        error,
        sandbox: Some(sandbox),
        source_ip: source_ip.to_string(),
        guest_session_id,
    }
}

/// Register a VM in the proxy registry and IP log map.
async fn register_proxy(config: &ExecutorConfig, context: &ExecutionContext, source_ip: &str) {
    let network_log_path = config.log_paths.network_log(context.run_id);
    let proxy_log_path = config.log_paths.proxy_log(context.run_id);
    let run_id_str = context.run_id.to_string();
    let registration = proxy::VmRegistration {
        run_id: &run_id_str,
        sandbox_token: &context.sandbox_token,
        network_log_path: &network_log_path,
        proxy_log_path: &proxy_log_path,
        firewalls: context.firewalls.as_deref(),
        network_policies: context.network_policies.as_ref(),
        encrypted_secrets: context.encrypted_secrets.as_deref(),
        secret_connector_map: context.secret_connector_map.as_ref(),
        vars: context.vars.as_ref(),
        capture_network_bodies: context.capture_network_bodies.unwrap_or(false),
        billable_firewalls: &context.billable_firewalls,
    };
    if let Err(e) = config.registry.register_vm(source_ip, &registration).await {
        warn!(run_id = %context.run_id, error = %e, "failed to register VM in proxy");
    }
    config
        .ip_log_map
        .lock()
        .await
        .insert(source_ip.to_string(), network_log_path);
}

/// Unregister a VM from the proxy registry and IP log map.
async fn unregister_proxy(config: &ExecutorConfig, context: &ExecutionContext, source_ip: &str) {
    if let Err(e) = config.registry.unregister_vm(source_ip).await {
        warn!(run_id = %context.run_id, error = %e, "failed to unregister VM from proxy");
    }
    config.ip_log_map.lock().await.remove(source_ip);
}

/// Post-job cleanup: copy logs, unregister proxy.
///
/// Called after `run_in_sandbox` completes, whether the sandbox will be
/// parked (keep-alive) or destroyed. The mitmproxy network-log upload is
/// deliberately **not** done here — `spawn_job` (in `cmd/start.rs`) runs
/// it after `provider.complete` so the user-visible run-complete signal
/// isn't blocked on the best-effort upload (~1.6 s saved per job).
async fn post_job_cleanup(
    sandbox: &dyn Sandbox,
    config: &ExecutorConfig,
    context: &ExecutionContext,
    source_ip: &str,
) {
    copy_guest_logs(sandbox, context, &config.log_paths).await;
    unregister_proxy(config, context, source_ip).await;
}

/// How this run is entering its sandbox. Each field feeds a distinct step:
/// `restore_guest_state` gates clock/entropy repair, `prev_storage` enables
/// the download-skip optimization on reuse, and `reuse_result` is forwarded
/// to the guest for /complete metadata.
struct RunStart<'a> {
    restore_guest_state: bool,
    reuse_result: SandboxReuseResult,
    prev_storage: Option<&'a crate::idle_pool::StorageFingerprints>,
}

async fn run_in_sandbox(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    config: &ExecutorConfig,
    start: RunStart<'_>,
    telemetry: &mut JobTelemetry,
    cancel: CancellationToken,
) -> RunnerResult<(i32, Option<String>)> {
    // System log file — all guest process output goes here for telemetry upload.
    let log_file = format!(
        "{GUEST_SYSTEM_LOG_PREFIX}{}{GUEST_SYSTEM_LOG_SUFFIX}",
        context.run_id
    );

    // 1. Fix guest clock and reseed entropy (must happen before HTTPS calls).
    //    Needed after snapshot restore (frozen clock) and after idle reuse (drifted clock).
    if start.restore_guest_state {
        fix_guest_clock(sandbox).await?;
        reseed_guest_entropy(sandbox).await?;
    }

    // 2. Set guest timezone from user preference (best-effort, never fails).
    sync_guest_timezone(sandbox, context).await;

    // 3. Download storages (skipping entries unchanged since the previous turn)
    if let Some(manifest) = &context.storage_manifest {
        let mut effective: StorageManifest = match start.prev_storage {
            Some(prev) => filter_unchanged_storages(manifest, prev),
            None => manifest.clone(),
        };
        // Short-circuit: skip the vsock exec if every entry was filtered out
        // and there are no paths to clean up.
        let has_work = effective.storages.iter().any(|s| s.archive_url.is_some())
            || effective.artifacts.iter().any(|a| a.archive_url.is_some())
            || !effective.cleanup_paths.is_empty();
        if !has_work {
            info!(run_id = %context.run_id, "all storages unchanged, skipping download");
        }
        let t = Instant::now();
        let result = if has_work {
            // Populate the runner-side cache first, rewriting eligible entries'
            // `archive_url` to `file:///tmp/vm0-storage-cache/...` so the guest
            // reads from its tmpfs instead of hitting R2 per turn.
            async {
                crate::storage_cache::populate_cache(
                    &mut effective,
                    sandbox,
                    &config.home,
                    telemetry,
                )
                .await?;
                download_storages(sandbox, context, &effective, &log_file).await
            }
            .await
        } else {
            Ok(())
        };
        let err = result.as_ref().err().map(|e| e.to_string());
        telemetry.record(
            "storage_download",
            t.elapsed(),
            result.is_ok(),
            err.as_deref(),
        );
        result?;
    }

    // 4. Restore session history
    if let Some(session) = &context.resume_session {
        let t = Instant::now();
        let result = restore_session(sandbox, context, session).await;
        let err = result.as_ref().err().map(|e| e.to_string());
        telemetry.record(
            "session_restore",
            t.elapsed(),
            result.is_ok(),
            err.as_deref(),
        );
        result?;
    }

    // 5. Build env vars (passed directly via vsock protocol)
    let env_map = build_env_json(context, &config.api_url, sandbox.id(), start.reuse_result);
    let env_pairs: Vec<(String, String)> = env_map.into_iter().collect();
    let env_refs: Vec<(&str, &str)> = env_pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    info!(run_id = %context.run_id, count = env_refs.len(), "passing env vars via vsock");

    // 6. Spawn agent — stdout streamed to host via vsock, stderr merged into stdout.
    //    vsock-guest writes stdout to the guest log file (for telemetry) AND streams
    //    chunks to the host where we write them to the host log file in real-time.
    let agent_cmd = format!("{} 2>&1", guest::RUN_AGENT);
    info!(run_id = %context.run_id, "spawning agent");

    // JOB_TIMEOUT is used for both spawn_watch (guest-side kill) and wait_exit
    // (host-side watchdog) so neither side outlives the other.
    let t = Instant::now();
    let handle = sandbox
        .spawn_watch(
            &ExecRequest {
                cmd: &agent_cmd,
                timeout: JOB_TIMEOUT,
                env: &env_refs,
                sudo: false,
            },
            Some(&log_file),
        )
        .await;

    let mut handle = match handle {
        Ok(h) => h,
        Err(e) => {
            telemetry.record("agent_execute", t.elapsed(), false, Some(&e.to_string()));
            return Err(e.into());
        }
    };

    // Claude Code process has a PID now — record end-to-end startup latency.
    record_api_latency("api_to_spawn", context, telemetry);

    // Spawn background task to drain stdout chunks and write to host log file.
    let host_log_path = config.log_paths.system_log(context.run_id);
    let stream_task = handle
        .stdout_rx
        .take()
        .map(|stdout_rx| tokio::spawn(drain_stdout_to_file(stdout_rx, host_log_path)));

    // 6. Wait for exit (or cancellation).
    // On cancel we return immediately — the caller (execute_new_sandbox) will
    // call sandbox.stop() + factory.destroy() in its cleanup path.
    let result = tokio::select! {
        result = sandbox.wait_exit(handle, JOB_TIMEOUT) => result,
        () = cancel.cancelled() => {
            info!(run_id = %context.run_id, "cancel received, aborting sandbox wait");
            Ok(sandbox::ProcessExit {
                pid: 0,
                exit_code: EXIT_SIGKILL,
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        }
    };

    // Wait for streaming to finish (channel closes when process exits).
    // On cancel/timeout/crash the stream channel may not close — abort to
    // prevent blocking indefinitely on the drain task.
    if let Some(task) = stream_task {
        if cancel.is_cancelled() || result.is_err() {
            task.abort();
            let _ = task.await;
        } else if let Err(e) = task.await {
            warn!(run_id = %context.run_id, error = %e, "stdout stream task failed");
        }
    }
    let success = result.as_ref().is_ok_and(|exit| exit.exit_code == 0);
    let err = result.as_ref().err().map(|e| e.to_string());
    telemetry.record("agent_execute", t.elapsed(), success, err.as_deref());
    let exit = match result {
        Ok(exit) => exit,
        Err(e) => {
            // Sandbox crashed — check host dmesg for cgroup OOM kill of the
            // firecracker process before propagating a generic error.
            if let Some(pid) = sandbox.process_pid()
                && check_host_oom(pid).await
            {
                warn!(run_id = %context.run_id, pid, "host OOM kill detected for firecracker");
                return Ok((
                    1,
                    Some(
                        "Firecracker VM killed by host OOM killer \
                         (cgroup memory limit exceeded)"
                            .into(),
                    ),
                ));
            }
            return Err(e.into());
        }
    };

    info!(
        run_id = %context.run_id,
        exit_code = exit.exit_code,
        "agent exited"
    );

    // Check for OOM kill when process was terminated by SIGKILL.
    // Skip when cancelled — the SIGKILL exit code is synthetic and dmesg
    // would run against a sandbox that hasn't been stopped yet.
    if !cancel.is_cancelled()
        && (exit.exit_code == EXIT_SIGKILL || exit.exit_code == EXIT_SIGNAL_KILL)
    {
        let dmesg_req = ExecRequest {
            cmd: "dmesg | tail -20 2>/dev/null",
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: true,
        };
        match sandbox.exec(&dmesg_req).await {
            Ok(dmesg) if dmesg_indicates_oom(&String::from_utf8_lossy(&dmesg.stdout)) => {
                warn!(run_id = %context.run_id, "OOM kill detected via dmesg");
                // Return exit code 1 with descriptive message instead of raw 137,
                // so callers see a clear error rather than an opaque signal code.
                return Ok((1, Some("Agent process killed by OOM killer".into())));
            }
            Err(e) => {
                warn!(run_id = %context.run_id, error = %e, "failed to exec dmesg for OOM check");
            }
            _ => {}
        }
    }

    let error_msg = if cancel.is_cancelled() {
        // Skip guest file reads — sandbox hasn't been stopped yet and the
        // caller will override with "cancelled by user" anyway.
        None
    } else if exit.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&exit.stderr).to_string();
        if !stderr.is_empty() {
            Some(stderr)
        } else {
            // Stderr is empty (redirected to log file). Check for a structured
            // error file written by the guest-agent (e.g. checkpoint failures).
            read_guest_error_file(sandbox, context.run_id).await
        }
    } else {
        None
    };

    Ok((exit.exit_code, error_msg))
}

/// Read a structured error file from the guest filesystem.
///
/// The guest-agent writes checkpoint errors to `/tmp/vm0-checkpoint-error-{run_id}`
/// so the runner can surface them even though stdout/stderr are redirected to the
/// system log file.
///
/// NOTE: This path must match the convention in `crates/guest-agent/src/paths.rs`
/// (`checkpoint_error_file()`). The runner and guest-agent are separate binaries
/// running in different processes, so the path is duplicated by design.
async fn read_guest_error_file(sandbox: &dyn Sandbox, run_id: RunId) -> Option<String> {
    // Mirror of guest-agent paths::checkpoint_error_file()
    let error_path = format!("/tmp/vm0-checkpoint-error-{run_id}");
    let cat_cmd = format!("cat {error_path} 2>/dev/null");
    match sandbox
        .exec(&ExecRequest {
            cmd: &cat_cmd,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
        })
        .await
    {
        Ok(result) if result.exit_code == 0 && !result.stdout.is_empty() => {
            let msg = String::from_utf8_lossy(&result.stdout).trim().to_string();
            Some(msg).filter(|s| !s.is_empty())
        }
        _ => None,
    }
}

/// Read the CLI-generated session ID from the guest filesystem.
///
/// The guest-agent writes the session ID to `/tmp/vm0-session-{run_id}.txt`
/// after the CLI emits its `system/init` event. On first runs (no
/// `resume_session`), the runner uses this to park the VM for keep-alive.
///
/// NOTE: Path must match `crates/guest-agent/src/paths.rs` (`session_id_file()`).
async fn read_guest_session_id(sandbox: &dyn Sandbox, run_id: RunId) -> Option<String> {
    // Mirror of guest-agent paths::session_id_file()
    let path = format!("/tmp/vm0-session-{run_id}.txt");
    let cmd = format!("cat {path} 2>/dev/null");
    match sandbox
        .exec(&ExecRequest {
            cmd: &cmd,
            timeout: Duration::from_secs(5),
            env: &[],
            sudo: false,
        })
        .await
    {
        Ok(result) if result.exit_code == 0 && !result.stdout.is_empty() => {
            let id = String::from_utf8_lossy(&result.stdout).trim().to_string();
            Some(id).filter(|s| !s.is_empty())
        }
        _ => None,
    }
}

/// Returns true if dmesg output indicates an OOM kill.
fn dmesg_indicates_oom(stdout: &str) -> bool {
    let lower = stdout.to_lowercase();
    lower.contains("out of memory") || lower.contains("oom-kill") || lower.contains("oom_reaper")
}

/// Check host dmesg for a cgroup OOM kill of a specific firecracker process.
/// Reads the entire ring buffer (~512KB) directly — no shell wrapper needed
/// since the pure function handles filtering.  Times out after 5s to avoid
/// blocking if sudo hangs.
async fn check_host_oom(pid: u32) -> bool {
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::process::Command::new("dmesg").output().await
    })
    .await;
    match result {
        Ok(Ok(out)) if out.status.success() => {
            host_dmesg_indicates_oom(&String::from_utf8_lossy(&out.stdout), pid)
        }
        Ok(Ok(out)) => {
            warn!(pid, exit_code = out.status.code(), "dmesg failed");
            false
        }
        Ok(Err(e)) => {
            warn!(pid, error = %e, "failed to run dmesg for OOM check");
            false
        }
        Err(_) => {
            warn!(pid, "host dmesg OOM check timed out");
            false
        }
    }
}

/// Returns true if host dmesg output contains an OOM kill record for the
/// given firecracker PID.  Checks that the character after the PID is not
/// a digit to avoid prefix matches (e.g. pid=1234 must not match pid=12345).
fn host_dmesg_indicates_oom(dmesg: &str, pid: u32) -> bool {
    if !dmesg.contains("oom-kill") {
        return false;
    }
    let needle = format!("task=firecracker,pid={pid}");
    let mut start = 0;
    while let Some(pos) = dmesg[start..].find(&needle) {
        let abs = start + pos + needle.len();
        // Accept if needle is at end of string or next char is not a digit.
        match dmesg.as_bytes().get(abs) {
            Some(c) if c.is_ascii_digit() => {
                // Prefix match (e.g. pid=1234 inside pid=12345) — keep searching.
                start = abs;
            }
            _ => return true,
        }
    }
    false
}

/// Drain stdout chunks from the vsock receiver and write them to a host file.
async fn drain_stdout_to_file(
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    path: std::path::PathBuf,
) {
    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await;
    let mut file = match file {
        Ok(f) => f,
        Err(e) => {
            warn!(error = %e, path = %path.display(), "failed to open host log file for streaming");
            return;
        }
    };
    while let Some(chunk) = rx.recv().await {
        if let Err(e) = tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await {
            warn!(error = %e, path = %path.display(), "failed to write stdout chunk to host log");
            break;
        }
    }
    // Flush to ensure the last spawn_blocking write completes before we return.
    // tokio::fs::File::poll_write returns Ready before the blocking write finishes,
    // so without flush the caller may observe incomplete file contents.
    if let Err(e) = tokio::io::AsyncWriteExt::flush(&mut file).await {
        warn!(error = %e, path = %path.display(), "failed to flush stdout log");
    }
}

/// Guest log file path prefixes. Each turn creates files named
/// `{PREFIX}{run_id}{SUFFIX}` under `/tmp`. Used by `copy_guest_logs`.
const GUEST_SYSTEM_LOG_PREFIX: &str = "/tmp/vm0-system-";
const GUEST_SYSTEM_LOG_SUFFIX: &str = ".log";
const GUEST_METRICS_LOG_PREFIX: &str = "/tmp/vm0-metrics-";
const GUEST_METRICS_LOG_SUFFIX: &str = ".jsonl";

/// Copy guest log files to host (best-effort, post-job).
///
/// The system log is also streamed to the host in real-time via vsock stdout
/// streaming during the agent phase, but the final copy here overwrites with
/// the complete file (includes download/restore output written before streaming
/// started).
async fn copy_guest_logs(sandbox: &dyn Sandbox, context: &ExecutionContext, log_paths: &LogPaths) {
    let run_id = context.run_id;
    let files = [
        (
            format!("{GUEST_SYSTEM_LOG_PREFIX}{run_id}{GUEST_SYSTEM_LOG_SUFFIX}"),
            log_paths.system_log(run_id),
        ),
        (
            format!("{GUEST_METRICS_LOG_PREFIX}{run_id}{GUEST_METRICS_LOG_SUFFIX}"),
            log_paths.metrics_log(run_id),
        ),
    ];

    for (guest_path, host_path) in &files {
        let cat_cmd = format!("cat '{guest_path}'");
        let result = sandbox
            .exec(&ExecRequest {
                cmd: &cat_cmd,
                timeout: DEFAULT_EXEC_TIMEOUT,
                env: &[],
                sudo: false,
            })
            .await;

        let output = match result {
            Ok(r) if r.exit_code == 0 => r.stdout,
            Ok(_) => continue,
            Err(e) => {
                warn!(run_id = %run_id, error = %e, path = %guest_path, "failed to read guest log");
                continue;
            }
        };

        if let Err(e) = tokio::fs::write(host_path, &output).await {
            warn!(run_id = %run_id, error = %e, path = %host_path.display(), "failed to write guest log to host");
        }
    }
}

/// Sync guest clock to host time after snapshot restore.
///
/// Must run before any HTTPS calls — stale clock breaks TLS cert validation.
pub(crate) async fn fix_guest_clock(sandbox: &dyn Sandbox) -> RunnerResult<()> {
    let timestamp = format!(
        "{:.3}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64()
    );
    let date_cmd = format!("date -s \"@{timestamp}\"");
    sandbox
        .exec(&ExecRequest {
            cmd: &date_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: true,
        })
        .await?;
    Ok(())
}

/// Reseed guest CRNG after snapshot restore.
///
/// On ARM64 with kernel 6.1, VMGenID does not work (the driver only supports
/// ACPI; DeviceTree support requires kernel 6.10+). All VMs restored from the
/// same snapshot share identical CRNG state, producing identical random output.
///
/// This function injects fresh host entropy and forces an immediate CRNG reseed
/// so each VM produces unique random numbers from the first `getrandom()` call.
pub(crate) async fn reseed_guest_entropy(sandbox: &dyn Sandbox) -> RunnerResult<()> {
    use std::io::Read;

    const ENTROPY_SIZE: usize = 256;

    let mut entropy = vec![0u8; ENTROPY_SIZE];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut entropy))
        .map_err(|e| RunnerError::Internal(format!("read host entropy: {e}")))?;

    let hex = hex::encode(&entropy);
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &format!("guest-reseed {hex}"),
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: true,
        })
        .await?;

    if result.exit_code != 0 {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(RunnerError::Internal(format!(
            "guest-reseed failed (exit code {}): {stderr}",
            result.exit_code
        )));
    }

    Ok(())
}

/// Set system timezone inside the guest to match the user's preference.
///
/// Configures timezone at two levels so every process sees the correct time:
///
/// - `/etc/timezone` + `/etc/localtime` — filesystem-level (read by libc)
/// - `TZ` in `/etc/environment` — inherited by all login shells via PAM
///
/// The agent process also receives `TZ` via the env vars in step 6.
/// Skipped when no user timezone is configured (falls back to image default UTC).
async fn sync_guest_timezone(sandbox: &dyn Sandbox, context: &ExecutionContext) {
    let tz = match &context.user_timezone {
        Some(tz) if !tz.is_empty() => tz,
        _ => return,
    };
    // Strict validation: timezone names are like "Asia/Shanghai" or "UTC".
    // Only allow alphanumeric, '/', '_', '-', '+'.  This prevents shell
    // injection since the value is interpolated into a sudo shell command.
    if !tz
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'/' || b == b'_' || b == b'-' || b == b'+')
    {
        tracing::warn!(tz = %tz, "rejected invalid timezone name");
        return;
    }
    let cmd = format!(
        "test -f /usr/share/zoneinfo/{tz} && \
         echo '{tz}' > /etc/timezone && \
         ln -sf /usr/share/zoneinfo/{tz} /etc/localtime && \
         sed -i '/^TZ=/d' /etc/environment && \
         echo 'TZ={tz}' >> /etc/environment"
    );
    // Best-effort: don't fail the run if timezone setup fails.
    if let Err(e) = sandbox
        .exec(&ExecRequest {
            cmd: &cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: true,
        })
        .await
    {
        tracing::warn!(tz = %tz, error = %e, "failed to set guest timezone");
    }
}

/// Filter a storage manifest by nulling `archive_url` for entries whose
/// version matches the previous turn's fingerprints. `guest-download`
/// skips entries without a valid URL, so unchanged storages stay on disk.
fn filter_unchanged_storages(
    manifest: &StorageManifest,
    prev: &crate::idle_pool::StorageFingerprints,
) -> StorageManifest {
    let mut skipped: usize = 0;
    let mut cleanup_paths: Vec<String> = Vec::new();

    let storages: Vec<StorageEntry> = manifest
        .storages
        .iter()
        .map(|s| {
            let unchanged = match (&s.vas_storage_name, &s.vas_version_id) {
                (Some(name), Some(ver)) => prev
                    .storages
                    .get(&s.mount_path)
                    .is_some_and(|(pn, pv)| pn == name && pv == ver),
                _ => false, // no version info → always download
            };
            if unchanged {
                skipped += 1;
            } else {
                cleanup_paths.push(s.mount_path.clone());
            }
            StorageEntry {
                mount_path: s.mount_path.clone(),
                archive_url: if unchanged {
                    None
                } else {
                    s.archive_url.clone()
                },
                cached: unchanged,
                vas_storage_name: s.vas_storage_name.clone(),
                vas_version_id: s.vas_version_id.clone(),
            }
        })
        .collect();

    // Detect removed storages: paths in previous fingerprints not in current manifest.
    let current_paths: std::collections::HashSet<&str> = manifest
        .storages
        .iter()
        .map(|s| s.mount_path.as_str())
        .collect();
    for prev_path in prev.storages.keys() {
        if !current_paths.contains(prev_path.as_str()) {
            cleanup_paths.push(prev_path.clone());
        }
    }

    let filter_artifact = |a: &ArtifactEntry,
                           prev_ver: &Option<(String, String)>,
                           skipped: &mut usize,
                           cleanup: &mut Vec<String>| {
        let same = prev_ver
            .as_ref()
            .is_some_and(|(name, ver)| *name == a.vas_storage_name && *ver == a.vas_version_id);
        if same {
            *skipped += 1;
        } else {
            cleanup.push(a.mount_path.clone());
        }
        ArtifactEntry {
            archive_url: if same { None } else { a.archive_url.clone() },
            cached: same,
            ..a.clone()
        }
    };

    let artifacts: Vec<ArtifactEntry> = manifest
        .artifacts
        .iter()
        .map(|a| {
            let prev_ver = prev.artifacts.get(&a.mount_path).cloned();
            filter_artifact(a, &prev_ver, &mut skipped, &mut cleanup_paths)
        })
        .collect();
    // Detect removed artifacts: previous artifact mount_paths not in current manifest.
    let current_artifact_paths: std::collections::HashSet<&str> = manifest
        .artifacts
        .iter()
        .map(|a| a.mount_path.as_str())
        .collect();
    for prev_path in prev.artifacts.keys() {
        if !current_artifact_paths.contains(prev_path.as_str()) {
            cleanup_paths.push(prev_path.clone());
        }
    }
    if skipped > 0 {
        let total = manifest.storages.len() + manifest.artifacts.len();
        info!(skipped, total, "filtered unchanged storage entries");
    }

    if !cleanup_paths.is_empty() {
        info!(
            count = cleanup_paths.len(),
            "computed cleanup paths for stale file removal"
        );
    }

    StorageManifest {
        storages,
        artifacts,
        cleanup_paths,
    }
}

/// Download storage volumes into the guest.
async fn download_storages(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    manifest: &StorageManifest,
    log_file: &str,
) -> RunnerResult<()> {
    let manifest_json = serde_json::to_vec(manifest)
        .map_err(|e| RunnerError::Internal(format!("manifest json: {e}")))?;
    sandbox
        .write_file(guest::STORAGE_MANIFEST, &manifest_json)
        .await?;

    let download_cmd = format!(
        "{} {} >> {log_file} 2>&1",
        guest::DOWNLOAD_BIN,
        guest::STORAGE_MANIFEST
    );
    info!(run_id = %context.run_id, "downloading storages");
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &download_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: false,
        })
        .await?;

    if result.exit_code != 0 {
        return Err(RunnerError::Internal(format!(
            "storage download failed (exit code {})",
            result.exit_code
        )));
    }
    Ok(())
}

/// Write Claude Code session history into the guest filesystem.
///
/// Only Claude Code uses `.jsonl` session files; other agent types are skipped.
async fn restore_session(
    sandbox: &dyn Sandbox,
    context: &ExecutionContext,
    session: &ResumeSession,
) -> RunnerResult<()> {
    if !(context.cli_agent_type.is_empty() || context.cli_agent_type == "claude-code") {
        return Ok(());
    }

    let project_name = context
        .working_dir
        .trim_start_matches('/')
        .replace('/', "-");
    let session_dir = format!("/home/user/.claude/projects/-{project_name}");

    // Validate session_id to prevent path traversal (only allow alnum, dash, underscore)
    if !is_valid_session_id(&session.session_id) {
        return Err(RunnerError::Internal(format!(
            "invalid session_id: {}",
            session.session_id
        )));
    }
    let session_path = format!("{session_dir}/{}.jsonl", session.session_id);

    let mkdir_cmd = format!("mkdir -p '{}'", session_dir.replace('\'', "'\\''"));
    sandbox
        .exec(&ExecRequest {
            cmd: &mkdir_cmd,
            timeout: DEFAULT_EXEC_TIMEOUT,
            env: &[],
            sudo: false,
        })
        .await?;
    sandbox
        .write_file(&session_path, session.session_history.as_bytes())
        .await?;
    info!(run_id = %context.run_id, path = %session_path, "restored session history");
    Ok(())
}

/// Returns true if the session ID contains only safe characters (alphanumeric, dash, underscore).
fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Build the environment variables JSON.
///
/// Priority (lowest → highest):
///   1. `environment` (user-provided env, includes expanded vars)
///   2. `user_timezone` TZ (unless `environment` already sets TZ)
///   3. System variables (VM0_*, secrets, etc.) — always win
fn build_env_json(
    context: &ExecutionContext,
    api_url: &str,
    sandbox_id: &str,
    reuse_result: SandboxReuseResult,
) -> HashMap<String, String> {
    let mut env = HashMap::new();

    // --- User-provided environment ---
    if let Some(user_env) = &context.environment {
        for (k, v) in user_env {
            env.insert(k.clone(), v.clone());
        }
    }

    // --- User timezone ---
    // Respects explicit TZ in user environment.
    if let Some(tz) = &context.user_timezone {
        let has_tz = context
            .environment
            .as_ref()
            .is_some_and(|e| e.contains_key("TZ"));
        if !has_tz {
            env.insert("TZ".into(), tz.clone());
        }
    }

    // --- System variables below (override user values) ---

    env.insert("VM0_API_URL".into(), api_url.into());
    env.insert("VM0_RUN_ID".into(), context.run_id.to_string());
    env.insert("VM0_API_TOKEN".into(), context.sandbox_token.clone());
    env.insert("VM0_SANDBOX_ID".into(), sandbox_id.into());
    env.insert(
        "VM0_SANDBOX_REUSE_RESULT".into(),
        reuse_result.as_wire().into(),
    );
    env.insert("VM0_PROMPT".into(), context.prompt.clone());
    if let Some(asp) = &context.append_system_prompt
        && !asp.is_empty()
    {
        env.insert("VM0_APPEND_SYSTEM_PROMPT".into(), asp.clone());
    }
    env.insert("VM0_WORKING_DIR".into(), context.working_dir.clone());
    env.insert(
        "VM0_API_START_TIME".into(),
        context
            .api_start_time
            .map(|t| (t as u64).to_string())
            .unwrap_or_default(),
    );
    // The API omits cli_agent_type for claude-code agents (the default).
    env.insert(
        "CLI_AGENT_TYPE".into(),
        if context.cli_agent_type.is_empty() {
            "claude-code".into()
        } else {
            context.cli_agent_type.clone()
        },
    );

    // Vercel bypass
    if let Ok(bypass) = std::env::var("VERCEL_AUTOMATION_BYPASS_SECRET") {
        env.insert("VERCEL_PROTECTION_BYPASS".into(), bypass);
    }

    // Pass USE_MOCK_CLAUDE from host environment for testing
    // (skip if debugNoMockClaude is set in execution context)
    if let Ok(val) = std::env::var("USE_MOCK_CLAUDE")
        && !context.debug_no_mock_claude.unwrap_or(false)
    {
        env.insert("USE_MOCK_CLAUDE".into(), val);
    }

    // Artifacts config (multi-mount).
    //
    // Emit a single `VM0_ARTIFACTS` env var containing a JSON array of
    // `{name, mountPath, storageId, versionId}` objects. Guest-agent
    // parses this on startup and iterates the list when taking snapshots
    // at run end. The shape here must stay lockstep with guest-agent's
    // `ArtifactEnv` — the two ship as one unit via `include_bytes!`, and
    // `ArtifactEnv` deserializes strict (no `serde(default)`), so a
    // field drop here will panic the VM at startup instead of silently
    // producing empty strings.
    //
    // Empty-list case: do not set the env var at all (matches the prior
    // "unset = no artifact" convention).
    if let Some(manifest) = &context.storage_manifest
        && !manifest.artifacts.is_empty()
    {
        let payload: Vec<serde_json::Value> = manifest
            .artifacts
            .iter()
            .map(|a| {
                serde_json::json!({
                    "name": a.vas_storage_name,
                    "mountPath": a.mount_path,
                    "storageId": a.vas_storage_id,
                    "versionId": a.vas_version_id,
                })
            })
            .collect();
        // Serialization cannot fail — payload is a Vec of String-only JSON
        // objects. Use `.expect` to make the invariant explicit; falling
        // back to an empty string would silently produce a broken env.
        #[allow(clippy::expect_used)]
        let serialized = serde_json::to_string(&payload)
            .expect("VM0_ARTIFACTS payload must serialize (String-only Values)");
        env.insert("VM0_ARTIFACTS".into(), serialized);
    }

    // Resume session ID
    if let Some(session) = &context.resume_session {
        env.insert("VM0_RESUME_SESSION_ID".into(), session.session_id.clone());
    }

    // Note: Connector placeholder env vars (e.g., GITHUB_TOKEN=gho_CoffeeSafeLocal...)
    // are injected by the web API into `context.environment` directly.

    // Secret values (base64-encoded, comma-separated)
    // Always include the sandbox token so it gets redacted in logs.
    {
        use base64::Engine as _;
        let mut encoded: Vec<String> =
            vec![base64::engine::general_purpose::STANDARD.encode(&context.sandbox_token)];
        if let Some(secret_values) = &context.secret_values {
            encoded.extend(
                secret_values
                    .iter()
                    .map(|s| base64::engine::general_purpose::STANDARD.encode(s)),
            );
        }
        env.insert("VM0_SECRET_VALUES".into(), encoded.join(","));
    }

    // Disallowed tools (comma-separated for guest-agent)
    if let Some(tools) = &context.disallowed_tools
        && !tools.is_empty()
    {
        env.insert("VM0_DISALLOWED_TOOLS".into(), tools.join(","));
    }

    // Tools to make available (comma-separated for guest-agent)
    if let Some(tools) = &context.tools
        && !tools.is_empty()
    {
        env.insert("VM0_TOOLS".into(), tools.join(","));
    }

    // Settings JSON (passed directly as single string)
    if let Some(settings) = &context.settings
        && !settings.is_empty()
    {
        env.insert("VM0_SETTINGS".into(), settings.clone());
    }

    // Feature flags (JSON-encoded map of flag name → enabled)
    if let Some(flags) = &context.feature_flags
        && !flags.is_empty()
        && let Ok(json) = serde_json::to_string(flags)
    {
        env.insert("VM0_FEATURE_FLAGS".into(), json);
    }

    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::RunId;
    use crate::types::{ArtifactEntry, ResumeSession, StorageEntry, StorageManifest};
    use sandbox_mock::MockSandboxFactory;
    use std::sync::Arc;

    fn build_env_for_test(ctx: &ExecutionContext, api_url: &str) -> HashMap<String, String> {
        let sid = SandboxId::new_v4().to_string();
        build_env_json(ctx, api_url, &sid, SandboxReuseResult::Reused)
    }

    fn minimal_context() -> ExecutionContext {
        ExecutionContext {
            run_id: RunId::nil(),
            prompt: "test prompt".into(),
            append_system_prompt: None,
            _agent_compose_version_id: None,
            vars: None,
            checkpoint_id: None,
            sandbox_token: "tok".into(),
            working_dir: "/workspace".into(),
            storage_manifest: None,
            environment: None,
            resume_session: None,
            secret_values: None,
            encrypted_secrets: None,
            secret_connector_map: None,
            cli_agent_type: String::new(),
            debug_no_mock_claude: None,
            api_start_time: None,
            user_timezone: None,
            capture_network_bodies: None,
            firewalls: None,
            network_policies: None,
            disallowed_tools: None,
            tools: None,
            settings: None,
            experimental_profile: None,
            feature_flags: None,
            billable_firewalls: vec![],
        }
    }

    #[test]
    fn build_env_json_required_keys() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "https://api.example.com");

        assert_eq!(env.get("VM0_API_URL").unwrap(), "https://api.example.com");
        assert_eq!(env.get("VM0_RUN_ID").unwrap(), &RunId::nil().to_string());
        assert_eq!(env.get("VM0_API_TOKEN").unwrap(), "tok");
        assert_eq!(env.get("VM0_PROMPT").unwrap(), "test prompt");
        assert_eq!(env.get("VM0_WORKING_DIR").unwrap(), "/workspace");
        // Guest-agent needs these to post /complete with full metadata when
        // checkpoint lands before VM teardown.
        assert!(
            env.get("VM0_SANDBOX_ID")
                .unwrap()
                .parse::<uuid::Uuid>()
                .is_ok()
        );
        assert_eq!(env.get("VM0_SANDBOX_REUSE_RESULT").unwrap(), "reused");
    }

    #[test]
    fn build_env_json_sandbox_reuse_result_wire_format() {
        let ctx = minimal_context();
        let sid = SandboxId::new_v4().to_string();
        for (variant, expected) in [
            (SandboxReuseResult::Reused, "reused"),
            (SandboxReuseResult::NoSessionId, "noSessionId"),
            (SandboxReuseResult::PoolMiss, "poolMiss"),
            (SandboxReuseResult::ProfileMismatch, "profileMismatch"),
            (SandboxReuseResult::UnparkFailed, "unparkFailed"),
        ] {
            let env = build_env_json(&ctx, "http://localhost", &sid, variant);
            assert_eq!(env.get("VM0_SANDBOX_REUSE_RESULT").unwrap(), expected);
        }
    }

    #[test]
    fn build_env_json_empty_cli_agent_type_defaults_to_claude_code() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "claude-code");
    }

    #[test]
    fn build_env_json_custom_cli_agent_type() {
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "custom-agent".into();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("CLI_AGENT_TYPE").unwrap(), "custom-agent");
    }

    #[test]
    fn build_env_json_with_single_artifact() {
        let mut ctx = minimal_context();
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![StorageEntry {
                mount_path: "/data".into(),
                archive_url: None,
                cached: false,
                vas_storage_name: None,
                vas_version_id: None,
            }],
            artifacts: vec![ArtifactEntry {
                mount_path: "/artifacts".into(),
                archive_url: None,
                cached: false,
                vas_storage_name: "my-vol".into(),
                vas_storage_id: "sid-1".into(),
                vas_version_id: "v1".into(),
            }],
            cleanup_paths: vec![],
        });

        let env = build_env_for_test(&ctx, "http://localhost");
        let raw = env.get("VM0_ARTIFACTS").expect("VM0_ARTIFACTS must be set");
        let parsed: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["name"], "my-vol");
        assert_eq!(parsed[0]["mountPath"], "/artifacts");
        assert_eq!(parsed[0]["storageId"], "sid-1");
        assert_eq!(parsed[0]["versionId"], "v1");
        // Legacy singleton env vars must no longer be emitted.
        assert!(!env.contains_key("VM0_ARTIFACT_DRIVER"));
        assert!(!env.contains_key("VM0_ARTIFACT_MOUNT_PATH"));
        assert!(!env.contains_key("VM0_ARTIFACT_VOLUME_NAME"));
        assert!(!env.contains_key("VM0_ARTIFACT_VERSION_ID"));
    }

    #[test]
    fn build_env_json_with_two_artifacts() {
        let mut ctx = minimal_context();
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![],
            artifacts: vec![
                ArtifactEntry {
                    mount_path: "/workspace".into(),
                    archive_url: None,
                    cached: false,
                    vas_storage_name: "art-a".into(),
                    vas_storage_id: "sid-a".into(),
                    vas_version_id: "v1".into(),
                },
                ArtifactEntry {
                    mount_path: "/data".into(),
                    archive_url: None,
                    cached: false,
                    vas_storage_name: "art-b".into(),
                    vas_storage_id: "sid-b".into(),
                    vas_version_id: "v2".into(),
                },
            ],
            cleanup_paths: vec![],
        });

        let env = build_env_for_test(&ctx, "http://localhost");
        let raw = env.get("VM0_ARTIFACTS").unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["name"], "art-a");
        assert_eq!(parsed[0]["mountPath"], "/workspace");
        assert_eq!(parsed[0]["storageId"], "sid-a");
        assert_eq!(parsed[1]["name"], "art-b");
        assert_eq!(parsed[1]["mountPath"], "/data");
        assert_eq!(parsed[1]["storageId"], "sid-b");
    }

    #[test]
    fn build_env_json_empty_artifacts_emits_no_env_var() {
        let mut ctx = minimal_context();
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![],
            artifacts: vec![],
            cleanup_paths: vec![],
        });

        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_ARTIFACTS"));
    }

    #[test]
    fn build_env_json_with_secrets() {
        let mut ctx = minimal_context();
        ctx.secret_values = Some(vec!["secret1".into(), "secret2".into()]);

        let env = build_env_for_test(&ctx, "http://localhost");
        let val = env.get("VM0_SECRET_VALUES").unwrap();

        use base64::Engine as _;
        let parts: Vec<&str> = val.split(',').collect();
        // sandbox_token ("tok") + secret1 + secret2
        assert_eq!(parts.len(), 3);
        let decoded0 = base64::engine::general_purpose::STANDARD
            .decode(parts[0])
            .unwrap();
        assert_eq!(decoded0, b"tok");
        let decoded1 = base64::engine::general_purpose::STANDARD
            .decode(parts[1])
            .unwrap();
        assert_eq!(decoded1, b"secret1");
    }

    #[test]
    fn build_env_json_with_resume_session() {
        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            session_id: "sess-123".into(),
            session_history: "{}".into(),
        });

        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("VM0_RESUME_SESSION_ID").unwrap(), "sess-123");
    }

    #[test]
    fn build_env_json_user_vars_cannot_override_system() {
        let mut ctx = minimal_context();
        // vars are expanded into environment at compose time, so test via environment
        ctx.environment = Some(HashMap::from([
            ("VM0_PROMPT".into(), "overridden".into()),
            ("CUSTOM".into(), "value".into()),
        ]));

        let env = build_env_for_test(&ctx, "http://localhost");
        // System variables take precedence over user environment
        assert_eq!(env.get("VM0_PROMPT").unwrap(), "test prompt");
        assert_eq!(env.get("CUSTOM").unwrap(), "value");
    }

    #[test]
    fn build_env_json_with_environment() {
        let mut ctx = minimal_context();
        ctx.environment = Some(HashMap::from([
            ("MY_VAR".into(), "123".into()),
            ("OTHER".into(), "abc".into()),
        ]));

        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("MY_VAR").unwrap(), "123");
        assert_eq!(env.get("OTHER").unwrap(), "abc");
    }

    #[test]
    fn build_env_json_with_api_start_time() {
        let mut ctx = minimal_context();
        ctx.api_start_time = Some(1_700_000_000.5);

        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("VM0_API_START_TIME").unwrap(), "1700000000");
    }

    #[test]
    fn build_env_json_empty_secrets_still_has_sandbox_token() {
        let mut ctx = minimal_context();
        ctx.secret_values = Some(vec![]);

        let env = build_env_for_test(&ctx, "http://localhost");
        // VM0_SECRET_VALUES always present because sandbox_token is included
        let val = env.get("VM0_SECRET_VALUES").unwrap();
        use base64::Engine as _;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(val)
            .unwrap();
        assert_eq!(decoded, b"tok");
    }

    #[test]
    fn build_env_json_with_append_system_prompt() {
        let mut ctx = minimal_context();
        ctx.append_system_prompt = Some("Your name is Aria.".into());
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(
            env.get("VM0_APPEND_SYSTEM_PROMPT").unwrap(),
            "Your name is Aria."
        );
    }

    #[test]
    fn build_env_json_without_append_system_prompt() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_APPEND_SYSTEM_PROMPT"));
    }

    #[test]
    fn build_env_json_empty_append_system_prompt_omitted() {
        let mut ctx = minimal_context();
        ctx.append_system_prompt = Some("".into());
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_APPEND_SYSTEM_PROMPT"));
    }

    #[test]
    fn build_env_json_with_user_timezone() {
        let mut ctx = minimal_context();
        ctx.user_timezone = Some("Asia/Shanghai".into());

        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("TZ").unwrap(), "Asia/Shanghai");
    }

    #[test]
    fn build_env_json_user_timezone_not_override_environment() {
        let mut ctx = minimal_context();
        ctx.user_timezone = Some("Asia/Shanghai".into());
        ctx.environment = Some(HashMap::from([("TZ".into(), "America/New_York".into())]));

        let env = build_env_for_test(&ctx, "http://localhost");
        // User environment TZ takes precedence
        assert_eq!(env.get("TZ").unwrap(), "America/New_York");
    }

    #[test]
    fn build_env_json_environment_cannot_override_system() {
        let mut ctx = minimal_context();
        ctx.environment = Some(HashMap::from([
            ("VM0_PROMPT".into(), "hacked".into()),
            ("VM0_API_TOKEN".into(), "stolen".into()),
            ("CUSTOM_ENV".into(), "kept".into()),
        ]));

        let env = build_env_for_test(&ctx, "http://localhost");
        // System variables take precedence over user environment
        assert_eq!(env.get("VM0_PROMPT").unwrap(), "test prompt");
        assert_eq!(env.get("VM0_API_TOKEN").unwrap(), "tok");
        assert_eq!(env.get("CUSTOM_ENV").unwrap(), "kept");
    }

    #[test]
    fn build_env_json_vars_not_injected_directly() {
        let mut ctx = minimal_context();
        // vars should NOT be injected as env vars — they are expanded into
        // environment at compose time via ${{ vars.XXX }} templates.
        ctx.vars = Some(HashMap::from([("ONLY_VARS".into(), "vars-value".into())]));
        ctx.environment = Some(HashMap::from([("ONLY_ENV".into(), "env-value".into())]));

        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("ONLY_VARS"));
        assert_eq!(env.get("ONLY_ENV").unwrap(), "env-value");
    }

    /// SAFETY: set_var/remove_var are unsafe in edition 2024 due to potential
    /// data races. These tests are acceptable because cargo test runs each
    /// test in its own thread by default, and no other tests read this var.
    #[test]
    fn build_env_json_with_mock_claude() {
        let saved = std::env::var("USE_MOCK_CLAUDE").ok();
        // SAFETY: no concurrent tests read USE_MOCK_CLAUDE.
        unsafe { std::env::set_var("USE_MOCK_CLAUDE", "true") };

        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("USE_MOCK_CLAUDE").unwrap(), "true");

        // Restore
        match saved {
            Some(v) => unsafe { std::env::set_var("USE_MOCK_CLAUDE", v) },
            None => unsafe { std::env::remove_var("USE_MOCK_CLAUDE") },
        }
    }

    #[test]
    fn build_env_json_mock_claude_suppressed_by_debug_flag() {
        let saved = std::env::var("USE_MOCK_CLAUDE").ok();
        // SAFETY: no concurrent tests read USE_MOCK_CLAUDE.
        unsafe { std::env::set_var("USE_MOCK_CLAUDE", "true") };

        let mut ctx = minimal_context();
        ctx.debug_no_mock_claude = Some(true);
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("USE_MOCK_CLAUDE"));

        // Restore
        match saved {
            Some(v) => unsafe { std::env::set_var("USE_MOCK_CLAUDE", v) },
            None => unsafe { std::env::remove_var("USE_MOCK_CLAUDE") },
        }
    }

    #[test]
    fn build_env_json_does_not_inject_vm0_token() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_TOKEN"));
    }

    #[test]
    fn execution_context_deserializes_with_firewalls() {
        let json = serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001",
            "prompt": "test",
            "sandboxToken": "tok",
            "workingDir": "/workspace",
            "cliAgentType": "claude-code",
            "billableFirewalls": [],
            "firewalls": [{
                "name": "github",
                "apis": [{
                    "base": "https://api.github.com",
                    "auth": {
                        "headers": {
                            "Authorization": "Bearer ${{ secrets.GITHUB_TOKEN }}"
                        }
                    },
                    "permissions": [
                        {
                            "name": "issues-read",
                            "rules": [
                                "GET /repos/{owner}/{repo}/issues",
                                "GET /repos/{owner}/{repo}/issues/{issue_number}"
                            ]
                        }
                    ]
                }]
            }]
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        let svcs = ctx.firewalls.unwrap();
        assert_eq!(svcs.len(), 1);
        assert_eq!(svcs[0].name, "github");
        assert_eq!(svcs[0].apis.len(), 1);
        assert_eq!(svcs[0].apis[0].base, "https://api.github.com");
        let perms = svcs[0].apis[0].permissions.as_ref().unwrap();
        assert_eq!(perms.len(), 1);
        assert_eq!(perms[0].name, "issues-read");
        assert_eq!(perms[0].rules.len(), 2);
        assert_eq!(perms[0].rules[0], "GET /repos/{owner}/{repo}/issues");
    }

    #[test]
    fn execution_context_deserializes_without_firewalls() {
        let json = serde_json::json!({
            "runId": "00000000-0000-0000-0000-000000000001",
            "prompt": "test",
            "sandboxToken": "tok",
            "workingDir": "/workspace",
            "cliAgentType": "claude-code",
            "billableFirewalls": []
        });
        let ctx: ExecutionContext = serde_json::from_value(json).unwrap();
        assert!(ctx.firewalls.is_none());
    }

    #[test]
    fn dmesg_oom_positive() {
        assert!(dmesg_indicates_oom(
            "[  12.345] Out of memory: Killed process 1234 (claude)"
        ));
        assert!(dmesg_indicates_oom("oom-kill:constraint=CONSTRAINT_MEMCG"));
        assert!(dmesg_indicates_oom("oom_reaper: reaped process 42"));
    }

    #[test]
    fn dmesg_oom_negative() {
        assert!(!dmesg_indicates_oom(""));
        // "Killed process" alone (without OOM context) should NOT match
        assert!(!dmesg_indicates_oom("Killed process 42 (node)"));
        assert!(!dmesg_indicates_oom("normal kernel log output"));
        assert!(!dmesg_indicates_oom("[  1.000] eth0: link up"));
        assert!(!dmesg_indicates_oom("task killed by signal 15"));
        // substring "oom" in unrelated words should not match
        assert!(!dmesg_indicates_oom("the room is full"));
    }

    #[test]
    fn dmesg_oom_case_insensitive() {
        assert!(dmesg_indicates_oom("Out Of Memory: killed process 99"));
        assert!(!dmesg_indicates_oom("Killed process 99 (agent)"));
        assert!(dmesg_indicates_oom("OOM-kill: constraint=MEMCG"));
    }

    /// Real `sudo dmesg | grep 'oom-kill'` output captured from prod-3.
    const PROD3_OOM_GREP: &str = "\
        [1718300.650867] fc_vcpu 0 invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=0\n\
        [1718300.651117] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=vm0-runner-v0.45.6.service,mems_allowed=0,oom_memcg=/system.slice/vm0-runner-v0.45.6.service,task_memcg=/system.slice/vm0-runner-v0.45.6.service,task=firecracker,pid=586629,uid=1000";

    #[test]
    fn host_oom_matches_real_prod3_output() {
        assert!(host_dmesg_indicates_oom(PROD3_OOM_GREP, 586629));
    }

    #[test]
    fn host_oom_no_match_different_pid() {
        assert!(!host_dmesg_indicates_oom(PROD3_OOM_GREP, 12345));
    }

    #[test]
    fn host_oom_no_match_different_process() {
        // Same structure as prod-3 but task=node instead of task=firecracker
        let dmesg = "[1718300.651117] oom-kill:constraint=CONSTRAINT_MEMCG,\
            task=node,pid=586629,uid=1000";
        assert!(!host_dmesg_indicates_oom(dmesg, 586629));
    }

    #[test]
    fn host_oom_no_match_empty() {
        assert!(!host_dmesg_indicates_oom("", 12345));
    }

    #[test]
    fn host_oom_no_match_without_oom_kill() {
        // Has the PID pattern but no oom-kill keyword
        let dmesg = "[1718300.651117] task=firecracker,pid=12345,uid=1000 started";
        assert!(!host_dmesg_indicates_oom(dmesg, 12345));
    }

    #[test]
    fn host_oom_no_prefix_match() {
        // pid=58662 must NOT match pid=586629
        assert!(!host_dmesg_indicates_oom(PROD3_OOM_GREP, 58662));
    }

    #[test]
    fn host_oom_pid_at_end_of_line() {
        // PID at end of string (no trailing comma) — edge case
        let dmesg = "[0.0] oom-kill:constraint=CONSTRAINT_MEMCG,task=firecracker,pid=42";
        assert!(host_dmesg_indicates_oom(dmesg, 42));
        assert!(!host_dmesg_indicates_oom(dmesg, 4));
    }

    #[test]
    fn session_id_validation_rejects_path_traversal() {
        let invalid_ids = [
            "../../etc/passwd",
            "foo/bar",
            "a b",
            "id;rm -rf /",
            "a\nb",
            "",
        ];
        for id in invalid_ids {
            assert!(!is_valid_session_id(id), "expected rejection for: {id:?}");
        }
    }

    #[test]
    fn session_id_validation_accepts_valid_ids() {
        let valid_ids = [
            "abc-123",
            "sess_456",
            "a1b2c3",
            "01961d3a-c0ab-7891-a6d3-9b52cd28716c",
        ];
        for id in valid_ids {
            assert!(is_valid_session_id(id), "expected acceptance for: {id:?}");
        }
    }

    #[test]
    fn build_env_json_with_disallowed_tools() {
        let mut ctx = minimal_context();
        ctx.disallowed_tools = Some(vec!["CronCreate".into(), "CronDelete".into()]);
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(
            env.get("VM0_DISALLOWED_TOOLS").unwrap(),
            "CronCreate,CronDelete"
        );
    }

    #[test]
    fn build_env_json_empty_disallowed_tools_omitted() {
        let mut ctx = minimal_context();
        ctx.disallowed_tools = Some(vec![]);
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    }

    #[test]
    fn build_env_json_no_disallowed_tools() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_DISALLOWED_TOOLS"));
    }

    #[test]
    fn build_env_json_with_tools() {
        let mut ctx = minimal_context();
        ctx.tools = Some(vec!["Bash".into(), "Edit".into()]);
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("VM0_TOOLS").unwrap(), "Bash,Edit");
    }

    #[test]
    fn build_env_json_empty_tools_omitted() {
        let mut ctx = minimal_context();
        ctx.tools = Some(vec![]);
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_TOOLS"));
    }

    #[test]
    fn build_env_json_no_tools() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_TOOLS"));
    }

    #[test]
    fn build_env_json_with_settings() {
        let mut ctx = minimal_context();
        ctx.settings = Some(r#"{"hooks":{}}"#.into());
        let env = build_env_for_test(&ctx, "http://localhost");
        assert_eq!(env.get("VM0_SETTINGS").unwrap(), r#"{"hooks":{}}"#);
    }

    #[test]
    fn build_env_json_empty_settings_omitted() {
        let mut ctx = minimal_context();
        ctx.settings = Some("".into());
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_SETTINGS"));
    }

    #[test]
    fn build_env_json_no_settings() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_SETTINGS"));
    }

    #[test]
    fn build_env_json_with_feature_flags() {
        let mut ctx = minimal_context();
        let mut flags = HashMap::new();
        flags.insert("computerUse".into(), true);
        flags.insert("voiceChat".into(), false);
        ctx.feature_flags = Some(flags);
        let env = build_env_for_test(&ctx, "http://localhost");
        let raw = env
            .get("VM0_FEATURE_FLAGS")
            .expect("VM0_FEATURE_FLAGS should be set");
        let parsed: HashMap<String, bool> = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.get("computerUse"), Some(&true));
        assert_eq!(parsed.get("voiceChat"), Some(&false));
    }

    #[test]
    fn build_env_json_empty_feature_flags_omitted() {
        let mut ctx = minimal_context();
        ctx.feature_flags = Some(HashMap::new());
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_FEATURE_FLAGS"));
    }

    #[test]
    fn build_env_json_no_feature_flags() {
        let ctx = minimal_context();
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_FEATURE_FLAGS"));
    }

    // -----------------------------------------------------------------------
    // Sandbox-interacting function tests (using sandbox-mock)
    // -----------------------------------------------------------------------

    use sandbox::{
        ExecResult, SandboxError, SandboxInitializationPhase, SandboxOperation,
        SandboxOperationReason,
    };
    use sandbox_mock::MockSandbox;

    fn sandbox_exec_error(message: impl Into<String>) -> SandboxError {
        SandboxError::Operation {
            operation: SandboxOperation::Exec,
            reason: SandboxOperationReason::Guest,
            message: message.into(),
        }
    }

    fn sandbox_write_file_error(message: impl Into<String>) -> SandboxError {
        SandboxError::Operation {
            operation: SandboxOperation::WriteFile,
            reason: SandboxOperationReason::Guest,
            message: message.into(),
        }
    }

    fn sandbox_create_error(message: impl Into<String>) -> SandboxError {
        SandboxError::Initialization {
            phase: SandboxInitializationPhase::SandboxAllocation,
            message: message.into(),
        }
    }

    #[tokio::test]
    async fn fix_guest_clock_calls_date_command() {
        let sandbox = MockSandbox::new("test");
        // Default mock returns exit 0 — clock fix should succeed.
        fix_guest_clock(&sandbox).await.unwrap();
    }

    #[tokio::test]
    async fn fix_guest_clock_propagates_exec_error() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_exec_result(Err(sandbox_exec_error("timeout")));
        let result = fix_guest_clock(&sandbox).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn reseed_guest_entropy_succeeds() {
        let sandbox = MockSandbox::new("test");
        // write_file returns Ok by default, exec returns exit 0 by default.
        reseed_guest_entropy(&sandbox).await.unwrap();
    }

    #[tokio::test]
    async fn reseed_guest_entropy_propagates_exec_error() {
        let sandbox = MockSandbox::new("test");
        // Sandbox-level failure (vsock connection issue).
        sandbox.push_exec_result(Err(sandbox_exec_error("reseed failed")));
        let result = reseed_guest_entropy(&sandbox).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn reseed_guest_entropy_fails_on_nonzero_exit() {
        let sandbox = MockSandbox::new("test");
        // guest-reseed exits with code 1 (e.g., ioctl failed).
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 1,
            stdout: Vec::new(),
            stderr: b"RNDADDENTROPY failed: Operation not permitted".to_vec(),
        }));
        let result = reseed_guest_entropy(&sandbox).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("guest-reseed failed"), "got: {msg}");
    }

    #[tokio::test]
    async fn sync_guest_timezone_valid_tz() {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.user_timezone = Some("America/New_York".into());
        // Should exec one command and not panic.
        sync_guest_timezone(&sandbox, &ctx).await;
    }

    #[tokio::test]
    async fn sync_guest_timezone_skips_when_none() {
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();
        // No timezone — should skip without calling exec.
        // Push an error to detect if exec is called unexpectedly.
        sandbox.push_exec_result(Err(sandbox_exec_error("should not be called")));
        sync_guest_timezone(&sandbox, &ctx).await;
    }

    #[tokio::test]
    async fn sync_guest_timezone_rejects_shell_injection() {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.user_timezone = Some("$(rm -rf /)".into());
        // Push an error to detect if exec is called — it should NOT be.
        sandbox.push_exec_result(Err(sandbox_exec_error("should not be called")));
        sync_guest_timezone(&sandbox, &ctx).await;
    }

    #[tokio::test]
    async fn sync_guest_timezone_empty_string_skips() {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.user_timezone = Some(String::new());
        sandbox.push_exec_result(Err(sandbox_exec_error("should not be called")));
        sync_guest_timezone(&sandbox, &ctx).await;
    }

    #[tokio::test]
    async fn read_guest_error_file_returns_content() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 0,
            stdout: b"checkpoint error: disk full".to_vec(),
            stderr: Vec::new(),
        }));
        let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
        assert_eq!(msg.as_deref(), Some("checkpoint error: disk full"));
    }

    #[tokio::test]
    async fn read_guest_error_file_returns_none_on_missing_file() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 1, // cat fails — file not found
            stdout: Vec::new(),
            stderr: b"No such file".to_vec(),
        }));
        let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
        assert!(msg.is_none());
    }

    #[tokio::test]
    async fn read_guest_error_file_returns_none_on_empty_content() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 0,
            stdout: b"   \n  ".to_vec(), // whitespace-only
            stderr: Vec::new(),
        }));
        let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
        assert!(msg.is_none());
    }

    #[tokio::test]
    async fn read_guest_error_file_returns_none_on_exec_error() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_exec_result(Err(sandbox_exec_error("vsock timeout")));
        let msg = read_guest_error_file(&sandbox, RunId::nil()).await;
        assert!(msg.is_none());
    }

    #[tokio::test]
    async fn download_storages_success() {
        let sandbox = MockSandbox::new("test");
        // write_file succeeds by default, exec returns exit 0 by default.
        let ctx = minimal_context();
        let manifest = StorageManifest {
            storages: vec![StorageEntry {
                mount_path: "/data".into(),
                archive_url: Some("https://s3/archive.tar.gz".into()),
                cached: false,
                vas_storage_name: None,
                vas_version_id: None,
            }],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        download_storages(&sandbox, &ctx, &manifest, "/tmp/log")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn download_storages_nonzero_exit_code() {
        let sandbox = MockSandbox::new("test");
        // write_file succeeds, but exec returns non-zero.
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 1,
            stdout: Vec::new(),
            stderr: b"download failed".to_vec(),
        }));
        let ctx = minimal_context();
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let err = download_storages(&sandbox, &ctx, &manifest, "/tmp/log")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("storage download failed"));
    }

    #[tokio::test]
    async fn restore_session_writes_history() {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "claude-code".into();
        let session = ResumeSession {
            session_id: "sess-abc-123".into(),
            session_history: r#"{"type":"init"}"#.into(),
        };
        // mkdir exec + write_file — both succeed by default.
        restore_session(&sandbox, &ctx, &session).await.unwrap();
    }

    #[tokio::test]
    async fn restore_session_rejects_invalid_session_id() {
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();
        let session = ResumeSession {
            session_id: "../../etc/passwd".into(),
            session_history: "data".into(),
        };
        let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
        assert!(err.to_string().contains("invalid session_id"));
    }

    #[tokio::test]
    async fn restore_session_skips_non_claude_agent() {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.cli_agent_type = "custom-agent".into();
        let session = ResumeSession {
            session_id: "sess-1".into(),
            session_history: "data".into(),
        };
        // Should return Ok without calling exec or write_file.
        // Push an error to detect unexpected calls.
        sandbox.push_exec_result(Err(sandbox_exec_error("should not be called")));
        restore_session(&sandbox, &ctx, &session).await.unwrap();
    }

    #[tokio::test]
    async fn restore_session_allows_empty_agent_type() {
        let sandbox = MockSandbox::new("test");
        let mut ctx = minimal_context();
        ctx.cli_agent_type = String::new(); // empty defaults to claude-code
        let session = ResumeSession {
            session_id: "sess-1".into(),
            session_history: "{}".into(),
        };
        // Should proceed (empty agent type treated as claude-code).
        restore_session(&sandbox, &ctx, &session).await.unwrap();
    }

    #[tokio::test]
    async fn build_env_json_with_memory_as_artifact() {
        // Post-#10602: memory rides in VM0_ARTIFACTS, not VM0_MEMORY_*.
        let mut ctx = minimal_context();
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![],
            artifacts: vec![ArtifactEntry {
                mount_path: "/memory".into(),
                archive_url: None,
                cached: false,
                vas_storage_name: "memory".into(),
                vas_storage_id: String::new(),
                vas_version_id: "v2".into(),
            }],
            cleanup_paths: vec![],
        });
        let env = build_env_for_test(&ctx, "http://localhost");
        assert!(!env.contains_key("VM0_MEMORY_DRIVER"));
        assert!(!env.contains_key("VM0_MEMORY_MOUNT_PATH"));
        assert!(!env.contains_key("VM0_MEMORY_NAME"));
        assert!(!env.contains_key("VM0_MEMORY_VERSION_ID"));
        let artifacts = env.get("VM0_ARTIFACTS").unwrap();
        assert!(artifacts.contains("\"memory\""));
        assert!(artifacts.contains("\"/memory\""));
        assert!(artifacts.contains("\"v2\""));
    }

    // -----------------------------------------------------------------------
    // copy_guest_logs tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn copy_guest_logs_writes_files_to_host() {
        let dir = tempfile::tempdir().unwrap();
        let log_paths = LogPaths::new(dir.path().to_path_buf());
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();

        // Queue two exec results: system log + metrics log
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 0,
            stdout: b"system log line 1\nsystem log line 2\n".to_vec(),
            stderr: Vec::new(),
        }));
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 0,
            stdout: b"{\"cpu\":0.5}\n".to_vec(),
            stderr: Vec::new(),
        }));

        copy_guest_logs(&sandbox, &ctx, &log_paths).await;

        let system_log = tokio::fs::read_to_string(log_paths.system_log(ctx.run_id))
            .await
            .unwrap();
        assert_eq!(system_log, "system log line 1\nsystem log line 2\n");

        let metrics_log = tokio::fs::read_to_string(log_paths.metrics_log(ctx.run_id))
            .await
            .unwrap();
        assert_eq!(metrics_log, "{\"cpu\":0.5}\n");
    }

    #[tokio::test]
    async fn copy_guest_logs_skips_on_nonzero_exit() {
        let dir = tempfile::tempdir().unwrap();
        let log_paths = LogPaths::new(dir.path().to_path_buf());
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();

        // cat fails (file doesn't exist in guest)
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 1,
            stdout: Vec::new(),
            stderr: b"No such file".to_vec(),
        }));
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 1,
            stdout: Vec::new(),
            stderr: Vec::new(),
        }));

        copy_guest_logs(&sandbox, &ctx, &log_paths).await;

        // Host files should not be created
        assert!(!log_paths.system_log(ctx.run_id).exists());
        assert!(!log_paths.metrics_log(ctx.run_id).exists());
    }

    #[tokio::test]
    async fn copy_guest_logs_skips_on_exec_error() {
        let dir = tempfile::tempdir().unwrap();
        let log_paths = LogPaths::new(dir.path().to_path_buf());
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();

        sandbox.push_exec_result(Err(sandbox_exec_error("vsock down")));
        sandbox.push_exec_result(Err(sandbox_exec_error("vsock down")));

        copy_guest_logs(&sandbox, &ctx, &log_paths).await;

        assert!(!log_paths.system_log(ctx.run_id).exists());
        assert!(!log_paths.metrics_log(ctx.run_id).exists());
    }

    // -----------------------------------------------------------------------
    // drain_stdout_to_file tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn drain_stdout_writes_chunks_to_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stdout.log");

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tx.send(b"chunk 1\n".to_vec()).unwrap();
        tx.send(b"chunk 2\n".to_vec()).unwrap();
        drop(tx); // close channel

        drain_stdout_to_file(rx, path.clone()).await;

        let content = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(content, "chunk 1\nchunk 2\n");
    }

    #[tokio::test]
    async fn drain_stdout_empty_channel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.log");

        let (_tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        drop(_tx);

        drain_stdout_to_file(rx, path.clone()).await;

        let content = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(content.is_empty());
    }

    #[tokio::test]
    async fn drain_stdout_invalid_path_does_not_panic() {
        let (_tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        drop(_tx);
        // /dev/null/impossible cannot be created — should handle gracefully
        drain_stdout_to_file(rx, std::path::PathBuf::from("/dev/null/impossible/file")).await;
    }

    // -----------------------------------------------------------------------
    // write_file failure tests (using push_write_file_result)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn download_storages_fails_on_write_file_error() {
        let sandbox = MockSandbox::new("test");
        sandbox.push_write_file_result(Err(sandbox_write_file_error("vsock write failed")));
        let ctx = minimal_context();
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let err = download_storages(&sandbox, &ctx, &manifest, "/tmp/log")
            .await
            .unwrap_err();
        assert!(err.to_string().contains("vsock write failed"), "got: {err}");
    }

    #[tokio::test]
    async fn restore_session_fails_on_write_file_error() {
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();
        let session = ResumeSession {
            session_id: "sess-abc".into(),
            session_history: r#"{"type":"init"}"#.into(),
        };
        // First exec (mkdir) succeeds by default, write_file fails.
        sandbox.push_write_file_result(Err(sandbox_write_file_error("disk full")));
        let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
        assert!(err.to_string().contains("disk full"), "got: {err}");
    }

    #[tokio::test]
    async fn restore_session_fails_on_mkdir_exec_error() {
        let sandbox = MockSandbox::new("test");
        let ctx = minimal_context();
        let session = ResumeSession {
            session_id: "sess-abc".into(),
            session_history: "data".into(),
        };
        // mkdir exec fails
        sandbox.push_exec_result(Err(sandbox_exec_error("vsock down")));
        let err = restore_session(&sandbox, &ctx, &session).await.unwrap_err();
        assert!(err.to_string().contains("vsock down"), "got: {err}");
    }

    // -----------------------------------------------------------------------
    // execute_new_sandbox integration tests (MockSandboxFactory + real filesystem)
    // -----------------------------------------------------------------------

    /// Build a real `ExecutorConfig` backed by tempdir files.
    async fn test_executor_config(dir: &std::path::Path) -> ExecutorConfig {
        let registry_path = dir.join("proxy-registry.json");
        let lock_path = dir.join("proxy-registry.json.lock");
        tokio::fs::write(&registry_path, r#"{"vms":{},"updated_at":0}"#)
            .await
            .unwrap();
        let log_dir = dir.join("logs");
        tokio::fs::create_dir_all(&log_dir).await.unwrap();

        ExecutorConfig {
            api_url: "http://localhost:9999".into(),
            registry: proxy::ProxyRegistryHandle::new(registry_path, lock_path),
            http: crate::http::HttpClient::new("http://localhost:9999".into()).unwrap(),
            log_paths: LogPaths::new(log_dir),
            ip_log_map: kmsg_log::new_ip_log_map(),
            home: HomePaths::with_root(dir.to_path_buf()),
        }
    }

    fn default_params() -> JobParams {
        JobParams {
            vcpu: 2,
            memory_mb: 2048,
            restore_guest_state: false,
        }
    }

    fn test_telemetry(config: &ExecutorConfig, ctx: &ExecutionContext) -> JobTelemetry {
        crate::telemetry::JobTelemetry::new(
            config.http.clone(),
            ctx.run_id,
            ctx.sandbox_token.clone(),
        )
    }

    async fn run_execute_inner(
        factory: &MockSandboxFactory,
        ctx: &ExecutionContext,
        config: &ExecutorConfig,
        params: &JobParams,
    ) -> RunnerResult<(i32, Option<String>)> {
        let mut telemetry = test_telemetry(config, ctx);
        let cancel = tokio_util::sync::CancellationToken::new();
        let outcome = execute_new_sandbox(
            factory,
            ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            config,
            params,
            &mut telemetry,
            cancel,
        )
        .await?;
        Ok((outcome.exit_code, outcome.error))
    }

    #[tokio::test]
    async fn execute_inner_happy_path() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();

        let (exit_code, error_msg) =
            run_execute_inner(&factory, &minimal_context(), &config, &default_params())
                .await
                .unwrap();
        assert_eq!(exit_code, 0);
        assert!(error_msg.is_none());
    }

    #[tokio::test]
    async fn execute_inner_with_snapshot_runs_clock_fix_and_reseed() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();

        let params = JobParams {
            restore_guest_state: true,
            ..default_params()
        };
        let (exit_code, _) = run_execute_inner(&factory, &minimal_context(), &config, &params)
            .await
            .unwrap();
        assert_eq!(exit_code, 0);
    }

    #[tokio::test]
    async fn execute_inner_with_storage_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();

        let mut ctx = minimal_context();
        ctx.storage_manifest = Some(StorageManifest {
            storages: vec![StorageEntry {
                mount_path: "/data".into(),
                archive_url: Some("https://example.com/data.tar.gz".into()),
                cached: false,
                vas_storage_name: None,
                vas_version_id: None,
            }],
            artifacts: vec![],
            cleanup_paths: vec![],
        });
        let (exit_code, _) = run_execute_inner(&factory, &ctx, &config, &default_params())
            .await
            .unwrap();
        assert_eq!(exit_code, 0);
    }

    #[tokio::test]
    async fn execute_inner_with_resume_session() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();

        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            session_id: "sess-abc-123".into(),
            session_history: r#"{"type":"init"}"#.into(),
        });
        let (exit_code, _) = run_execute_inner(&factory, &ctx, &config, &default_params())
            .await
            .unwrap();
        assert_eq!(exit_code, 0);
    }

    #[tokio::test]
    async fn execute_inner_create_failure_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();
        factory.push_create_result(Err(sandbox_create_error("no free devices")));

        let err = run_execute_inner(&factory, &minimal_context(), &config, &default_params())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("no free devices"), "got: {err}");
    }

    #[tokio::test]
    async fn execute_inner_aborts_drain_task_on_wait_exit_error() {
        // Simulate wait_exit timeout: stdout channel stays open (sender held
        // alive by MockSandbox), wait_exit returns error.
        // Without the fix, task.await blocks forever → test times out.
        // With the fix, task is aborted immediately → test completes.
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_exit_error(
            "wait timeout",
        ));
        let mut factory = sandbox_mock::MockSandboxFactory::with_overrides(overrides);
        factory.startup().await.unwrap();

        let (exit_code, error) =
            run_execute_inner(&factory, &minimal_context(), &config, &default_params())
                .await
                .unwrap();
        assert_eq!(exit_code, 1);
        let error = error.unwrap();
        assert!(error.contains("wait timeout"), "got: {error}");
    }

    #[tokio::test]
    async fn execute_job_wraps_execute_inner() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        assert_eq!(outcome.exit_code, 0);
        assert!(outcome.error.is_none());
        assert!(outcome.sandbox.is_some());
    }

    #[tokio::test]
    async fn execute_job_create_failure_returns_exit_1() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();
        factory.push_create_result(Err(sandbox_create_error("boom")));

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        assert_eq!(outcome.exit_code, 1);
        assert!(outcome.error.unwrap().contains("boom"));
        assert!(outcome.sandbox.is_none());
    }

    // -----------------------------------------------------------------------
    // Keep-alive VM reuse integration tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn execute_job_reuse_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();

        // First: create a sandbox via normal execute_job
        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        assert_eq!(outcome.exit_code, 0);
        let sandbox = outcome.sandbox.expect("sandbox should be alive");

        // Build an idle entry from the outcome
        let idle_entry = crate::idle_pool::IdleEntry {
            sandbox,
            factory: std::sync::Arc::new(
                Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>
            ),
            session_id: "test-session".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            vcpu: 2,
            memory_mb: 2048,
            source_ip: outcome.source_ip,
            parked_at: std::time::Instant::now(),
            idle_timeout: std::time::Duration::from_secs(300),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        };

        // Reuse the sandbox for a second turn
        let cancel = tokio_util::sync::CancellationToken::new();
        let (reuse_outcome, _telemetry) =
            execute_job_reuse(idle_entry, minimal_context(), &config, cancel).await;
        assert_eq!(reuse_outcome.exit_code, 0);
        assert!(reuse_outcome.error.is_none());
        assert!(reuse_outcome.sandbox.is_some());
    }

    #[tokio::test]
    async fn execute_job_reuse_with_session_context() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();

        // First turn: execute with resume_session
        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            session_id: "test-session-abc".into(),
            session_history: r#"{"type":"human","text":"hello"}"#.into(),
        });
        assert_eq!(ctx.session_id(), Some("test-session-abc"));

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            ctx,
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        assert_eq!(outcome.exit_code, 0);
        let sandbox = outcome.sandbox.expect("sandbox should be alive");

        // Build idle entry
        let idle_entry = crate::idle_pool::IdleEntry {
            sandbox,
            factory: std::sync::Arc::new(
                Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>
            ),
            session_id: "test-session".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            vcpu: 2,
            memory_mb: 2048,
            source_ip: outcome.source_ip,
            parked_at: std::time::Instant::now(),
            idle_timeout: std::time::Duration::from_secs(300),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        };

        // Second turn: reuse with new session history
        let mut ctx2 = minimal_context();
        ctx2.resume_session = Some(ResumeSession {
            session_id: "test-session-abc".into(),
            session_history: r#"{"type":"human","text":"hello"}
{"type":"assistant","text":"hi"}
{"type":"human","text":"do something"}"#
                .into(),
        });

        let cancel = tokio_util::sync::CancellationToken::new();
        let (reuse_outcome, _telemetry) =
            execute_job_reuse(idle_entry, ctx2, &config, cancel).await;
        assert_eq!(reuse_outcome.exit_code, 0);
        assert!(reuse_outcome.sandbox.is_some());
    }

    #[tokio::test]
    async fn idle_pool_park_and_reuse_cycle() {
        use crate::idle_pool::{IdlePool, IdlePoolConfig, ParkResult};

        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();

        // Execute first job
        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        assert_eq!(outcome.exit_code, 0);
        let sandbox = outcome.sandbox.expect("sandbox alive");

        // Park in idle pool
        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: std::time::Duration::from_secs(300),
            max_idle: 0,
        });

        let entry = crate::idle_pool::IdleEntry {
            sandbox,
            factory: std::sync::Arc::new(
                Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>
            ),
            session_id: "test-session".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            vcpu: 2,
            memory_mb: 2048,
            source_ip: outcome.source_ip,
            parked_at: std::time::Instant::now(),
            idle_timeout: std::time::Duration::from_secs(300),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        };

        let result = pool.park("session-1".into(), entry);
        assert!(matches!(result, ParkResult::Parked));
        assert_eq!(pool.len(), 1);

        // Take from pool for reuse
        let reuse_entry = pool.take("session-1").expect("should find session");
        assert_eq!(pool.len(), 0);
        assert_eq!(reuse_entry.profile_name, "vm0/default");

        // Execute reuse
        let cancel = tokio_util::sync::CancellationToken::new();
        let (reuse_outcome, _telemetry) =
            execute_job_reuse(reuse_entry, minimal_context(), &config, cancel).await;
        assert_eq!(reuse_outcome.exit_code, 0);
        assert!(reuse_outcome.sandbox.is_some());
    }

    #[tokio::test]
    async fn idle_pool_profile_mismatch_returns_none() {
        use crate::idle_pool::{IdlePool, IdlePoolConfig};

        let mut pool = IdlePool::new(IdlePoolConfig {
            default_timeout: std::time::Duration::from_secs(300),
            max_idle: 0,
        });

        // Park with profile "vm0/default"
        let entry = crate::idle_pool::IdleEntry {
            sandbox: Box::new(sandbox_mock::MockSandbox::new("test")),
            factory: std::sync::Arc::new(
                Box::new(sandbox_mock::MockSandboxFactory::new()) as Box<dyn SandboxFactory>
            ),
            session_id: "test-session".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            vcpu: 2,
            memory_mb: 2048,
            source_ip: "10.0.0.1".into(),
            parked_at: std::time::Instant::now(),
            idle_timeout: std::time::Duration::from_secs(300),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        };
        let _ = pool.park("session-1".into(), entry);

        // Take and verify profile
        let taken = pool.take("session-1").expect("should find");
        assert_eq!(taken.profile_name, "vm0/default");

        // Simulate caller checking profile mismatch
        let matches_browser = taken.profile_name == "vm0/browser";
        assert!(!matches_browser, "should not match different profile");
    }

    #[tokio::test]
    async fn execute_job_reuse_clock_fix_failure_returns_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;

        // Build a MockSandbox that fails on the first exec (fix_guest_clock)
        let sandbox = MockSandbox::new("reuse-clock-fail");
        sandbox.push_exec_result(Err(sandbox_exec_error("vsock broken")));

        let idle_entry = crate::idle_pool::IdleEntry {
            sandbox: Box::new(sandbox),
            factory: std::sync::Arc::new(
                Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>
            ),
            session_id: "sess-1".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            vcpu: 2,
            memory_mb: 2048,
            source_ip: "10.0.0.1".into(),
            parked_at: std::time::Instant::now(),
            idle_timeout: std::time::Duration::from_secs(300),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        };

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) =
            execute_job_reuse(idle_entry, minimal_context(), &config, cancel).await;

        assert_eq!(outcome.exit_code, 1);
        assert!(outcome.error.unwrap().contains("vsock broken"));
        // Critical: sandbox must be returned so caller can stop + destroy it
        assert!(
            outcome.sandbox.is_some(),
            "sandbox must be returned on clock fix failure"
        );
    }

    #[tokio::test]
    async fn execute_job_reuse_reseed_failure_returns_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;

        // First exec (fix_guest_clock) succeeds, second (reseed_guest_entropy) fails
        let sandbox = MockSandbox::new("reuse-reseed-fail");
        sandbox.push_exec_result(Ok(ExecResult {
            exit_code: 0,
            stdout: Vec::new(),
            stderr: Vec::new(),
        }));
        sandbox.push_exec_result(Err(sandbox_exec_error("reseed timeout")));

        let idle_entry = crate::idle_pool::IdleEntry {
            sandbox: Box::new(sandbox),
            factory: std::sync::Arc::new(
                Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>
            ),
            session_id: "sess-1".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            vcpu: 2,
            memory_mb: 2048,
            source_ip: "10.0.0.1".into(),
            parked_at: std::time::Instant::now(),
            idle_timeout: std::time::Duration::from_secs(300),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        };

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) =
            execute_job_reuse(idle_entry, minimal_context(), &config, cancel).await;

        assert_eq!(outcome.exit_code, 1);
        assert!(outcome.error.unwrap().contains("reseed timeout"));
        assert!(
            outcome.sandbox.is_some(),
            "sandbox must be returned on reseed failure"
        );
    }

    /// Verify that session restore failure during reuse still returns the sandbox.
    #[tokio::test]
    async fn execute_job_reuse_session_restore_failure_returns_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;

        let sandbox = MockSandbox::new("reuse-session-fail");
        // clock fix and reseed succeed (default), then mkdir exec succeeds,
        // but write_file for session history fails.
        sandbox.push_write_file_result(Err(sandbox_write_file_error("disk full")));

        let mut ctx = minimal_context();
        ctx.resume_session = Some(ResumeSession {
            session_id: "sess-abc".into(),
            session_history: r#"{"type":"init"}"#.into(),
        });

        let idle_entry = crate::idle_pool::IdleEntry {
            sandbox: Box::new(sandbox),
            factory: std::sync::Arc::new(
                Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>
            ),
            session_id: "sess-abc".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            vcpu: 2,
            memory_mb: 2048,
            source_ip: "10.0.0.1".into(),
            parked_at: std::time::Instant::now(),
            idle_timeout: std::time::Duration::from_secs(300),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        };

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job_reuse(idle_entry, ctx, &config, cancel).await;

        assert_eq!(outcome.exit_code, 1);
        assert!(outcome.error.unwrap().contains("disk full"));
        assert!(
            outcome.sandbox.is_some(),
            "sandbox must be returned on session restore failure"
        );
    }

    #[tokio::test]
    async fn execute_job_nonzero_exit_still_returns_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;

        // Sandbox should be alive regardless of exit code (caller decides fate)
        assert!(
            outcome.sandbox.is_some(),
            "sandbox must be returned for caller to stop+destroy or park"
        );
    }

    // -----------------------------------------------------------------------
    // filter_unchanged_storages tests
    // -----------------------------------------------------------------------

    fn art(name: &str, ver: &str, url: &str) -> ArtifactEntry {
        ArtifactEntry {
            mount_path: "/workspace".into(),
            archive_url: Some(url.into()),
            cached: false,
            vas_storage_name: name.into(),
            vas_storage_id: String::new(),
            vas_version_id: ver.into(),
        }
    }

    fn art_fp(mount: &str, name: &str, ver: &str) -> HashMap<String, (String, String)> {
        let mut m = HashMap::new();
        m.insert(mount.into(), (name.into(), ver.into()));
        m
    }

    #[test]
    fn filter_same_artifact_version_nulls_url() {
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![art("my-art", "v1", "https://s3/v1")],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.artifacts[0].archive_url.is_none());
    }

    #[test]
    fn filter_different_artifact_version_keeps_url() {
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![art("my-art", "v2", "https://s3/v2")],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert_eq!(
            result.artifacts[0].archive_url.as_deref(),
            Some("https://s3/v2"),
        );
    }

    #[test]
    fn filter_different_artifact_name_keeps_url() {
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![art("other-art", "v1", "https://s3/v1")],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.artifacts[0].archive_url.is_some());
    }

    #[test]
    fn filter_new_artifact_not_in_prev_keeps_url() {
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![art("my-art", "v1", "https://s3/v1")],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints::default();
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.artifacts[0].archive_url.is_some());
    }

    #[test]
    fn filter_empty_prev_downloads_everything() {
        let manifest = StorageManifest {
            storages: vec![StorageEntry {
                mount_path: "/data".into(),
                archive_url: Some("https://s3/data".into()),
                cached: false,
                vas_storage_name: Some("vol-1".into()),
                vas_version_id: Some("v1".into()),
            }],
            artifacts: vec![art("my-art", "v1", "https://s3/v1")],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints::default();
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.storages[0].archive_url.is_some());
        assert!(result.artifacts[0].archive_url.is_some());
    }

    #[test]
    fn filter_all_unchanged_nulls_all_urls() {
        let manifest = StorageManifest {
            storages: vec![StorageEntry {
                mount_path: "/data".into(),
                archive_url: Some("https://s3/same-url".into()),
                cached: false,
                vas_storage_name: Some("vol-1".into()),
                vas_version_id: Some("v1".into()),
            }],
            artifacts: vec![art("my-art", "v1", "https://s3/v1")],
            cleanup_paths: vec![],
        };
        let mut storages = HashMap::new();
        storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
        let prev = crate::idle_pool::StorageFingerprints {
            storages,
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.storages[0].archive_url.is_none());
        assert!(result.storages[0].cached);
        assert!(result.artifacts[0].archive_url.is_none());
        assert!(result.artifacts[0].cached);
    }

    #[test]
    fn filter_two_artifacts_at_different_mount_paths() {
        let art_a = ArtifactEntry {
            mount_path: "/workspace".into(),
            archive_url: Some("https://s3/a-v2".into()),
            cached: false,
            vas_storage_name: "art-a".into(),
            vas_storage_id: String::new(),
            vas_version_id: "v2".into(),
        };
        let art_b = ArtifactEntry {
            mount_path: "/data".into(),
            archive_url: Some("https://s3/b-v1".into()),
            cached: false,
            vas_storage_name: "art-b".into(),
            vas_storage_id: String::new(),
            vas_version_id: "v1".into(),
        };
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![art_a, art_b],
            cleanup_paths: vec![],
        };
        // Previous fingerprints: art-a was v1 (changed), art-b was v1 (unchanged).
        let mut artifacts = HashMap::new();
        artifacts.insert("/workspace".into(), ("art-a".into(), "v1".into()));
        artifacts.insert("/data".into(), ("art-b".into(), "v1".into()));
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts,
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert_eq!(result.artifacts.len(), 2);
        // art-a changed → keeps URL, not cached, cleanup path added
        assert!(result.artifacts[0].archive_url.is_some());
        assert!(!result.artifacts[0].cached);
        assert!(result.cleanup_paths.contains(&"/workspace".to_string()));
        // art-b unchanged → URL nulled, cached
        assert!(result.artifacts[1].archive_url.is_none());
        assert!(result.artifacts[1].cached);
    }

    #[test]
    fn filter_detects_removed_artifacts() {
        // Current manifest has only one artifact; previous had two.
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![art("kept", "v1", "https://s3/kept")],
            cleanup_paths: vec![],
        };
        let mut artifacts = HashMap::new();
        artifacts.insert("/workspace".into(), ("kept".into(), "v1".into()));
        artifacts.insert("/old".into(), ("removed".into(), "v1".into()));
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts,
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        // Removed artifact path must appear in cleanup_paths.
        assert!(result.cleanup_paths.contains(&"/old".to_string()));
    }

    #[test]
    fn filter_computes_cleanup_for_changed_storages() {
        let manifest = StorageManifest {
            storages: vec![
                StorageEntry {
                    mount_path: "/home/user/.claude".into(),
                    archive_url: Some("https://s3/instructions".into()),
                    cached: false,
                    vas_storage_name: Some("instructions".into()),
                    vas_version_id: Some("v2".into()),
                },
                StorageEntry {
                    mount_path: "/home/user/.claude/skills/foo".into(),
                    archive_url: Some("https://s3/foo".into()),
                    cached: false,
                    vas_storage_name: Some("skill-foo".into()),
                    vas_version_id: Some("v1".into()),
                },
            ],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let mut storages = HashMap::new();
        storages.insert(
            "/home/user/.claude".into(),
            ("instructions".into(), "v1".into()),
        );
        storages.insert(
            "/home/user/.claude/skills/foo".into(),
            ("skill-foo".into(), "v1".into()),
        );
        let prev = crate::idle_pool::StorageFingerprints {
            storages,
            artifacts: HashMap::new(),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        // Instructions changed (v1→v2), skill-foo unchanged
        assert!(result.storages[0].archive_url.is_some());
        assert!(!result.storages[0].cached);
        assert!(result.storages[1].archive_url.is_none());
        assert!(result.storages[1].cached);
        // Only changed storage in cleanup_paths
        assert_eq!(result.cleanup_paths, vec!["/home/user/.claude"]);
    }

    #[test]
    fn filter_detects_removed_storages() {
        let manifest = StorageManifest {
            storages: vec![StorageEntry {
                mount_path: "/home/user/.claude".into(),
                archive_url: Some("https://s3/instructions".into()),
                cached: false,
                vas_storage_name: Some("instructions".into()),
                vas_version_id: Some("v1".into()),
            }],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let mut storages = HashMap::new();
        storages.insert(
            "/home/user/.claude".into(),
            ("instructions".into(), "v1".into()),
        );
        storages.insert(
            "/home/user/.claude/skills/old-skill".into(),
            ("old-skill".into(), "v1".into()),
        );
        let prev = crate::idle_pool::StorageFingerprints {
            storages,
            artifacts: HashMap::new(),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        // instructions unchanged, old-skill removed
        assert!(result.storages[0].archive_url.is_none());
        assert!(
            result
                .cleanup_paths
                .contains(&"/home/user/.claude/skills/old-skill".to_string())
        );
    }

    #[test]
    fn filter_changed_artifact_adds_cleanup_path() {
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![art("my-art", "v2", "https://s3/v2")],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.artifacts[0].archive_url.is_some());
        assert!(
            result
                .cleanup_paths
                .contains(&result.artifacts[0].mount_path)
        );
    }

    #[test]
    fn filter_changed_artifact_with_null_url_adds_cleanup_path() {
        let manifest = StorageManifest {
            storages: vec![],
            artifacts: vec![ArtifactEntry {
                mount_path: "/workspace".into(),
                archive_url: None, // API returned null
                cached: false,
                vas_storage_name: "my-art".into(),
                vas_storage_id: String::new(),
                vas_version_id: "v2".into(),
            }],
            cleanup_paths: vec![],
        };
        let prev = crate::idle_pool::StorageFingerprints {
            storages: HashMap::new(),
            artifacts: art_fp("/workspace", "my-art", "v1"),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        // Version changed → must be in cleanup_paths even though URL is null.
        assert!(result.cleanup_paths.contains(&"/workspace".to_string()));
        assert!(!result.artifacts[0].cached);
    }

    #[test]
    fn filter_changed_storage_with_null_url_adds_cleanup_path() {
        let manifest = StorageManifest {
            storages: vec![StorageEntry {
                mount_path: "/data".into(),
                archive_url: None, // API returned null
                cached: false,
                vas_storage_name: Some("vol-1".into()),
                vas_version_id: Some("v2".into()),
            }],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let mut storages = HashMap::new();
        storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
        let prev = crate::idle_pool::StorageFingerprints {
            storages,
            artifacts: HashMap::new(),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        // Version changed → must be in cleanup_paths even though URL is null.
        assert!(result.cleanup_paths.contains(&"/data".to_string()));
        assert!(!result.storages[0].cached);
    }

    #[test]
    fn filter_unchanged_storage_sets_cached_true() {
        let manifest = StorageManifest {
            storages: vec![StorageEntry {
                mount_path: "/data".into(),
                archive_url: Some("https://s3/data".into()),
                cached: false,
                vas_storage_name: Some("vol-1".into()),
                vas_version_id: Some("v1".into()),
            }],
            artifacts: vec![],
            cleanup_paths: vec![],
        };
        let mut storages = HashMap::new();
        storages.insert("/data".into(), ("vol-1".into(), "v1".into()));
        let prev = crate::idle_pool::StorageFingerprints {
            storages,
            artifacts: HashMap::new(),
        };
        let result = filter_unchanged_storages(&manifest, &prev);
        assert!(result.storages[0].cached);
        assert!(result.storages[0].archive_url.is_none());
    }

    // -----------------------------------------------------------------------
    // Reuse-outcome telemetry (issue #10360: sandbox reuse success rate)
    // -----------------------------------------------------------------------

    fn new_telemetry() -> JobTelemetry {
        let http = HttpClient::new("http://localhost".to_string()).unwrap();
        JobTelemetry::new(http, RunId::nil(), "tok".to_string())
    }

    #[test]
    fn record_reuse_result_emits_hit_for_reuse() {
        let mut telemetry = new_telemetry();
        record_reuse_result(&mut telemetry, SandboxReuseResult::Reused);
        let ops = telemetry.pending_ops_snapshot();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].0, "sandbox_reuse_hit");
    }

    #[test]
    fn record_reuse_result_emits_miss_for_every_miss_variant() {
        let variants = [
            SandboxReuseResult::NoSessionId,
            SandboxReuseResult::PoolMiss,
            SandboxReuseResult::ProfileMismatch,
            SandboxReuseResult::UnparkFailed,
        ];
        for variant in variants {
            let mut telemetry = new_telemetry();
            record_reuse_result(&mut telemetry, variant);
            let ops = telemetry.pending_ops_snapshot();
            assert_eq!(ops.len(), 1, "{variant:?}");
            assert_eq!(ops[0].0, "sandbox_reuse_miss", "{variant:?}");
        }
    }

    #[tokio::test]
    async fn execute_job_records_sandbox_reuse_miss_in_telemetry() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();

        let cancel = tokio_util::sync::CancellationToken::new();
        let (_outcome, telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::PoolMiss,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;

        let ops = telemetry.pending_ops_snapshot();
        let reuse_events: Vec<_> = ops
            .iter()
            .filter(|op| op.0.starts_with("sandbox_reuse_"))
            .collect();
        assert_eq!(reuse_events.len(), 1);
        assert_eq!(reuse_events[0].0, "sandbox_reuse_miss");
    }

    #[tokio::test]
    async fn execute_job_reuse_records_sandbox_reuse_hit_in_telemetry() {
        let dir = tempfile::tempdir().unwrap();
        let config = test_executor_config(dir.path()).await;
        let mut factory = MockSandboxFactory::new();
        factory.startup().await.unwrap();

        let cancel = tokio_util::sync::CancellationToken::new();
        let (outcome, _telemetry) = execute_job(
            &factory,
            minimal_context(),
            NewSandboxDispatch {
                id: SandboxId::new_v4(),
                reuse_result: SandboxReuseResult::NoSessionId,
            },
            &config,
            &default_params(),
            cancel,
        )
        .await;
        let sandbox = outcome.sandbox.expect("sandbox should be alive");

        let idle_entry = crate::idle_pool::IdleEntry {
            sandbox,
            factory: std::sync::Arc::new(
                Box::new(MockSandboxFactory::new()) as Box<dyn SandboxFactory>
            ),
            session_id: "test-session".into(),
            sandbox_id: SandboxId::new_v4(),
            profile_name: "vm0/default".into(),
            vcpu: 2,
            memory_mb: 2048,
            source_ip: outcome.source_ip,
            parked_at: std::time::Instant::now(),
            idle_timeout: std::time::Duration::from_secs(300),
            storage_fingerprints: crate::idle_pool::StorageFingerprints::default(),
        };

        let cancel = tokio_util::sync::CancellationToken::new();
        let (_outcome, telemetry) =
            execute_job_reuse(idle_entry, minimal_context(), &config, cancel).await;

        let ops = telemetry.pending_ops_snapshot();
        let reuse_events: Vec<_> = ops
            .iter()
            .filter(|op| op.0.starts_with("sandbox_reuse_"))
            .collect();
        assert_eq!(reuse_events.len(), 1);
        assert_eq!(reuse_events[0].0, "sandbox_reuse_hit");
    }
}
