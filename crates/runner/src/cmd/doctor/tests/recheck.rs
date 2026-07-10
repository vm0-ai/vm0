use super::super::*;
use super::support::{empty_discovered, live_runner_instance, phase_started_at_ago};

fn write_status_json(path: &std::path::Path, contents: &str) {
    std::fs::write(path, contents).unwrap();
}

fn empty_fresh() -> process::DiscoveredProcesses {
    process::DiscoveredProcesses {
        firecrackers: vec![],
        mitmdumps: vec![],
        dnsmasqs: vec![],
    }
}

fn fresh_with_firecracker(
    pid: u32,
    sandbox_id: &str,
    base_dir: &Path,
) -> process::DiscoveredProcesses {
    process::DiscoveredProcesses {
        firecrackers: vec![process::FirecrackerProcessInfo {
            pid,
            ppid: None,
            sandbox_id: sandbox_id.into(),
            base_dir: Some(base_dir.to_path_buf()),
            identity: None,
        }],
        mitmdumps: vec![],
        dnsmasqs: vec![],
    }
}

#[tokio::test]
async fn no_firecracker_for_run_resolves_when_run_removed_even_if_sandbox_reused() {
    // Regression: a NoFirecrackerForRun warning for run R1 should clear
    // once R1 is no longer in active_runs, even if R1's sandbox_id got
    // reused by another active run R2. Keying on sandbox_id instead of
    // run_id would wrongly keep R1's warning.
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    write_status_json(
        &base_dir.join("status.json"),
        r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [
                {"run_id": "R2", "sandbox_id": "S1"}
            ],
            "started_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z"
        }"#,
    );

    let warning = Warning::NoFirecrackerForRun {
        run_id: "R1".into(),
        sandbox_id: "S1".into(),
        base_dir: base_dir.clone(),
    };
    assert!(
        !warning.persists(&empty_fresh(), &[]).await,
        "warning about R1 must clear after R1 leaves active_runs even though S1 is reused"
    );
}

#[tokio::test]
async fn no_firecracker_for_run_persists_while_run_still_active() {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    write_status_json(
        &base_dir.join("status.json"),
        r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [
                {"run_id": "R1", "sandbox_id": "S1"}
            ],
            "started_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z"
        }"#,
    );

    let warning = Warning::NoFirecrackerForRun {
        run_id: "R1".into(),
        sandbox_id: "S1".into(),
        base_dir: base_dir.clone(),
    };
    // R1 is still active and there's no FC in fresh. Warning persists.
    assert!(warning.persists(&empty_fresh(), &[]).await);
}

#[tokio::test]
async fn no_firecracker_for_run_clears_for_preparing_run_within_grace() {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    let phase_started_at = phase_started_at_ago(Duration::from_secs(10));
    write_status_json(
        &base_dir.join("status.json"),
        &format!(
            r#"{{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [
                    {{
                        "run_id": "R1",
                        "sandbox_id": "S1",
                        "phase": "preparing",
                        "phase_started_at": "{phase_started_at}"
                    }}
                ],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }}"#
        ),
    );

    let warning = Warning::NoFirecrackerForRun {
        run_id: "R1".into(),
        sandbox_id: "S1".into(),
        base_dir: base_dir.clone(),
    };
    assert!(!warning.persists(&empty_fresh(), &[]).await);
}

#[tokio::test]
async fn no_firecracker_for_run_clears_for_stale_preparing_run() {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    let phase_started_at =
        phase_started_at_ago(PREPARING_NO_PROCESS_GRACE + Duration::from_secs(1));
    write_status_json(
        &base_dir.join("status.json"),
        &format!(
            r#"{{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [
                    {{
                        "run_id": "R1",
                        "sandbox_id": "S1",
                        "phase": "preparing",
                        "phase_started_at": "{phase_started_at}"
                    }}
                ],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }}"#
        ),
    );

    let warning = Warning::NoFirecrackerForRun {
        run_id: "R1".into(),
        sandbox_id: "S1".into(),
        base_dir: base_dir.clone(),
    };
    assert!(!warning.persists(&empty_fresh(), &[]).await);
}

