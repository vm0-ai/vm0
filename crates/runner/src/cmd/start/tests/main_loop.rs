use super::super::*;
use super::support::{
    assert_run_exits_within, context_with_session, minimal_context, mock_run_config,
    mock_run_config_with_api_url, mock_run_config_with_delay, mock_run_config_with_overrides,
    mock_run_config_with_runtime, push_job, shutdown, test_profiles, wait_budget_count,
    wait_budget_exhausted_reactor, wait_cancel_token, wait_cancel_token_removed,
    wait_discover_entered, wait_parking_state, wait_status_mode, wait_usage_flush_requested,
};

use super::super::signals::{SignalController, SignalHandlerTask, handle_resume_signal};
use crate::idle_pool::ParkingState;
use crate::provider::{ClaimedJob, CompletionAuth, JobCandidate};
use crate::types::{HeartbeatState, HeldSessionState, SandboxReuseResult};
use async_trait::async_trait;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

struct ShutdownRecordingProvider {
    shutdowns: Arc<AtomicUsize>,
}

#[async_trait]
impl crate::provider::JobProvider for ShutdownRecordingProvider {
    async fn discover(&self) -> Option<JobCandidate> {
        panic!("publish failure cleanup test does not discover jobs")
    }

    async fn claim(&self, _candidate: JobCandidate) -> Option<ClaimedJob> {
        panic!("publish failure cleanup test does not claim jobs")
    }

    async fn complete(
        &self,
        _run_id: RunId,
        _exit_code: i32,
        _error: Option<&str>,
        _sandbox_id: Option<sandbox::SandboxId>,
        _reuse_result: Option<SandboxReuseResult>,
        _completion_auth: CompletionAuth,
    ) {
        panic!("publish failure cleanup test does not complete jobs")
    }

    async fn heartbeat(&self, _state: &HeartbeatState) {}

    async fn set_held_session_states(&self, _states: Vec<HeldSessionState>) {}

    async fn shutdown(&self) {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
    }
}

struct ShutdownRecordingRuntime {
    shutdowns: Arc<AtomicUsize>,
}

#[async_trait]
impl sandbox::SandboxRuntime for ShutdownRecordingRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxFactory>> {
        panic!("publish failure cleanup test does not create factories")
    }

    async fn shutdown(&mut self) {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
    }
}

struct FactoryFailingRuntime {
    create_calls: Arc<AtomicUsize>,
    shutdowns: Arc<AtomicUsize>,
}

#[async_trait]
impl sandbox::SandboxRuntime for FactoryFailingRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxFactory>> {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
        Err(sandbox::SandboxError::Initialization {
            phase: sandbox::SandboxInitializationPhase::Factory,
            message: "factory failed".into(),
        })
    }

    async fn shutdown(&mut self) {
        self.shutdowns.fetch_add(1, Ordering::SeqCst);
    }
}

struct CountingRuntimeProvider {
    create_calls: Arc<AtomicUsize>,
}

#[async_trait]
impl sandbox::RuntimeProvider for CountingRuntimeProvider {
    async fn create_runtime(
        &self,
        _config: sandbox::RuntimeConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxRuntime>> {
        self.create_calls.fetch_add(1, Ordering::SeqCst);
        Ok(Box::new(ShutdownRecordingRuntime {
            shutdowns: Arc::new(AtomicUsize::new(0)),
        }))
    }
}

struct BlockingFactoryRuntime {
    entered: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    release: tokio::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}

impl BlockingFactoryRuntime {
    fn new(
        entered: tokio::sync::oneshot::Sender<()>,
        release: tokio::sync::oneshot::Receiver<()>,
    ) -> Self {
        Self {
            entered: Mutex::new(Some(entered)),
            release: tokio::sync::Mutex::new(Some(release)),
        }
    }
}

#[async_trait]
impl sandbox::SandboxRuntime for BlockingFactoryRuntime {
    async fn create_factory(
        &self,
        _config: sandbox::FactoryConfig,
    ) -> sandbox::Result<Box<dyn sandbox::SandboxFactory>> {
        if let Some(entered) = self
            .entered
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = entered.send(());
        }
        let release = {
            let mut guard = self.release.lock().await;
            guard.take().expect("factory release should be configured")
        };
        let _ = release.await;
        Ok(Box::new(sandbox_mock::MockSandboxFactory::new()))
    }

    async fn shutdown(&mut self) {}
}

async fn status_mode_if_exists(status_path: &std::path::Path) -> Option<String> {
    let raw = match tokio::fs::read_to_string(status_path).await {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => panic!("failed to read status file {}: {e}", status_path.display()),
    };
    let status: serde_json::Value = serde_json::from_str(&raw).unwrap();
    status
        .get("mode")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn usage_pending_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join("mitm-addon").join("usage-pending")
}

fn usage_test_now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn write_usage_pending_state(
    base_dir: &std::path::Path,
    usage_state_id: &str,
    flows: u32,
    buffered: u32,
    reports: u32,
) {
    let addon_dir = base_dir.join("mitm-addon");
    std::fs::create_dir_all(&addon_dir).unwrap();
    std::fs::write(
        usage_pending_path(base_dir),
        serde_json::json!({
            "pid": std::process::id(),
            "usageStateId": usage_state_id,
            "updatedAtMs": usage_test_now_millis(),
            "flows": flows,
            "buffered": buffered,
            "reports": reports,
        })
        .to_string(),
    )
    .unwrap();
}

