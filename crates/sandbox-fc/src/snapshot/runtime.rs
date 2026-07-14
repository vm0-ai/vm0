use std::future::Future;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::task::JoinHandle;
use tracing::info;
use vsock_proto::ExecTermination;

use crate::api::ApiClient;
use crate::config::SnapshotConfig;
use crate::exec_operation_result::{captured_exec_output_bytes, reject_stream_overflow};
use crate::factory::InvariantConfig;
use crate::paths::{SandboxPaths, SnapshotOutputPaths, SockPaths};
use crate::runtime_dirs::{prepare_runtime_socket_dir, set_private_runtime_socket_mode};
use sandbox::SnapshotCreateConfig;

use super::SnapshotError;
use super::attempt::SnapshotAttempt;

const API_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for waiting for the guest to connect via vsock after start.
const VSOCK_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Pre-warm should be quiet; keep diagnostics bounded and explicit.
const PREWARM_EXEC_CAPTURE_LIMIT_BYTES: u32 = 64 * 1024;

struct AbortOnDropTask<T> {
    handle: JoinHandle<T>,
}

impl<T> AbortOnDropTask<T> {
    fn new(handle: JoinHandle<T>) -> Self {
        Self { handle }
    }

    fn abort(&self) {
        self.handle.abort();
    }
}

impl<T> Future for AbortOnDropTask<T> {
    type Output = Result<T, tokio::task::JoinError>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        Pin::new(&mut this.handle).poll(cx)
    }
}

impl<T> Drop for AbortOnDropTask<T> {
    fn drop(&mut self) {
        if !self.handle.is_finished() {
            self.handle.abort();
        }
    }
}

pub(super) async fn run_snapshot_workflow(
    config: &SnapshotCreateConfig,
    attempt: &mut SnapshotAttempt,
) -> Result<SnapshotConfig, SnapshotError> {
    attempt.prepare_firecracker_files(config).await?;
    attempt.acquire_network().await?;
    attempt.spawn_firecracker(config).await?;

    // Guard: ensure Firecracker and netns cleanup on any explicit exit path.
    let result = run_with_firecracker(
        config,
        attempt.paths(),
        attempt.sock_paths()?,
        attempt.output(),
    )
    .await;
    attempt.finish_runtime_after_workflow(result).await
}

/// Inner workflow that runs while Firecracker is alive.
async fn run_with_firecracker(
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
    sock_paths: &SockPaths,
    output: &SnapshotOutputPaths,
) -> Result<SnapshotConfig, SnapshotError> {
    // 5. Wait for API socket ready.
    let api_sock = sock_paths.api_sock();
    let client = ApiClient::new(&api_sock)?;
    client.wait_for_ready(API_READY_TIMEOUT).await?;
    set_private_runtime_socket_mode(&api_sock)?;

    info!("firecracker API ready");

    let inv = InvariantConfig::new();
    let vsock_uds_str = configure_snapshot_vm(&client, config, paths, sock_paths, &inv).await?;

    info!("VM configured");

    // 7. Bind vsock listener BEFORE starting the instance (race: guest connects ~300ms after boot).
    let vsock_path_for_listen = vsock_uds_str.clone();
    let vsock_task = AbortOnDropTask::new(tokio::spawn(async move {
        vsock_host::VsockHost::wait_for_connection(&vsock_path_for_listen, VSOCK_CONNECT_TIMEOUT)
            .await
    }));

    // 8. Start instance.
    let start_result = client.start_instance().await;
    if let Err(e) = start_result {
        vsock_task.abort();
        let _ = vsock_task.await;
        return Err(e.into());
    }

    info!("instance started, waiting for guest vsock connection");

    // 9. Wait for guest to connect via vsock.
    let guest = match vsock_task.await {
        Ok(Ok(g)) => g,
        Ok(Err(e)) => return Err(SnapshotError::Vsock(e.to_string())),
        Err(e) => return Err(SnapshotError::Vsock(format!("vsock task: {e}"))),
    };

    info!("guest connected");

    // 9.5. Pre-warm caches (PAM/nsswitch, CLI modules) so post-restore calls
    //      are fast. The snapshot captures memory + disk state, so caches
    //      populated here persist across restores.
    let prewarm_result = guest
        .exec_operation_capture(vsock_host::ExecCaptureRequest {
            command: inv.prewarm_script,
            timeout_ms: 30_000,
            env: &[],
            sudo: false,
            label: "snapshot-prewarm",
            stdout_limit_bytes: PREWARM_EXEC_CAPTURE_LIMIT_BYTES,
            stderr_limit_bytes: PREWARM_EXEC_CAPTURE_LIMIT_BYTES,
            expected_exit_codes: &[],
            stdin_bytes: None,
            wait_timeout: Duration::from_millis(35_000),
        })
        .await
        .map_err(|e| SnapshotError::Setup(format!("pre-warm exec: {e}")))?;
    validate_prewarm_exec_result(prewarm_result)?;
    info!("pre-warm complete");

    // 10. Pause VM.
    client.pause().await?;

    info!("VM paused");

    // 11. Create snapshot — Firecracker writes directly to output_dir.
    //
    // File content durability is guaranteed upstream: as of Firecracker
    // v1.15.1 (see `FIRECRACKER_VERSION` in `runner/src/deps.rs`), both
    // snapshot.bin and memory.bin are flushed and fsynced before the API
    // response returns. References (pinned to the v1.15.1 tag):
    //   - `snapshot_state_to_file` — https://github.com/firecracker-microvm/firecracker/blob/v1.15.1/src/vmm/src/persist.rs
    //   - `snapshot_memory_to_file` — https://github.com/firecracker-microvm/firecracker/blob/v1.15.1/src/vmm/src/vstate/vm.rs
    // Re-verify this guarantee whenever `FIRECRACKER_VERSION` is bumped;
    // if it ever regresses, add a host-side `sync_all` on both files here.
    // Directory-entry durability (persisting the `name → inode` mapping)
    // is handled separately; see #9825.
    let snapshot_str = output.snapshot().display().to_string();
    let memory_str = output.memory().display().to_string();
    client.create_snapshot(&snapshot_str, &memory_str).await?;

    info!("snapshot created");

    info!(output_dir = %config.output_dir.display(), "snapshot creation complete");

    Ok(output.snapshot_config(&config.id))
}

