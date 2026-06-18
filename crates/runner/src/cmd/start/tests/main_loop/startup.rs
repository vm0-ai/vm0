use super::super::super::*;
use super::super::support::{
    mock_run_config_with_runtime, shutdown, test_profiles, wait_status_mode,
};
use crate::provider::{ClaimedJob, CompletionAuth, JobCandidate};
use crate::types::{HeartbeatState, HeldSessionState, SandboxReuseResult};
use async_trait::async_trait;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

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