#[tokio::test]
async fn live_runner_instance_publish_failure_shuts_down_startup_resources() {
    use tokio::io::AsyncBufReadExt;

    let dir = tempfile::tempdir().unwrap();
    let home = crate::paths::HomePaths::with_root(dir.path().join("vm0-runner"));
    std::fs::create_dir_all(dir.path().join("vm0-runner")).unwrap();
    std::fs::write(home.live_runner_instances_dir(), b"not a directory").unwrap();

    let provider_shutdowns = Arc::new(AtomicUsize::new(0));
    let provider = ShutdownRecordingProvider {
        shutdowns: Arc::clone(&provider_shutdowns),
    };
    let runtime_shutdowns = Arc::new(AtomicUsize::new(0));
    let mut runtime = ShutdownRecordingRuntime {
        shutdowns: Arc::clone(&runtime_shutdowns),
    };
    let status_path = dir.path().join("status.json");
    let status = StatusTracker::new(status_path.clone(), 4, None, None);
    let (mut mitm, _mitm_crash_rx) = crate::proxy::MitmProxy::noop();
    let mut ignore_term_child = tokio::process::Command::new("python3")
        .arg("-c")
        .arg(
            r#"
import os
import signal

signal.signal(signal.SIGTERM, signal.SIG_IGN)
os.write(1, b"ready\n")
while True:
    signal.pause()
"#,
        )
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let proxy_child_pid = ignore_term_child.id().expect("proxy child should have pid");
    let stdout = ignore_term_child.stdout.take().unwrap();
    let mut ready_lines = tokio::io::BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(2), ready_lines.next_line())
        .await
        .expect("ignore-term child did not become ready")
        .unwrap();
    assert_eq!(ready.as_deref(), Some("ready"));
    mitm.set_child_for_test(ignore_term_child);
    let prefetch_cancel = CancellationToken::new();
    let task_cancel = prefetch_cancel.clone();
    let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        task_cancel.cancelled().await;
        let _ = cancelled_tx.send(());
    });
    let mut memory_prefetch =
        crate::prefetch::MemoryPrefetchTasks::from_test_handle(prefetch_cancel, handle);
    let metadata = crate::live_runner_instances::LiveRunnerInstanceMetadata {
        config_path: dir.path().join("runner.yaml"),
        base_dir: dir.path().join("base"),
        runner_name: "test-runner".into(),
        runner_group: "vm0/test".into(),
        subcommand: "start".into(),
    };

    let error = match tokio::time::timeout(
        Duration::from_secs(2),
        publish_live_runner_instance_or_shutdown_startup_resources(
            &home,
            metadata,
            LiveRunnerPublishResources {
                provider: &provider,
                runtime: &mut runtime,
                mitm: &mut mitm,
                kmsg_handle: crate::kmsg_log::KmsgHandle::noop(),
                dns_handle: crate::dns::DnsProxy::noop(),
                memory_prefetch: &mut memory_prefetch,
                status: &status,
            },
        ),
    )
    .await
    .expect("publish failure cleanup should not wait for graceful proxy stop")
    {
        Ok(_) => panic!("live runner instance publish should fail"),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("ensure live runner instances"),
        "unexpected error: {error}"
    );
    assert_eq!(provider_shutdowns.load(Ordering::SeqCst), 1);
    assert_eq!(runtime_shutdowns.load(Ordering::SeqCst), 1);
    tokio::time::timeout(Duration::from_secs(5), cancelled_rx)
        .await
        .expect("prefetch task should observe cleanup cancellation")
        .expect("prefetch task should report cancellation");
    assert_eq!(memory_prefetch.task_count(), 0);
    assert!(
        !std::path::Path::new(&format!("/proc/{proxy_child_pid}")).exists(),
        "proxy child should be killed and reaped during cleanup"
    );
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn startup_does_not_publish_running_before_factories_are_ready() {
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let runtime = BlockingFactoryRuntime::new(entered_tx, release_rx);
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    tokio::time::timeout(Duration::from_secs(2), entered_rx)
        .await
        .expect("factory startup should be entered")
        .expect("factory startup should report entry");
    assert_ne!(
        status_mode_if_exists(&status_path).await.as_deref(),
        Some("running"),
        "runner must not publish running before factories are ready",
    );

    release_tx
        .send(())
        .expect("runner should still be waiting for factory release");
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn factory_startup_failure_stops_status_and_cleans_startup_resources() {
    let create_calls = Arc::new(AtomicUsize::new(0));
    let runtime_shutdowns = Arc::new(AtomicUsize::new(0));
    let runtime = FactoryFailingRuntime {
        create_calls: Arc::clone(&create_calls),
        shutdowns: Arc::clone(&runtime_shutdowns),
    };
    let (config, env) =
        mock_run_config_with_runtime(test_profiles(), 8, 32768, 4, Box::new(runtime));
    let status_path = env._temp_dir.path().join("status.json");

    let error = run(config).await.expect_err("factory startup should fail");

    assert!(
        error.to_string().contains("factory failed"),
        "unexpected error: {error}"
    );
    assert_eq!(create_calls.load(Ordering::SeqCst), 1);
    assert_eq!(runtime_shutdowns.load(Ordering::SeqCst), 1);
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

#[tokio::test]
async fn local_provider_setup_failure_does_not_create_runtime() {
    const ROOTFS_HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const SNAPSHOT_HASH: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let home_parent = home
        .groups_dir()
        .parent()
        .expect("groups dir should have a parent")
        .to_path_buf();
    tokio::fs::create_dir_all(&home_parent).await.unwrap();
    tokio::fs::write(home.groups_dir(), b"not a directory")
        .await
        .unwrap();

    let rootfs = crate::paths::RootfsPaths::new(&home, ROOTFS_HASH);
    let snapshot = rootfs.snapshot(SNAPSHOT_HASH);
    tokio::fs::create_dir_all(snapshot.dir()).await.unwrap();
    tokio::fs::write(rootfs.rootfs(), b"").await.unwrap();
    for path in [
        snapshot.snapshot_bin(),
        snapshot.memory_bin(),
        snapshot.cow_img(),
        snapshot.cow_bitmap(),
    ] {
        tokio::fs::write(path, b"").await.unwrap();
    }
    tokio::fs::write(
        snapshot.complete_marker(),
        sandbox_fc::SNAPSHOT_COMPLETE_MARKER_CONTENT,
    )
    .await
    .unwrap();

    let ca_dir = dir.path().join("ca");
    let firecracker = dir.path().join("firecracker");
    let kernel = dir.path().join("vmlinux");
    tokio::fs::create_dir_all(&ca_dir).await.unwrap();
    tokio::fs::write(&firecracker, b"").await.unwrap();
    tokio::fs::write(&kernel, b"").await.unwrap();

    let base_dir = dir.path().join("base");
    let config_path = dir.path().join("runner.yaml");
    tokio::fs::write(
        &config_path,
        format!(
            r#"
name: test
group: test/group
base_dir: {base_dir}
ca_dir: {ca_dir}
firecracker:
  binary: {firecracker}
  kernel: {kernel}
sandbox:
  max_concurrent: 1
profiles:
  vm0/default:
    rootfs_hash: {ROOTFS_HASH}
    snapshot_hash: {SNAPSHOT_HASH}
    vcpu: 2
    memory_mb: 4096
    rootfs_disk_mb: 8192
    workspace_disk_mb: 10240
server:
  url: http://localhost:0
  token: token
"#,
            base_dir = base_dir.display(),
            ca_dir = ca_dir.display(),
            firecracker = firecracker.display(),
            kernel = kernel.display(),
        ),
    )
    .await
    .unwrap();

    let create_calls = Arc::new(AtomicUsize::new(0));
    let provider = CountingRuntimeProvider {
        create_calls: Arc::clone(&create_calls),
    };
    let error = run_start_with_home(
        StartArgs {
            config: config_path,
            api_url: None,
            token: None,
            local: true,
        },
        &provider,
        || Ok(home),
    )
    .await
    .expect_err("local provider setup should fail before runtime creation");

    assert!(
        error.to_string().contains("create group dir"),
        "unexpected error: {error}"
    );
    assert_eq!(create_calls.load(Ordering::SeqCst), 0);
}

async fn install_usage_flush_child(config: &mut RunConfig) {
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::AsyncBufReadExt;

    std::fs::create_dir_all(config.paths.base_dir.join("mitm-addon")).unwrap();
    let script = config.paths.base_dir.join("usage-flush-child.sh");
    std::fs::write(
        &script,
        r#"#!/usr/bin/env bash
set -euo pipefail
fifo="$0.fifo"
base_dir="$(dirname "$0")"
request="$base_dir/mitm-addon/usage-flush-request"
pending="$base_dir/mitm-addon/usage-pending"
jsonl_request="$base_dir/mitm-addon/jsonl-flush-request"
jsonl_state="$base_dir/mitm-addon/jsonl-flush-state"
write_pending_snapshot() {
  [[ -f "$request" ]] || return 0
  flush_id="$(sed -n 's/.*"flushRequestId":"\([^"]*\)".*/\1/p' "$request")"
  state_id="$(sed -n 's/.*"usageStateId":"\([^"]*\)".*/\1/p' "$request")"
  [[ -n "$flush_id" && -n "$state_id" ]] || return 0
  now_ms="$(date +%s%3N)"
  printf '{"pid":%s,"usageStateId":"%s","updatedAtMs":%s,"flows":0,"buffered":0,"reports":0,"flushRequestId":"%s"}' "$$" "$state_id" "$now_ms" "$flush_id" > "$pending"
}
write_jsonl_flush_state() {
  [[ -f "$jsonl_request" ]] || return 0
  flush_id="$(sed -n 's/.*"flushRequestId":"\([^"]*\)".*/\1/p' "$jsonl_request")"
  state_id="$(sed -n 's/.*"usageStateId":"\([^"]*\)".*/\1/p' "$jsonl_request")"
  path="$(sed -n 's/.*"path":"\([^"]*\)".*/\1/p' "$jsonl_request")"
  [[ -n "$flush_id" && -n "$state_id" && -n "$path" ]] || return 0
  now_ms="$(date +%s%3N)"
  printf '{"pid":%s,"usageStateId":"%s","updatedAtMs":%s,"flushRequestId":"%s","path":"%s","pending":0}' "$$" "$state_id" "$now_ms" "$flush_id" "$path" > "$jsonl_state"
}
handle_flush_request() {
  write_pending_snapshot
  write_jsonl_flush_state
}
mkfifo "$fifo"
exec 3<>"$fifo"
trap handle_flush_request USR1
trap 'exit 0' TERM
echo ready
while true; do read -r _ <&3 || true; done
"#,
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut child = tokio::process::Command::new(&script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut ready_lines = tokio::io::BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(2), ready_lines.next_line())
        .await
        .expect("usage flush child did not print ready")
        .unwrap()
        .expect("usage flush child stdout closed before ready");
    assert_eq!(ready, "ready");
    config.proxy.mitm.set_child_for_test(child);
}

// -----------------------------------------------------------------------
// Test 1: Normal discover → claim → execute → complete
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn main_loop_discover_claim_execute_complete() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");
    let c = completion.unwrap();
    assert_eq!(c.exit_code, 0);
    assert!(c.error.is_none());

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn job_completion_requests_proxy_usage_flush_without_waiting() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    install_usage_flush_child(&mut config).await;
    let usage_state_id = config.proxy.mitm.usage_state_id_for_test().to_string();
    write_usage_pending_state(&config.paths.base_dir, &usage_state_id, 0, 0, 1);
    let base_dir = config.paths.base_dir.clone();
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "job completion must not wait for proxy usage drain"
    );
    wait_usage_flush_requested(&env, Duration::from_secs(5)).await;

    write_usage_pending_state(&base_dir, &usage_state_id, 0, 0, 0);
    shutdown(&env, run_handle).await;
}

/// Regression for #11157: normal Running mode with available budget must
/// still reap completed job tasks so their cancel tokens do not remain
/// until a later drain, shutdown, or budget-exhausted wait.
#[tokio::test(start_paused = true)]
async fn running_reaps_completed_jobs_without_budget_exhaustion() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");

    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

/// Regression guard: the post-complete deferred network-log upload (moved
/// out of `post_job_cleanup` by #9828) must still reach the telemetry
/// endpoint, AND the drain shutdown must actually block on it — catching a
/// `tokio::spawn` fire-and-forget refactor that would silently lose the
/// upload on runtime drop.
///
/// The mock responds with a 400 ms delay. Since the job completes almost
/// immediately under `MockSandboxRuntime`, `shutdown()` is invoked while
/// the deferred `tokio::join!(flush, upload)` is still in-flight, so a
/// well-behaved drain returns AFTER the mock delay elapses. A detached
/// upload would let shutdown return immediately — the elapsed-time
/// assertion below is what catches that.
#[tokio::test]
async fn deferred_network_log_upload_drains_on_graceful_shutdown() {
    use httpmock::prelude::*;

    const MOCK_DELAY: Duration = Duration::from_millis(400);

    let server = MockServer::start_async().await;
    let network_log_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("pending.example");
            then.delay(MOCK_DELAY)
                .status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let (mut config, env) =
        mock_run_config_with_api_url(test_profiles(), 8, 32768, 4, &server.base_url());
    install_usage_flush_child(&mut config).await;
    let addon_dir = config.paths.base_dir.join("mitm-addon");
    config.proxy.mitm.set_addon_dir_for_test(addon_dir.clone());
    let mitm_jsonl_flush = config
        .proxy
        .mitm
        .jsonl_flush_handle(config.usage_flush_tx.clone());
    let write_started = Arc::new(tokio::sync::Notify::new());
    let release_write = Arc::new(tokio::sync::Semaphore::new(0));
    let network_log_manager =
        NetworkLogManager::new_with_write_gate(write_started.clone(), release_write.clone());
    let exec_config = Arc::get_mut(&mut config.exec_config)
        .expect("test config should not share exec_config before run starts");
    exec_config.network_log_manager = network_log_manager.clone();
    exec_config.mitm_jsonl_flush = Some(mitm_jsonl_flush);

    // Seed a network log file so `upload_network_logs` has a payload to POST
    // (otherwise it early-returns on NotFound and the assertion below would
    // measure nothing).
    let run_id = RunId::new_v4();
    let network_log_path = config.exec_config.log_paths.network_log(run_id);
    std::fs::create_dir_all(network_log_path.parent().unwrap()).unwrap();
    std::fs::write(
            &network_log_path,
            concat!(
                r#"{"timestamp":"2026-01-01T00:00:00","action":"ALLOW","host":"example.com","method":"GET","url":"https://example.com/","status":200}"#,
                "\n",
            ),
        )
        .unwrap();
    let _network_log_session = network_log_manager
        .register_source_ip("10.200.0.200", network_log_path.clone())
        .await;
    assert!(
        network_log_manager
            .append_for_ip(
                "10.200.0.200",
                serde_json::json!({
                    "timestamp": "2026-01-01T00:00:01Z",
                    "type": "dns",
                    "host": "pending.example",
                    "port": 53,
                }),
            )
            .await
    );
    write_started.notified().await;

    let run_handle = tokio::spawn(run(config));
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // The finalizer now closes Rust-side network-log attribution before
    // completing the job, so release the accepted write before waiting for
    // completion. The upload itself is still deferred until after the
    // completion request below.
    release_write.add_permits(1);
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");

    // Drain shutdown — must block on each `spawn_job` closure's deferred
    // `tokio::join!(flush, upload)` via the outer `jobs` JoinSet.
    let shutdown_start = tokio::time::Instant::now();
    shutdown(&env, run_handle).await;
    let shutdown_elapsed = shutdown_start.elapsed();

    network_log_mock.assert_calls_async(1).await;
    let jsonl_request: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(addon_dir.join("jsonl-flush-request")).unwrap(),
    )
    .unwrap();
    let jsonl_state: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(addon_dir.join("jsonl-flush-state")).unwrap(),
    )
    .unwrap();
    let network_log_path_string = network_log_path.to_string_lossy().to_string();
    assert_eq!(jsonl_request["path"], network_log_path_string);
    assert_eq!(
        jsonl_state["flushRequestId"],
        jsonl_request["flushRequestId"]
    );
    assert_eq!(jsonl_state["path"], network_log_path_string);
    assert_eq!(jsonl_state["pending"], 0);

    // Stronger invariant: drain must actually WAIT for the deferred work.
    // With a 400 ms mock delay, a well-behaved drain takes ≥ the delay;
    // a detached (fire-and-forget) upload would let shutdown return in
    // tens of ms, dropping the in-flight request on runtime teardown.
    assert!(
        shutdown_elapsed >= MOCK_DELAY - Duration::from_millis(50),
        "drain must block on deferred upload (≥{MOCK_DELAY:?}); took only {shutdown_elapsed:?}",
    );
}

// -----------------------------------------------------------------------
// Test 2: Discover survives heartbeat ticks (regression #8783)
//
// ApiProvider's discover() has an internal poll timer (30s) that must
// survive heartbeat ticks (10s). Without pinning, `select!` cancels
// and recreates discover() each tick, restarting the timer from scratch.
//
// We use poll_delay=20s to simulate this: if the future is pinned, the
// delay completes at t=20s and the job is discovered. If not pinned,
// heartbeat at t=10s restarts the delay → it won't complete until t=30s.
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn discover_survives_heartbeat_ticks() {
    let (config, env) = mock_run_config_with_delay(
        test_profiles(),
        8,
        32768,
        4,
        Duration::from_secs(20), // poll delay: 20s
    );
    let run_handle = tokio::spawn(run(config));
    assert!(
        env.handle
            .wait_discover_poll_started(Duration::from_secs(5))
            .await,
        "discover poll delay should start before virtual time advances"
    );

    // Push job immediately — it's in the channel, waiting for
    // discover to finish its poll delay and read it.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // Advance to the first heartbeat while the 20s discover delay is still
    // pending, then let the runner task observe the ready timer.
    tokio::time::advance(HEARTBEAT_PERIOD).await;
    tokio::task::yield_now().await;
    assert!(
        env.handle
            .wait_heartbeat_past(0, Duration::from_secs(1))
            .await,
        "heartbeat should fire while discover poll delay is running"
    );

    // Advance past the rest of the 20s poll delay. If discover was cancelled
    // and recreated at t=10s, the delay restarts and this is still too early.
    tokio::time::advance(Duration::from_secs(15)).await;

    // Job should have been discovered and completed.
    // If discover was cancelled and recreated at t=10s, the 20s delay
    // restarts → at t=25s only 15s of the second delay has elapsed →
    // job not discovered yet → this assertion fails.
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(10))
        .await;
    assert!(
        completion.is_some(),
        "job should complete — discover must survive heartbeat ticks (regression #8783)"
    );

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 3: Shutdown completes without deadlock (regression #8898)
//
// Uses REAL time (not paused) because a Mutex deadlock blocks the
// tokio runtime — paused time can't advance past a non-timer await.
//
// Only sends Draining (does NOT cancel the token). This forces the
// worst-case race: mode_rx.changed() wins the select!, loop breaks
// at the top-of-loop check, and discover_fut is never polled again.
// The explicit `drop(discover_fut)` releases the Mutex so shutdown()
// can proceed. Without that drop, shutdown() deadlocks on the Mutex.
// -----------------------------------------------------------------------

#[tokio::test]
async fn shutdown_completes_without_deadlock() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // Let the main loop start and enter the discover select arm.
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Only send Draining — do NOT cancel. The Draining path sees
    // `jobs.is_empty()` immediately (no active jobs), breaks to
    // teardown, and `drop(discover_fut)` releases the Mutex before
    // `provider.shutdown()`. Without that drop → deadlock (regression #8898).
    env.drain();

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(2),
        "deadlock detected: run() did not finish within 2s (regression #8898)",
    )
    .await;
}

#[tokio::test]
async fn shutdown_drains_memory_prefetch_before_stopped() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let status_path = env._temp_dir.path().join("status.json");
    let prefetch_cancel = tokio_util::sync::CancellationToken::new();
    let task_cancel = prefetch_cancel.clone();
    let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        task_cancel.cancelled().await;
        let _ = cancelled_tx.send(());
        let _ = release_rx.await;
    });
    config.shutdown.memory_prefetch =
        crate::prefetch::MemoryPrefetchTasks::from_test_handle(prefetch_cancel, handle);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    env.drain();
    env.cancel.cancel();
    tokio::time::timeout(Duration::from_secs(5), cancelled_rx)
        .await
        .expect("memory prefetch should be cancelled during teardown")
        .expect("memory prefetch task should report cancellation");

    assert!(
        !run_handle.is_finished(),
        "runner shutdown should wait for memory prefetch drain before returning",
    );
    let raw_status = tokio::fs::read_to_string(&status_path).await.unwrap();
    let status: serde_json::Value = serde_json::from_str(&raw_status).unwrap();
    assert_ne!(
        status.get("mode").and_then(serde_json::Value::as_str),
        Some("stopped"),
        "runner must not write stopped status before memory prefetch drain finishes",
    );

    release_tx
        .send(())
        .expect("runner should still be waiting for prefetch release");
    let result = tokio::time::timeout(Duration::from_secs(5), run_handle)
        .await
        .expect("run should finish after memory prefetch drains")
        .expect("task should not panic");
    assert!(result.is_ok());
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

// -----------------------------------------------------------------------
// Draining / resume / hard-shutdown state machine
// -----------------------------------------------------------------------

/// SIGUSR1 → SIGUSR2 round-trip. While draining, the runner keeps the
/// in-flight job alive and, on resume, returns to claiming new jobs.
#[tokio::test]
async fn drain_then_resume_keeps_jobs_running() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    // Claim a job and let it reach the gated wait.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // Enter Draining. The job keeps running; no cancellation is fired.
    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;

    // Resume. Job is still alive in the executor.
    env.resume();
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;

    // Release the gated job so it completes normally.
    gate.notify_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete after resume");
    let c = completion.unwrap();
    assert_eq!(c.exit_code, 0, "job ran to normal completion");
    assert!(c.error.is_none(), "no cancellation error");

    // Runner is back in Running — a second job is claimed (cancel_token
    // inserted). Don't wait for completion here; the shared wait_process_gate
    // would also block this job's exit.
    let run_id_2 = RunId::new_v4();
    push_job(
        &env,
        run_id_2,
        "vm0/default",
        Some(minimal_context(run_id_2)),
    );
    let _token_2 = wait_cancel_token(&env.cancel_tokens, run_id_2, Duration::from_secs(5)).await;

    // Tear down hard — the shared gate would otherwise block the
    // second job's natural completion during Draining.
    env.trigger_stopping().await;
    let result = tokio::time::timeout(Duration::from_secs(5), run_handle)
        .await
        .expect("run should exit within 5s after hard shutdown")
        .expect("task should not panic");
    assert!(result.is_ok());
}

/// Regression guard for the unified reactor's Draining-entry state.
///
/// The first SIGUSR1 drains the idle pool, then SIGUSR2 resumes Running.
/// A later job completion parks a VM, and the second SIGUSR1 must drain
/// that newly parked VM. If `draining_idle_pool_drained` is not reset on
/// Running, the second drain skips idle-pool cleanup and leaks budget.
#[tokio::test]
async fn drain_resume_then_second_drain_drains_idle_pool() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let idle_pool = Arc::clone(&config.shared.idle_pool);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(
        &env,
        run_id,
        "vm0/default",
        Some(context_with_session(run_id, "sess-second-drain")),
    );
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    env.drain();
    wait_parking_state(
        &idle_pool,
        ParkingState::SoftDraining,
        Duration::from_secs(5),
    )
    .await;
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Draining);

    env.resume();
    wait_parking_state(&idle_pool, ParkingState::Open, Duration::from_secs(5)).await;
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Running);

    gate.notify_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete after resume");
    assert_eq!(idle_pool.lock().await.len(), 1, "job should park a VM");
    assert_eq!(
        budget.allocated().2,
        1,
        "parked VM should hold a budget slot"
    );

    env.drain();
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "second drain should exit within 5s",
    )
    .await;

    assert_eq!(
        idle_pool.lock().await.len(),
        0,
        "second drain must clear the idle pool",
    );
    assert_eq!(
        budget.allocated().2,
        0,
        "second drain must release the parked VM budget",
    );
}

/// Invariant: heartbeat ticks must fire while the unified reactor is
/// parked in Draining mode. Silently dropping its `heartbeat_tick` branch
/// would leave a draining runner looking dead to the server until it exits.
///
/// Drain before the first tick (t >= 10s) so the runner transitions to
/// Draining mode first; the tick observed after the time advance therefore
/// had to be handled by the Draining-mode heartbeat branch.
#[tokio::test(start_paused = true)]
async fn heartbeat_fires_while_draining() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    // Claim a gated job so Draining mode has an active job to wait
    // on — otherwise `jobs.is_empty()` auto-transitions straight to
    // Stopping before the Draining wait path is exercised.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // Enter Draining before the first heartbeat tick fires. `status.json`
    // is updated only after the main loop observes the mode transition.
    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Draining);
    let before = env.handle.heartbeat_count();

    // Advance past the first tick while Draining mode is active.
    // A broken Draining path that dropped its `heartbeat_tick.tick()`
    // branch would leave the count unchanged; `wait_heartbeat_past`
    // returns false on timeout.
    tokio::time::advance(HEARTBEAT_PERIOD + Duration::from_secs(5)).await;
    assert!(
        env.handle
            .wait_heartbeat_past(before, Duration::from_secs(5))
            .await,
        "Draining mode must handle heartbeat_tick (baseline={before})",
    );

    // Tear down hard — the gate would block natural completion.
    env.trigger_stopping().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), run_handle).await;
}

