use super::*;
use std::path::PathBuf;

pub(super) fn prepare_socket_paths(sandbox: &mut FirecrackerSandbox, dir: &Path) {
    sandbox.sock_paths = SockPaths::new(dir.to_path_buf());
    std::fs::create_dir_all(sandbox.sock_paths.vsock_dir()).unwrap();
    std::fs::set_permissions(
        sandbox.sock_paths.vsock_dir(),
        std::fs::Permissions::from_mode(0o700),
    )
    .unwrap();
}

struct BindObserver {
    path: PathBuf,
    observed: bool,
}

impl SandboxStartObserver for BindObserver {
    fn record_stage(&mut self, stage: SandboxStartStage, _duration: Duration, success: bool) {
        if stage == SandboxStartStage::BackendLaunch {
            assert!(!success);
            assert_eq!(
                std::fs::metadata(&self.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            self.observed = true;
        }
    }
}

#[tokio::test]
async fn fresh_and_restore_entrypoints_bind_before_backend_launch_and_clean_up_on_failure() {
    for restore in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut sandbox = test_sandbox_with_state(SandboxState::Created);
        prepare_socket_paths(&mut sandbox, dir.path());
        sandbox.bind_run_control("run-a").unwrap();
        if restore {
            sandbox.factory_config.snapshot = Some(crate::SnapshotConfig {
                snapshot_path: dir.path().join("snapshot.bin"),
                memory_path: dir.path().join("memory.bin"),
                cow_path: dir.path().join("cow.img"),
                drive_bind_path: dir.path().join("drive"),
                workspace_drive_bind_path: dir.path().join("workspace"),
                vsock_bind_dir: dir.path().join("snapshot-vsock"),
            });
        }
        let mut observer = BindObserver {
            path: sandbox.sock_paths.guest_rpc(),
            observed: false,
        };
        let error = sandbox
            .start_with_observer(&mut observer)
            .await
            .unwrap_err();
        // Fail at the real backend prerequisite, after the guest RPC bind succeeded.
        assert!(error.to_string().contains(if restore {
            "workspace drive"
        } else {
            "COW device"
        }));
        assert!(observer.observed);
        assert!(!observer.path.exists());
        assert!(sandbox.guest_rpc("run-a").is_none());
    }
}

#[tokio::test]
async fn sandbox_stop_kill_and_drop_remove_the_owned_endpoint() {
    for operation in ["stop", "kill", "drop"] {
        let dir = tempfile::tempdir().unwrap();
        let mut sandbox = test_sandbox_with_state(SandboxState::Running);
        prepare_socket_paths(&mut sandbox, dir.path());
        sandbox.park_coordinator.bind_run_control("run-a").unwrap();
        sandbox.guest_rpc_endpoint = Some(sandbox.bind_guest_rpc_endpoint().unwrap());
        let path = sandbox.sock_paths.guest_rpc();
        let stale = sandbox.guest_rpc("run-a").unwrap();
        match operation {
            "stop" => sandbox.stop().await.unwrap(),
            "kill" => sandbox.kill().await.unwrap(),
            _ => drop(sandbox),
        }
        assert!(!path.exists());
        assert!(stale.accept().await.is_err());
    }
}

#[tokio::test]
async fn sandbox_park_and_final_exec_park_cannot_cross_an_accepted_guest_rpc_request() {
    for final_exec in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut sandbox = test_sandbox_with_state(SandboxState::Running);
        prepare_socket_paths(&mut sandbox, dir.path());
        let (guest, _peer) = connected_mock_guest().await;
        sandbox.guest = guest;
        sandbox.park_coordinator.bind_run_control("run-a").unwrap();
        sandbox.guest_rpc_endpoint = Some(sandbox.bind_guest_rpc_endpoint().unwrap());
        let _rpc_peer = UnixStream::connect(sandbox.sock_paths.guest_rpc())
            .await
            .unwrap();
        let accepted = sandbox.guest_rpc("run-a").unwrap().accept().await.unwrap();
        let result = if final_exec {
            sandbox
                .final_exec_and_park(
                    &ExecRequest {
                        cmd: "true",
                        timeout: Duration::from_secs(1),
                        env: &[],
                        sudo: false,
                        expected_exit_codes: &[],
                        stdin_bytes: None,
                        output_limits: sandbox::ExecOutputLimits::same(1024),
                    },
                    "rpc-fence-test",
                )
                .await
                .map(drop)
        } else {
            sandbox.park().await.map(drop)
        };
        assert!(result.is_err());
        assert_eq!(sandbox.park_coordinator.state(), CoordinatorState::Open);
        assert!(sandbox.sock_paths.guest_rpc().exists());
        assert!(!accepted.cancelled.is_cancelled());
        drop(accepted);
        drop(
            sandbox
                .guest
                .lock()
                .await
                .as_ref()
                .unwrap()
                .try_fence_normal_operations()
                .unwrap(),
        );
    }
}