fn validate_prewarm_exec_result(
    result: vsock_host::ExecOperationResult,
) -> Result<(), SnapshotError> {
    let (termination, stderr, diagnostic) = prewarm_exec_result_parts(result)
        .map_err(|e| SnapshotError::Setup(format!("pre-warm exec: {e}")))?;
    let stderr = String::from_utf8_lossy(&stderr);
    let stderr = stderr.trim();

    match termination {
        ExecTermination::Exited { exit_code: 0 } => Ok(()),
        ExecTermination::Exited { exit_code } => Err(SnapshotError::Setup(format!(
            "pre-warm failed (exit code {exit_code}): {stderr}",
        ))),
        termination => {
            let detail = prewarm_failure_detail(stderr, &diagnostic);
            if detail.is_empty() {
                Err(SnapshotError::Setup(format!(
                    "pre-warm failed (termination {termination:?})"
                )))
            } else {
                Err(SnapshotError::Setup(format!(
                    "pre-warm failed (termination {termination:?}): {detail}"
                )))
            }
        }
    }
}

fn prewarm_exec_result_parts(
    result: vsock_host::ExecOperationResult,
) -> io::Result<(ExecTermination, Vec<u8>, String)> {
    reject_stream_overflow(&result)?;

    let vsock_host::ExecOperationResult {
        termination,
        stdout,
        stderr,
        diagnostic,
        ..
    } = result;

    let _ = captured_exec_output_bytes("stdout", stdout)?;
    let (stderr, _) = captured_exec_output_bytes("stderr", stderr)?;
    Ok((termination, stderr, diagnostic))
}

fn prewarm_failure_detail(stderr: &str, diagnostic: &str) -> String {
    let diagnostic = diagnostic.trim();
    match (stderr.is_empty(), diagnostic.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stderr.to_string(),
        (true, false) => diagnostic.to_string(),
        (false, false) => format!("{stderr}; diagnostic: {diagnostic}"),
    }
}