/// Invariant: heartbeat ticks must fire while the unified reactor is
/// parked with budget exhausted. Dropping its `heartbeat_tick` branch would
/// make a runner that's at resource capacity look dead to the server until
/// budget frees.
///
/// A 1-slot budget + a gated job pins the runner in the budget-exhausted
/// state for the duration of the time advance.
#[tokio::test(start_paused = true)]
async fn heartbeat_fires_while_budget_exhausted() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    // Budget sized for exactly one `test_profiles()` slot (vcpu=2, mem=4096).
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 2, 4096, 1, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    // Wait for the reservation — after this, the next loop iteration
    // enters the budget-exhausted wait state at the can_afford check.
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;
    wait_budget_exhausted_reactor(&env, Duration::from_secs(5)).await;
    let before = env.handle.heartbeat_count();

    // Advance past the first tick while the runner is budget-exhausted.
    // Removing the `heartbeat_tick.tick()` branch from the reactor `select!`
    // leaves the count unchanged; `wait_heartbeat_past` returns false
    // on timeout.
    tokio::time::advance(HEARTBEAT_PERIOD + Duration::from_secs(5)).await;
    assert!(
        env.handle
            .wait_heartbeat_past(before, Duration::from_secs(5))
            .await,
        "budget-exhausted arm must handle heartbeat_tick (baseline={before})",
    );

    // Release the gate so the job completes, budget frees, and the
    // standard `shutdown()` helper (Draining → auto-Stop) terminates
    // the runner cleanly — same pattern as `budget_full_skips_then_resumes`.
    gate.notify_one();
    let _ = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    shutdown(&env, run_handle).await;
}