async fn running_rpc_sandbox(dir: &Path) -> (FirecrackerSandbox, UnixStream) {
    let mut sandbox = test_sandbox_with_state(SandboxState::Created);
    prepare_socket_paths(&mut sandbox, dir);
    sandbox.config.resources.memory_mb = balloon::MIN_GUEST_MIB;
    sandbox.bind_run_control("run-a").unwrap();
    let (guest, peer) = connected_mock_guest().await;
    sandbox.guest = guest;
    sandbox.publish_state(SandboxState::Running);
    sandbox.guest_rpc_endpoint = Some(sandbox.bind_guest_rpc_endpoint().unwrap());
    (sandbox, peer)
}

async fn acknowledge_lifecycle(peer: &mut UnixStream, request_type: u8, response_type: u8) {
    let request = read_vsock_message(peer).await;
    assert_eq!(request.msg_type, request_type);
    peer.write_all(&vsock_proto::encode(response_type, request.seq, &[]).unwrap())
        .await
        .unwrap();
}

async fn park_rpc_sandbox(sandbox: &mut FirecrackerSandbox, peer: &mut UnixStream) {
    let (result, ()) = tokio::join!(
        sandbox.park(),
        acknowledge_lifecycle(
            peer,
            vsock_proto::MSG_QUIESCE_OPERATIONS,
            vsock_proto::MSG_OPERATIONS_QUIESCED,
        ),
    );
    assert_eq!(result.unwrap(), SandboxParkOutcome::Reusable);
}