async fn configure_snapshot_vm(
    client: &ApiClient,
    config: &SnapshotCreateConfig,
    paths: &SandboxPaths,
    sock_paths: &SockPaths,
    inv: &InvariantConfig,
) -> Result<String, SnapshotError> {
    // The COW-device bind mount was established inside `unshare --mount`
    // at spawn time; `configure_drive` only needs the path string FC will
    // open inside its private mount namespace.
    let drive_bind_str = paths.cow_device_bind().display().to_string();
    let workspace_drive_bind_str = paths.workspace_device_bind().display().to_string();

    // 6. Configure VM via API. Keep drive requests ordered so snapshot creation
    // matches the fresh-boot config path: rootfs first, workspace second.
    let kernel_path = config.kernel_path.display().to_string();
    prepare_runtime_socket_dir(sock_paths)?;
    let vsock_uds_str = sock_paths.vsock().display().to_string();

    client
        .configure_drive("rootfs", &drive_bind_str, true, false, None)
        .await?;
    client
        .configure_drive("workspace", &workspace_drive_bind_str, false, false, None)
        .await?;

    tokio::try_join!(
        client.configure_machine(config.vcpu_count, config.memory_mb),
        client.configure_boot_source(&kernel_path, &inv.boot_args),
        client.configure_network_interface(inv.iface_id, inv.guest_mac, inv.tap_name, None, None),
        client.configure_vsock(inv.guest_cid, &vsock_uds_str),
        client.configure_balloon(
            inv.balloon.amount_mib,
            inv.balloon.deflate_on_oom,
            inv.balloon.stats_polling_interval_s
        ),
    )?;

    Ok(vsock_uds_str)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use crate::api::test_support::{MOCK_REQUEST_READ_TIMEOUT, MockFirecrackerApi, MockResponse};
    use crate::snapshot::SnapshotError;

    use super::*;

    fn snapshot_create_config(output_dir: PathBuf) -> SnapshotCreateConfig {
        SnapshotCreateConfig {
            id: "snapshot-test".into(),
            binary_path: PathBuf::from("/tmp/firecracker"),
            kernel_path: PathBuf::from("/tmp/vmlinux"),
            rootfs_path: PathBuf::from("/tmp/rootfs.ext4"),
            output_dir,
            vcpu_count: 2,
            memory_mb: 512,
            workspace_disk_mb: 1024,
        }
    }

    fn prewarm_result(
        termination: ExecTermination,
        stderr: Vec<u8>,
        diagnostic: &str,
    ) -> vsock_host::ExecOperationResult {
        vsock_host::ExecOperationResult {
            termination,
            duration_ms: 10,
            stdout: vsock_host::ExecOwnedCapturedOutput::Captured {
                bytes: Vec::new(),
                truncated: false,
            },
            stderr: vsock_host::ExecOwnedCapturedOutput::Captured {
                bytes: stderr,
                truncated: false,
            },
            diagnostic: diagnostic.to_string(),
            stream_overflowed: false,
        }
    }

    fn expect_prewarm_setup_error(result: Result<(), SnapshotError>) -> String {
        match result {
            Ok(()) => panic!("expected prewarm setup error"),
            Err(SnapshotError::Setup(message)) => message,
            Err(other) => panic!("expected prewarm setup error, got {other:?}"),
        }
    }

    #[test]
    fn prewarm_exec_result_accepts_exited_zero() {
        validate_prewarm_exec_result(prewarm_result(
            ExecTermination::Exited { exit_code: 0 },
            Vec::new(),
            "",
        ))
        .expect("zero exit should succeed");
    }

    #[test]
    fn prewarm_exec_result_preserves_nonzero_exit_wording() {
        let message = expect_prewarm_setup_error(validate_prewarm_exec_result(prewarm_result(
            ExecTermination::Exited { exit_code: 7 },
            b"prewarm failed\n".to_vec(),
            "ignored",
        )));

        assert_eq!(message, "pre-warm failed (exit code 7): prewarm failed");
    }

    #[test]
    fn prewarm_exec_result_reports_structured_terminal_states() {
        for (termination, diagnostic, expected) in [
            (ExecTermination::TimedOut, "", "TimedOut"),
            (ExecTermination::Cancelled, "cancelled by host", "Cancelled"),
            (ExecTermination::StartFailed, "spawn failed", "StartFailed"),
            (ExecTermination::WaitFailed, "wait failed", "WaitFailed"),
        ] {
            let message = expect_prewarm_setup_error(validate_prewarm_exec_result(prewarm_result(
                termination,
                b"stderr clue".to_vec(),
                diagnostic,
            )));

            assert!(message.contains(expected), "got: {message}");
            assert!(message.contains("stderr clue"), "got: {message}");
            if !diagnostic.is_empty() {
                assert!(message.contains(diagnostic), "got: {message}");
            }
        }
    }

    #[test]
    fn prewarm_exec_result_reports_terminal_state_without_detail() {
        let message = expect_prewarm_setup_error(validate_prewarm_exec_result(prewarm_result(
            ExecTermination::TimedOut,
            Vec::new(),
            "",
        )));

        assert_eq!(message, "pre-warm failed (termination TimedOut)");
    }

    #[test]
    fn prewarm_exec_result_reports_terminal_state_with_diagnostic_only() {
        let message = expect_prewarm_setup_error(validate_prewarm_exec_result(prewarm_result(
            ExecTermination::StartFailed,
            Vec::new(),
            "spawn failed",
        )));

        assert_eq!(
            message,
            "pre-warm failed (termination StartFailed): spawn failed"
        );
    }

    #[test]
    fn prewarm_exec_result_rejects_invalid_capture_state() {
        let overflow = expect_prewarm_setup_error(validate_prewarm_exec_result(
            vsock_host::ExecOperationResult {
                stream_overflowed: true,
                ..prewarm_result(ExecTermination::Exited { exit_code: 0 }, Vec::new(), "")
            },
        ));
        assert!(overflow.contains("pre-warm exec"), "got: {overflow}");
        assert!(
            overflow.contains("overflowed a stream queue"),
            "got: {overflow}"
        );

        let stdout_discarded = expect_prewarm_setup_error(validate_prewarm_exec_result(
            vsock_host::ExecOperationResult {
                stdout: vsock_host::ExecOwnedCapturedOutput::Discarded,
                ..prewarm_result(ExecTermination::Exited { exit_code: 0 }, Vec::new(), "")
            },
        ));
        assert!(
            stdout_discarded.contains("discarded stdout"),
            "got: {stdout_discarded}"
        );

        let stderr_discarded = expect_prewarm_setup_error(validate_prewarm_exec_result(
            vsock_host::ExecOperationResult {
                stderr: vsock_host::ExecOwnedCapturedOutput::Discarded,
                ..prewarm_result(ExecTermination::Exited { exit_code: 0 }, Vec::new(), "")
            },
        ));
        assert!(
            stderr_discarded.contains("discarded stderr"),
            "got: {stderr_discarded}"
        );
    }

    #[tokio::test]
    async fn configure_snapshot_vm_orders_rootfs_before_workspace_drive() {
        let mut api = MockFirecrackerApi::repeating(MockResponse::no_content());
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = SandboxPaths::new(dir.path().join("work"));
        let sock_paths = SockPaths::new(dir.path().join("sock"));
        let client = ApiClient::new(api.socket_path()).unwrap();
        let config = snapshot_create_config(dir.path().join("snapshot-output"));
        let inv = InvariantConfig::new();

        tokio::time::timeout(
            MOCK_REQUEST_READ_TIMEOUT,
            configure_snapshot_vm(&client, &config, &paths, &sock_paths, &inv),
        )
        .await
        .expect("snapshot VM configuration should finish")
        .expect("snapshot VM configuration should succeed");

        let mut requests = Vec::new();
        for _ in 0..7 {
            requests.push(api.next_request().await);
        }

        assert_eq!(requests[0].method, "PUT");
        assert_eq!(requests[0].path, "/drives/rootfs");
        assert_eq!(requests[1].method, "PUT");
        assert_eq!(requests[1].path, "/drives/workspace");

        let mut paths: Vec<&str> = requests
            .iter()
            .map(|request| request.path.as_str())
            .collect();
        paths.sort_unstable();
        assert_eq!(
            paths,
            [
                "/balloon",
                "/boot-source",
                "/drives/rootfs",
                "/drives/workspace",
                "/machine-config",
                "/network-interfaces/eth0",
                "/vsock",
            ]
        );
    }

    #[tokio::test]
    async fn abort_on_drop_task_aborts_vsock_listener() {
        let dir = tempfile::tempdir().expect("tempdir");
        let base = dir.path().join("snapshot-vsock");
        let listener =
            std::path::PathBuf::from(format!("{}_{}", base.display(), vsock_proto::VSOCK_PORT));
        let base = base.display().to_string();

        let task = AbortOnDropTask::new(tokio::spawn(async move {
            vsock_host::VsockHost::wait_for_connection(&base, Duration::from_secs(30)).await
        }));

        tokio::time::timeout(Duration::from_secs(1), async {
            while !listener.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("vsock listener should bind");

        drop(task);

        tokio::time::timeout(Duration::from_secs(1), async {
            while listener.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("dropped task should abort and remove vsock listener");
    }

    #[tokio::test]
    async fn abort_on_drop_task_explicit_abort_removes_vsock_listener() {
        let dir = tempfile::tempdir().expect("tempdir");
        let base = dir.path().join("snapshot-vsock-explicit-abort");
        let listener =
            std::path::PathBuf::from(format!("{}_{}", base.display(), vsock_proto::VSOCK_PORT));
        let base = base.display().to_string();

        let task = AbortOnDropTask::new(tokio::spawn(async move {
            vsock_host::VsockHost::wait_for_connection(&base, Duration::from_secs(30)).await
        }));

        tokio::time::timeout(Duration::from_secs(1), async {
            while !listener.exists() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("vsock listener should bind");

        task.abort();
        let join = task.await;
        assert!(
            join.is_err_and(|e| e.is_cancelled()),
            "explicit abort should cancel the listener task"
        );

        assert!(
            !listener.exists(),
            "explicit abort should remove the vsock listener socket"
        );
    }
}