/// With no active jobs, SIGUSR1 transitions straight through Draining
/// and exits within a few hundred ms.
#[tokio::test]
async fn drain_without_active_jobs_exits_promptly() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    env.drain();

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(2),
        "drain with no active jobs should exit within 2s",
    )
    .await;
}

/// SIGUSR2 on an already-Running runner is a no-op: it does not disturb
/// normal discovery.
#[tokio::test(start_paused = true)]
async fn resume_on_running_is_noop() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // SIGUSR2 while already Running — state guard blocks the send,
    // leaving mode unchanged and discovery uninterrupted.
    env.resume();

    // Runner is still claiming jobs.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "resume on Running should not break discovery"
    );

    shutdown(&env, run_handle).await;
}

/// SIGTERM while a job is in flight: per-job cancellation fires, the
/// executor aborts, and run() exits within a couple of seconds rather
/// than blocking on the 2h JOB_TIMEOUT.
#[tokio::test]
async fn hard_shutdown_cancels_active_jobs() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        gate,
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // Wait for the job to enter the gated wait — cancel token is now in the map.
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // SIGTERM equivalent: latch hard-shutdown, cancel all in-flight jobs.
    env.trigger_stopping().await;

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "hard shutdown should exit within 3s — got stuck",
    )
    .await;

    // The cancelled job reports the synthetic "cancelled by user" error.
    let comps = env.handle.completions.lock().unwrap();
    let c = comps
        .iter()
        .find(|c| c.run_id == run_id)
        .expect("cancelled job should still report completion");
    assert_eq!(c.error.as_deref(), Some("cancelled by user"));
}