#[tokio::test]
async fn stale_preparing_run_persists_while_run_remains_stale_preparing() {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    let phase_started_at =
        phase_started_at_ago(PREPARING_NO_PROCESS_GRACE + Duration::from_secs(1));
    write_status_json(
        &base_dir.join("status.json"),
        &format!(
            r#"{{
                "mode": "running",
                "max_concurrent": 4,
                "active_runs": [
                    {{
                        "run_id": "R1",
                        "sandbox_id": "S1",
                        "phase": "preparing",
                        "phase_started_at": "{phase_started_at}"
                    }}
                ],
                "started_at": "2026-01-01T00:00:00.000Z",
                "updated_at": "2026-01-01T00:00:00.000Z"
            }}"#
        ),
    );

    let warning = Warning::StalePreparingRun {
        run_id: "R1".into(),
        sandbox_id: "S1".into(),
        base_dir: base_dir.clone(),
    };
    assert!(warning.persists(&empty_fresh(), &[]).await);
}

#[tokio::test]
async fn stale_preparing_run_clears_after_phase_changes_to_running_with_firecracker() {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    write_status_json(
        &base_dir.join("status.json"),
        r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [
                {
                    "run_id": "R1",
                    "sandbox_id": "S1",
                    "phase": "running",
                    "phase_started_at": "2026-01-01T00:00:00.000Z"
                }
            ],
            "started_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z"
        }"#,
    );

    let warning = Warning::StalePreparingRun {
        run_id: "R1".into(),
        sandbox_id: "S1".into(),
        base_dir: base_dir.clone(),
    };
    assert!(
        !warning
            .persists(&fresh_with_firecracker(123, "S1", &base_dir), &[])
            .await
    );
}

#[tokio::test]
async fn stale_preparing_run_persists_after_phase_changes_to_running_without_firecracker() {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    write_status_json(
        &base_dir.join("status.json"),
        r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [
                {
                    "run_id": "R1",
                    "sandbox_id": "S1",
                    "phase": "running",
                    "phase_started_at": "2026-01-01T00:00:00.000Z"
                }
            ],
            "started_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z"
        }"#,
    );

    let warning = Warning::StalePreparingRun {
        run_id: "R1".into(),
        sandbox_id: "S1".into(),
        base_dir: base_dir.clone(),
    };
    assert!(warning.persists(&empty_fresh(), &[]).await);
}

#[tokio::test]
async fn no_firecracker_for_run_clears_when_same_run_points_to_new_sandbox() {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    write_status_json(
        &base_dir.join("status.json"),
        r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [
                {"run_id": "R1", "sandbox_id": "S2"}
            ],
            "started_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z"
        }"#,
    );

    let warning = Warning::NoFirecrackerForRun {
        run_id: "R1".into(),
        sandbox_id: "S1".into(),
        base_dir: base_dir.clone(),
    };
    assert!(!warning.persists(&empty_fresh(), &[]).await);
}

#[tokio::test]
async fn firecracker_not_in_status_clears_when_sandbox_becomes_idle() {
    // A FirecrackerNotInStatus warning must clear once its sandbox_id
    // shows up in idle_vms (the VM was parked between scans).
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    write_status_json(
        &base_dir.join("status.json"),
        r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [],
            "idle_vms": [
                {"session_id": "sess-1", "sandbox_id": "S1"}
            ],
            "started_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z"
        }"#,
    );

    // Use our own PID (which certainly exists) so the pid_exists check
    // doesn't short-circuit.
    let live_pid = std::process::id();
    let warning = Warning::FirecrackerNotInStatus {
        pid: live_pid,
        sandbox_id: "S1".into(),
        base_dir: base_dir.clone(),
    };
    assert!(
        !warning.persists(&empty_fresh(), &[]).await,
        "warning must clear once the sandbox is tracked as idle"
    );
}

#[tokio::test]
async fn firecracker_not_in_status_clears_when_sandbox_becomes_active() {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    write_status_json(
        &base_dir.join("status.json"),
        r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [
                {"run_id": "R1", "sandbox_id": "S1"}
            ],
            "started_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z"
        }"#,
    );

    let live_pid = std::process::id();
    let warning = Warning::FirecrackerNotInStatus {
        pid: live_pid,
        sandbox_id: "S1".into(),
        base_dir: base_dir.clone(),
    };
    assert!(!warning.persists(&empty_fresh(), &[]).await);
}

#[tokio::test]
async fn firecracker_not_in_status_persists_when_still_orphan() {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    write_status_json(
        &base_dir.join("status.json"),
        r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [],
            "started_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z"
        }"#,
    );

    let live_pid = std::process::id();
    let warning = Warning::FirecrackerNotInStatus {
        pid: live_pid,
        sandbox_id: "S-ghost".into(),
        base_dir: base_dir.clone(),
    };
    assert!(warning.persists(&empty_fresh(), &[]).await);
}