#[tokio::test]
async fn successful_park_variants_replace_the_rpc_epoch_before_guest_resume() {
    for (final_exec, handoff) in [(false, false), (true, false), (true, true)] {
        let dir = tempfile::tempdir().unwrap();
        let (mut sandbox, mut peer) = running_rpc_sandbox(dir.path()).await;
        let path = sandbox.sock_paths.guest_rpc();
        let observed_path = path.clone();
        let mut api = MockFirecrackerApi::with_handler(move |request| {
            let path = observed_path.clone();
            async move {
                assert_eq!(request.method, "PATCH");
                assert_eq!(request.path, "/vm");
                // Both the original pause and the subsequent resume must have
                // their own privately bound RPC endpoint before the API call.
                assert_eq!(
                    std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
                MockResponse::no_content()
            }
        });
        std::os::unix::fs::symlink(api.socket_path(), sandbox.sock_paths.api_sock()).unwrap();
        let stale = sandbox.guest_rpc("run-a").unwrap();
        let mut pending = Box::pin(stale.accept());
        assert!(futures_util::poll!(pending.as_mut()).is_pending());
        // Queue a connection without admitting it. It must not survive reuse.
        let _backlog = UnixStream::connect(&path).await.unwrap();
        let park = async {
            if final_exec {
                let request = ExecRequest {
                    cmd: "true",
                    timeout: Duration::from_secs(1),
                    env: &[],
                    sudo: false,
                    expected_exit_codes: &[],
                    stdin_bytes: None,
                    output_limits: sandbox::ExecOutputLimits::same(1024),
                };
                if handoff {
                    let signal = SandboxFinalExecParkHandoff::new();
                    assert!(signal.request());
                    let mut observer = RecordingFinalExecParkObserver::default();
                    let outcome = sandbox
                        .final_exec_and_park_for_handoff(
                            &request,
                            "rpc-epoch",
                            &signal,
                            &mut observer,
                        )
                        .await
                        .unwrap();
                    assert!(matches!(
                        outcome,
                        SandboxFinalExecParkHandoffOutcome::Handoff { .. }
                    ));
                } else {
                    let outcome = sandbox
                        .final_exec_and_park(&request, "rpc-epoch")
                        .await
                        .unwrap();
                    assert_eq!(outcome.park_outcome, SandboxParkOutcome::Reusable);
                }
            } else {
                assert_eq!(sandbox.park().await.unwrap(), SandboxParkOutcome::Reusable);
            }
        };
        let guest = async {
            if final_exec {
                let request = read_vsock_message(&mut peer).await;
                assert_eq!(request.msg_type, vsock_proto::MSG_EXEC_START);
                let output = vsock_proto::ExecCapturedOutput::Captured {
                    bytes: b"",
                    truncated: false,
                };
                let payload = vsock_proto::encode_exec_result(
                    vsock_proto::ExecTermination::Exited { exit_code: 0 },
                    1,
                    output,
                    output,
                    "",
                )
                .unwrap();
                peer.write_all(
                    &vsock_proto::encode(vsock_proto::MSG_EXEC_RESULT, request.seq, &payload)
                        .unwrap(),
                )
                .await
                .unwrap();
            }
            acknowledge_lifecycle(
                &mut peer,
                vsock_proto::MSG_QUIESCE_OPERATIONS,
                vsock_proto::MSG_OPERATIONS_QUIESCED,
            )
            .await;
        };
        tokio::join!(park, guest);
        assert!(!path.exists());
        assert!(sandbox.guest_rpc("run-a").is_none());
        assert!(
            tokio::time::timeout(Duration::from_secs(1), pending)
                .await
                .unwrap()
                .is_err()
        );

        sandbox.bind_run_control("run-b").unwrap();
        let (result, ()) = tokio::join!(
            sandbox.unpark(),
            acknowledge_lifecycle(
                &mut peer,
                vsock_proto::MSG_RESUME_OPERATIONS,
                vsock_proto::MSG_OPERATIONS_RESUMED
            ),
        );
        result.unwrap();
        assert!(stale.accept().await.is_err());
        assert!(sandbox.guest_rpc("run-a").unwrap().accept().await.is_err());
        let mut new_peer = UnixStream::connect(&path).await.unwrap();
        new_peer.write_all(b"new").await.unwrap();
        let mut accepted = sandbox.guest_rpc("run-b").unwrap().accept().await.unwrap();
        let mut bytes = [0; 3];
        tokio::time::timeout(
            Duration::from_secs(1),
            accepted.stream.read_exact(&mut bytes),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(&bytes, b"new");
        assert!(!accepted.cancelled.is_cancelled());
        drop(stale);
        assert!(path.exists());
        let requests = api.drain_requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(mock_request_body_json(&requests[0])["state"], "Paused");
        assert_eq!(mock_request_body_json(&requests[1])["state"], "Resumed");
    }
}

#[tokio::test]
async fn failed_unpark_removes_the_new_rpc_endpoint() {
    for fail_guest_resume in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (mut sandbox, mut peer) = running_rpc_sandbox(dir.path()).await;
        let path = sandbox.sock_paths.guest_rpc();
        let observed_path = path.clone();
        let api = MockFirecrackerApi::with_handler(move |request| {
            let path = observed_path.clone();
            async move {
                assert!(path.exists());
                if mock_request_body_json(&request)["state"] == "Resumed" && !fail_guest_resume {
                    MockResponse::bad_request_fault("resume rejected")
                } else {
                    MockResponse::no_content()
                }
            }
        });
        std::os::unix::fs::symlink(api.socket_path(), sandbox.sock_paths.api_sock()).unwrap();
        park_rpc_sandbox(&mut sandbox, &mut peer).await;
        sandbox.bind_run_control("run-b").unwrap();
        let result = if fail_guest_resume {
            let guest = async move {
                let request = read_vsock_message(&mut peer).await;
                assert_eq!(request.msg_type, vsock_proto::MSG_RESUME_OPERATIONS);
                drop(peer);
            };
            let (result, ()) = tokio::join!(sandbox.unpark(), guest);
            result
        } else {
            sandbox.unpark().await
        };
        assert!(matches!(
            result,
            Err(SandboxError::IdleTransition {
                transition: SandboxIdleTransition::Unpark,
                ..
            })
        ));
        assert!(!path.exists());
        assert!(sandbox.guest_rpc("run-b").is_none());
        assert!(UnixStream::connect(path).await.is_err());
    }
}

#[tokio::test]
async fn cancelling_unpark_cleans_up_its_locally_owned_rpc_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let (mut sandbox, mut peer) = running_rpc_sandbox(dir.path()).await;
    let mut api = MockFirecrackerApi::with_handler(|request| async move {
        if mock_request_body_json(&request)["state"] == "Resumed" {
            std::future::pending::<MockResponse>().await
        } else {
            MockResponse::no_content()
        }
    });
    std::os::unix::fs::symlink(api.socket_path(), sandbox.sock_paths.api_sock()).unwrap();
    park_rpc_sandbox(&mut sandbox, &mut peer).await;
    api.drain_requests();
    sandbox.bind_run_control("run-b").unwrap();
    let path = sandbox.sock_paths.guest_rpc();
    let mut unpark = Box::pin(sandbox.unpark());
    tokio::select! {
        request = api.next_request() => assert_eq!(mock_request_body_json(&request)["state"], "Resumed"),
        result = &mut unpark => panic!("unpark completed before cancellation: {result:?}"),
    }
    assert!(path.exists());
    drop(unpark);
    assert!(!path.exists());
    assert!(sandbox.guest_rpc("run-b").is_none());
    assert!(UnixStream::connect(path).await.is_err());
}