#[tokio::test]
async fn signal_handler_exit_cancels_active_jobs() {
    let handler_exit = Arc::new(tokio::sync::Notify::new());
    let handler_task = {
        let handler_exit = Arc::clone(&handler_exit);
        tokio::spawn(async move {
            handler_exit.notified().await;
        })
    };

    assert_signal_handler_task_end_cancels_active_jobs(handler_task, || {
        handler_exit.notify_one();
    })
    .await;
}

#[tokio::test]
async fn signal_handler_panic_cancels_active_jobs() {
    let handler_panic = Arc::new(tokio::sync::Notify::new());
    let handler_task = {
        let handler_panic = Arc::clone(&handler_panic);
        tokio::spawn(async move {
            handler_panic.notified().await;
            panic!("signal handler task panic");
        })
    };

    assert_signal_handler_task_end_cancels_active_jobs(handler_task, || {
        handler_panic.notify_one();
    })
    .await;
}

#[tokio::test]
async fn graceful_shutdown_aborts_signal_handler_task() {
    struct ReleaseOnDrop(Arc<tokio::sync::Semaphore>);

    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            self.0.add_permits(1);
        }
    }

    let started = Arc::new(tokio::sync::Notify::new());
    let dropped = Arc::new(tokio::sync::Semaphore::new(0));
    let handler_task = {
        let started = Arc::clone(&started);
        let dropped = Arc::clone(&dropped);
        tokio::spawn(async move {
            let _guard = ReleaseOnDrop(dropped);
            started.notify_one();
            std::future::pending::<()>().await;
        })
    };
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .expect("signal handler test task should start");

    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    config.signals.signal_source = SignalSource::Override(SignalController {
        mode_rx: env.mode_tx.subscribe(),
        lifecycle: env.lifecycle.clone(),
        handler_task: Some(SignalHandlerTask::new(handler_task)),
    });
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    shutdown(&env, run_handle).await;

    let _permit = dropped
        .try_acquire()
        .expect("graceful shutdown should await signal handler task abort");
}

