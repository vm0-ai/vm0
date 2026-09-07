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
            path: sandbox.sock_paths.ssh_rpc(),
            observed: false,
        };
        let error = sandbox
            .start_with_observer(&mut observer)
            .await
            .unwrap_err();
        // Fail at the real backend prerequisite, after the SSH bind succeeded.
        assert!(error.to_string().contains(if restore {
            "workspace drive"
        } else {
            "COW device"
        }));
        assert!(observer.observed);
        assert!(!observer.path.exists());
        assert!(sandbox.ssh_rpc("run-a").is_none());
    }
}

#[tokio::test]
async fn sandbox_stop_kill_and_drop_remove_the_owned_endpoint() {
    for operation in ["stop", "kill", "drop"] {
        let dir = tempfile::tempdir().unwrap();
        let mut sandbox = test_sandbox_with_state(SandboxState::Running);
        prepare_socket_paths(&mut sandbox, dir.path());
        sandbox.park_coordinator.bind_run_control("run-a").unwrap();
        sandbox.ssh_endpoint = Some(sandbox.bind_ssh_endpoint().unwrap());
        let path = sandbox.sock_paths.ssh_rpc();
        let stale = sandbox.ssh_rpc("run-a").unwrap();
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
async fn sandbox_park_and_final_exec_park_cannot_cross_an_accepted_ssh_request() {
    for final_exec in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut sandbox = test_sandbox_with_state(SandboxState::Running);
        prepare_socket_paths(&mut sandbox, dir.path());
        let (guest, _peer) = connected_mock_guest().await;
        sandbox.guest = guest;
        sandbox.park_coordinator.bind_run_control("run-a").unwrap();
        sandbox.ssh_endpoint = Some(sandbox.bind_ssh_endpoint().unwrap());
        let _ssh_peer = UnixStream::connect(sandbox.sock_paths.ssh_rpc())
            .await
            .unwrap();
        let accepted = sandbox.ssh_rpc("run-a").unwrap().accept().await.unwrap();
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
                    "ssh-fence-test",
                )
                .await
                .map(drop)
        } else {
            sandbox.park().await.map(drop)
        };
        assert!(result.is_err());
        assert_eq!(sandbox.park_coordinator.state(), CoordinatorState::Open);
        assert!(sandbox.sock_paths.ssh_rpc().exists());
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