#[tokio::test]
async fn firecracker_not_in_status_clears_when_pid_gone() {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().to_path_buf();
    // status.json doesn't matter — pid check short-circuits.
    let warning = Warning::FirecrackerNotInStatus {
        pid: u32::MAX, // never a valid pid
        sandbox_id: "S-anything".into(),
        base_dir,
    };
    assert!(!warning.persists(&empty_fresh(), &[]).await);
}

#[tokio::test]
async fn orphan_mitmdump_clears_when_parent_runner_pid_appears() {
    struct ChildGuard(std::process::Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let child = ChildGuard(
        std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap(),
    );
    let warning = Warning::OrphanMitmdump {
        pid: child.0.id(),
        port: 32821,
        ppid: Some(std::process::id()),
    };

    assert!(warning.persists(&empty_fresh(), &[]).await);
    assert!(
        !warning
            .persists(&empty_fresh(), &[std::process::id()])
            .await
    );
}

#[tokio::test]
async fn recheck_clears_runner_warnings_when_registry_entry_disappears() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("vm0-runner"));
    let base_dir = dir.path().join("runner");
    let runner = live_runner_instance(
        std::process::id(),
        dir.path().join("runner.yaml"),
        base_dir.clone(),
    );
    let mut reports = vec![RunnerReport {
        live_runner: runner.clone(),
        service_type: ServiceType::Bare,
        status: None,
        api_ok: None,
        proxy_pid: None,
        dns_pid: None,
        jobs: vec![],
        warnings: vec![Warning::NoMitmproxy {
            port: 32821,
            base_dir,
        }],
    }];

    recheck_per_runner_warnings(&home, &empty_discovered(), &mut reports)
        .await
        .unwrap();

    assert!(reports[0].warnings.is_empty());
}

#[tokio::test]
async fn recheck_keeps_runner_warnings_while_registry_entry_is_current() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("vm0-runner"));
    let base_dir = dir.path().join("runner");
    std::fs::create_dir_all(&base_dir).unwrap();
    std::fs::write(
        base_dir.join("status.json"),
        r#"{
            "mode": "running",
            "active_runs": [],
            "started_at": "2026-01-01T00:00:00.000Z",
            "proxy_port": 32821
        }"#,
    )
    .unwrap();
    let _handle = crate::live_runner_instances::publish(
        &home,
        crate::live_runner_instances::LiveRunnerInstanceMetadata {
            config_path: dir.path().join("runner.yaml"),
            base_dir: base_dir.clone(),
            runner_name: "test-runner".into(),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
        },
    )
    .await
    .unwrap();
    let runner = crate::live_runner_instances::try_list(&home)
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let mut reports = vec![RunnerReport {
        live_runner: runner.clone(),
        service_type: ServiceType::Bare,
        status: None,
        api_ok: None,
        proxy_pid: None,
        dns_pid: None,
        jobs: vec![],
        warnings: vec![Warning::NoMitmproxy {
            port: 32821,
            base_dir,
        }],
    }];

    recheck_per_runner_warnings(&home, &empty_discovered(), &mut reports)
        .await
        .unwrap();

    assert_eq!(reports[0].warnings.len(), 1);
}

#[tokio::test]
async fn recheck_fails_when_live_registry_entry_becomes_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("vm0-runner"));
    let base_dir = dir.path().join("runner");
    let _handle = crate::live_runner_instances::publish(
        &home,
        crate::live_runner_instances::LiveRunnerInstanceMetadata {
            config_path: dir.path().join("runner.yaml"),
            base_dir: base_dir.clone(),
            runner_name: "test-runner".into(),
            runner_group: "vm0/test".into(),
            subcommand: "start".into(),
        },
    )
    .await
    .unwrap();
    let runner = crate::live_runner_instances::try_list(&home)
        .await
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    crate::state_file::write_private_atomic(
        &home.live_runner_instance_record_path(runner.pid, runner.starttime),
        b"{",
    )
    .await
    .unwrap();
    let mut reports = vec![RunnerReport {
        live_runner: runner.clone(),
        service_type: ServiceType::Bare,
        status: None,
        api_ok: None,
        proxy_pid: None,
        dns_pid: None,
        jobs: vec![],
        warnings: vec![Warning::NoMitmproxy {
            port: 32821,
            base_dir,
        }],
    }];

    let error = match recheck_per_runner_warnings(&home, &empty_discovered(), &mut reports).await {
        Ok(_) => panic!("expected invalid live registry entry to fail"),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("live process identity"),
        "{error}"
    );
}