async fn assert_signal_handler_task_end_cancels_active_jobs(
    handler_task: tokio::task::JoinHandle<()>,
    trigger_handler_task_end: impl FnOnce(),
) {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        gate,
    ));
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    config.signals.signal_source = SignalSource::Override(SignalController {
        mode_rx: env.mode_tx.subscribe(),
        lifecycle: env.lifecycle.clone(),
        handler_task: Some(SignalHandlerTask::new(handler_task)),
    });
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    trigger_handler_task_end();

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "signal handler exit should cancel active jobs and stop promptly",
    )
    .await;

    let comps = env.handle.completions.lock().unwrap();
    let c = comps
        .iter()
        .find(|c| c.run_id == run_id)
        .expect("cancelled job should still report completion");
    assert_eq!(c.error.as_deref(), Some("cancelled by user"));
}

/// SIGUSR1 → SIGTERM upgrade. Starts Draining, then hard-shutdown fires
/// mid-drain and the run exits promptly with the active job cancelled.
#[tokio::test]
async fn drain_then_hard_shutdown_upgrades() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        gate,
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // Draining. Without hard shutdown, this would wait up to JOB_TIMEOUT = 2h.
    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;

    // Upgrade to hard shutdown.
    env.trigger_stopping().await;

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "Draining → hard shutdown should exit within 3s",
    )
    .await;
}

/// TOCTOU regression: soft drain can arrive after the main loop has selected
/// a discovered candidate but before claim. The candidate is still unowned at
/// that point, so Draining must roll back local admission and skip claim.
#[tokio::test]
async fn claim_after_draining_sent_skips_unclaimed_job() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    assert!(env.parking_gate.soft_drain());
    env.mode_tx.send_if_modified(|v| {
        *v = RunnerMode::Draining;
        false
    });

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "draining should skip the discovered unclaimed job and exit",
    )
    .await;

    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    let completions = env.handle.completions.lock().unwrap();
    assert!(
        !completions
            .iter()
            .any(|completion| completion.run_id == run_id),
        "draining should not claim or complete a newly discovered job"
    );
}

/// TOCTOU regression: a SIGTERM that iterates `cancel_tokens` *before*
/// the main loop inserts a newly-claimed job's token would leave that
/// job running uncancelled. The fix is a post-insert `mode_rx.borrow()`
/// check that catches Stopping and cancels the token in that window.
///
/// To reproduce deterministically, we use `send_if_modified` to flip
/// the watch value to `Stopping` **without** waking `mode_rx.changed()`
/// — this is exactly what the racy window looks like to the main loop:
/// its outer select! is still polling discover_fut, unaware that the
/// value has changed. When discover yields a job, the main loop takes
/// the claim path, inserts the token, then reads `mode_rx.borrow()`
/// and catches the Stopping value that was silently written.
#[tokio::test]
async fn claim_after_stopping_sent_cancels_new_job() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // Deterministic barrier: wait for run()'s main loop to have polled
    // `discover_fut` into its await state. Only then is the Running-mode
    // reactor `select!` provably in place, which is the precondition for the
    // silent `send_if_modified` below to land without waking the loop.
    // A wall-clock sleep here flakes under coverage CI — see #10146.
    // The 2s timeout gives a clear diagnostic if the "loop parks on
    // discover" invariant ever regresses, rather than hanging until
    // the outer test harness kills us.
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Flip the watch value to Stopping without firing changed().
    env.parking_gate.close();
    env.mode_tx.send_if_modified(|v| {
        *v = RunnerMode::Stopping;
        false
    });

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // `wait_completion` is event-driven (fires on `provider.complete`), so
    // this duration is a diagnostic cap for genuine hangs — not a budget
    // for the run. A large cap absorbs coverage-CI slowdown of the full
    // dispatch→executor→complete chain without flaking (see #10146).
    let c = env
        .handle
        .wait_completion(run_id, Duration::from_secs(30))
        .await;
    assert!(
        c.is_some(),
        "job must report cancellation even when the handler missed the token"
    );
    assert_eq!(c.unwrap().error.as_deref(), Some("cancelled by user"));

    // Let run() exit — fire changed() now so the main loop observes
    // Stopping at loop top and breaks to teardown.
    env.parking_gate.close();
    env.mode_tx.send_modify(|v| {
        *v = RunnerMode::Stopping;
    });
    env.cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(5), run_handle).await;
}

/// SIGUSR2 received while Stopping is committed is ignored — the
/// runner cannot resume out of Stopping.
#[tokio::test]
async fn resume_after_stopping_is_ignored() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // Wait for the main loop to park on `discover_fut` so the subsequent
    // `trigger_stopping` lands on a steady-state loop rather than racing
    // against startup. This test does not depend on the silent-flip
    // semantics of `claim_after_stopping_sent_cancels_new_job` (it uses
    // `trigger_stopping`, which fires `changed()`), but the same barrier
    // is still the right "main loop is idle" signal — and deterministic
    // under coverage CI, unlike the 50 ms sleep this replaces.
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Enter Stopping first.
    env.trigger_stopping().await;

    // handle_resume_signal refuses any transition except from Draining.
    handle_resume_signal(&env.lifecycle);
    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Stopping,
        "mode must remain Stopping after ignored SIGUSR2"
    );

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(2),
        "hard shutdown should exit within 2s",
    )
    .await;
}

/// Regression for #10146 / #10223: the main-loop `idle_cleanup` and
/// `heartbeat_tick` intervals must defer their first tick past the
/// configured period, so neither tick branch is Ready on the first `select!`
/// poll. Otherwise they pre-empt `discover_fut` (which parks on
/// `rx.recv()` → Pending) and any silent `mode_tx` flip during the
/// tick body breaks the loop before the pending job is ever claimed.
///
/// The behavioral test `claim_after_stopping_sent_cancels_new_job`
/// only triggers the underlying race under `cargo llvm-cov`, so a
/// silent revert of `interval_at` → `interval` would not fail it on
/// the default CI path. This test pins the invariant directly: a
/// job pushed immediately at startup is processed without any tick
/// having fired, observable via `heartbeat_count == 0`.
#[tokio::test(start_paused = true)]
async fn heartbeat_tick_defers_past_first_select_poll() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // `minimal_context` → no session → completion path does not trigger
    // `park_notify`, so any heartbeat observed here came from the
    // interval tick (the path we want to prove did NOT fire).
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job must complete");

    assert_eq!(
        env.handle.heartbeat_count(),
        0,
        "heartbeat tick fired before the startup job was processed — \
             is the main-loop interval `interval_at(now + period, period)` \
             instead of `interval(period)`?"
    );

    shutdown(&env, run_handle).await;
}

/// Draining auto-transitions to Stopping when jobs drain naturally.
/// Verifies the internal lifecycle transition from Draining to Stopping.
#[tokio::test]
async fn drain_with_jobs_transitions_to_stopping_when_empty() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // Let a quick job complete, then drain.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _ = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;

    // Wait for the main loop to reap the completed job, then drain.
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    env.drain();

    // Draining mode should observe jobs.is_empty() and self-send
    // Stopping, leading to teardown and run() exit.
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "Draining natural drain should exit within 3s",
    )
    .await;

    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Stopping,
        "mode_tx must reflect Stopping after natural drain transition"
    );
    assert_eq!(env.parking_gate.state(), ParkingState::Closed);

    // Observability pin: the Draining → Stopping auto-transition must
    // emit a one-shot heartbeat with mode="stopping" before teardown,
    // in addition to the terminal heartbeat during teardown. Two or
    // more "stopping" heartbeats prove both sites fire (the one-shot
    // at the transition and the terminal one). A single hit would mean
    // one of the two was removed.
    let stopping_count = env
        .handle
        .heartbeats
        .lock()
        .unwrap()
        .iter()
        .filter(|h| h.mode == "stopping")
        .count();
    assert!(
        stopping_count >= 2,
        "expected at least 2 stopping heartbeats (one-shot + terminal), got {stopping_count}",
    );
}

/// Race regression: the Draining → Stopping auto-transition must be
/// guarded on `mode == Draining`, so a concurrent SIGUSR2 that flips
/// mode back to Running is preserved rather than silently overwritten.
///
/// We simulate the race deterministically:
/// 1. Claim a gated job — mode is Draining and the reactor is waiting
///    with Draining-mode guards.
/// 2. Silently flip mode to Running via `send_if_modified(false)`
///    (equivalent to SIGUSR2 arriving *after* the arm noticed jobs was
///    non-empty but *before* the next iteration's guard).
/// 3. Release the gate — the job completes, the reactor reaps it, loops to
///    top, sees `jobs.is_empty()`, and evaluates the guarded
///    `send_if_modified`. The guard rejects the overwrite because mode
///    is no longer Draining.
/// 4. Outer loop re-reads mode → Running → resumes normal discovery.
#[tokio::test]
async fn draining_auto_stop_preserves_concurrent_resume() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    // Claim a job and hold it at the gate so Draining mode has
    // something to wait on — without a live job the auto-transition
    // fires before any concurrent signal could race.
    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;
    assert_eq!(*env.mode_tx.borrow(), RunnerMode::Draining);

    // Silently flip to Running — the `false` return suppresses
    // `changed()`, so the arm does not wake on a mode transition. The
    // guard will only observe the new value on its next iteration's
    // send_if_modified closure.
    env.parking_gate.open_after_soft_drain();
    env.mode_tx.send_if_modified(|v| {
        *v = RunnerMode::Running;
        false
    });

    // Release the gate: job completes, the arm reaps, then checks
    // jobs.is_empty() → true → calls the guarded send_if_modified.
    gate.notify_one();
    let _ = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;

    assert_eq!(
        *env.mode_tx.borrow(),
        RunnerMode::Running,
        "SIGUSR2 must win the race against the Draining auto-Stop",
    );

    // Tear down cleanly.
    env.trigger_stopping().await;
    let _ = tokio::time::timeout(Duration::from_secs(5), run_handle).await;
}

// -----------------------------------------------------------------------
// Test 4: Claim failure (409) rolls back budget
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn claim_failure_rolls_back_budget() {
    // Budget for exactly 1 job (2 vcpu, 4096 MB matches the test profile).
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // First job: claim returns None (409 conflict)
    let run_id_1 = RunId::new_v4();
    push_job(&env, run_id_1, "vm0/default", None);

    // Returning to discovery proves the failed claim was processed.
    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, run_id_1, Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 0);

    // Second job: claim succeeds — budget should have been freed.
    let run_id_2 = RunId::new_v4();
    push_job(
        &env,
        run_id_2,
        "vm0/default",
        Some(minimal_context(run_id_2)),
    );

    let completion = env
        .handle
        .wait_completion(run_id_2, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "second job should complete (budget freed after first 409)"
    );

    shutdown(&env, run_handle).await;
}

#[tokio::test(start_paused = true)]
async fn claim_run_id_mismatch_rolls_back_local_state() {
    // Budget for exactly 1 job, so a leaked lease would block the follow-up job.
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let candidate_run_id = RunId::new_v4();
    let context_run_id = RunId::new_v4();
    push_job(
        &env,
        candidate_run_id,
        "vm0/default",
        Some(minimal_context(context_run_id)),
    );

    wait_discover_entered(&env, Duration::from_secs(5)).await;
    wait_cancel_token_removed(&env.cancel_tokens, candidate_run_id, Duration::from_secs(5)).await;
    assert_eq!(budget.allocated().2, 0);
    {
        let completions = env.handle.completions.lock().unwrap();
        assert!(
            !completions
                .iter()
                .any(|completion| completion.run_id == candidate_run_id
                    || completion.run_id == context_run_id),
            "mismatched claim should not produce a completion for either run id"
        );
    }

    let followup_run_id = RunId::new_v4();
    push_job(
        &env,
        followup_run_id,
        "vm0/default",
        Some(minimal_context(followup_run_id)),
    );

    let completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "follow-up job should complete after mismatched claim is rejected"
    );

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 5: Shutdown drains running jobs before exiting
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn shutdown_drains_running_jobs() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // Wait for completion before draining.
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some());

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 6: Unknown profile is skipped without affecting subsequent jobs
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn unknown_profile_skipped() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Push a job with a profile that doesn't exist in the profiles map.
    // The main loop should log a warning and continue without claiming.
    let bad_id = RunId::new_v4();
    push_job(
        &env,
        bad_id,
        "vm0/nonexistent",
        Some(minimal_context(bad_id)),
    );

    // The next discover wait proves the bad job was consumed and skipped.
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    // Push a valid job — it should succeed despite the earlier bad one.
    let good_id = RunId::new_v4();
    push_job(&env, good_id, "vm0/default", Some(minimal_context(good_id)));

    let completion = env
        .handle
        .wait_completion(good_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "valid job should complete after unknown profile is skipped"
    );

    // The bad job should never have been claimed (no completion recorded).
    {
        let comps = env.handle.completions.lock().unwrap();
        assert!(
            !comps.iter().any(|c| c.run_id == bad_id),
            "unknown-profile job should not produce a completion"
        );
    }

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 7: Duplicate discovery (same run_id) is deduplicated
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn duplicate_discovery_deduplicated() {
    // Budget for 2 jobs — enough for the duplicate to pass the budget
    // check and reach the cancel_tokens dedup logic.
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        Arc::clone(&gate),
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let budget = Arc::clone(&config.capacity.budget);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // Wait for the original job to be claimed and blocked at the sandbox gate.
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    // Push the same run_id again (simulates duplicate discovery).
    // Budget has room, but cancel_tokens already contains this run_id →
    // the duplicate is rejected and budget is released.
    env.handle
        .discover_tx
        .send(crate::provider::JobCandidate::new(
            run_id,
            "vm0/default".into(),
        ))
        .unwrap();
    wait_discover_entered(&env, Duration::from_secs(5)).await;

    // Wait for the original job to complete.
    gate.notify_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "original job should complete");

    // Only one completion should exist for this run_id.
    {
        let comps = env.handle.completions.lock().unwrap();
        let count = comps.iter().filter(|c| c.run_id == run_id).count();
        assert_eq!(
            count, 1,
            "duplicate discovery should not produce a second completion"
        );
    }
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;

    shutdown(&env, run_handle).await;
}

// -----------------------------------------------------------------------
// Test 8: Two successful jobs in sequence
//
// After the first job completes, discover_fut is recreated
// (Box::pin(provider.discover())). The second job must be discovered,
// claimed, executed, and completed through the recreated future.
// -----------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn two_sequential_jobs_complete() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // First job
    let id1 = RunId::new_v4();
    push_job(&env, id1, "vm0/default", Some(minimal_context(id1)));
    let c1 = env
        .handle
        .wait_completion(id1, Duration::from_secs(5))
        .await;
    assert!(c1.is_some(), "first job should complete");
    assert_eq!(c1.unwrap().exit_code, 0);

    // Second job — exercises the recreated discover_fut path
    let id2 = RunId::new_v4();
    push_job(&env, id2, "vm0/default", Some(minimal_context(id2)));
    let c2 = env
        .handle
        .wait_completion(id2, Duration::from_secs(5))
        .await;
    assert!(
        c2.is_some(),
        "second job should complete via recreated discover_fut"
    );
    assert_eq!(c2.unwrap().exit_code, 0);

    shutdown(&env, run_handle).await;
}
