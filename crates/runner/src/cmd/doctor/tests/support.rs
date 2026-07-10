use super::super::*;

pub(super) struct DoctorReportFixture {
    pub(super) _dir: tempfile::TempDir,
    pub(super) config_path: PathBuf,
    pub(super) base_dir: PathBuf,
}

pub(super) fn doctor_report_fixture(
    mode: &str,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
) -> DoctorReportFixture {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().join("runner");
    std::fs::create_dir_all(&base_dir).unwrap();

    let config_path = dir.path().join("runner.yaml");
    let config = serde_json::json!({
        "name": "test-runner",
        "group": "vm0/test",
        "base_dir": base_dir.display().to_string(),
        "ca_dir": dir.path().join("ca").display().to_string(),
        "firecracker": {
            "binary": dir.path().join("firecracker").display().to_string(),
            "kernel": dir.path().join("vmlinux").display().to_string(),
        },
        "profiles": {
            "vm0/default": {
                "rootfs_hash": "rootfs",
                "snapshot_hash": "snapshot",
                "vcpu": 1,
                "memory_mb": 512,
                "rootfs_disk_mb": 512,
                "workspace_disk_mb": 1024,
            },
        },
    });
    std::fs::write(&config_path, serde_yaml_ng::to_string(&config).unwrap()).unwrap();

    let status = serde_json::json!({
        "mode": mode,
        "started_at": "2026-01-01T00:00:00.000Z",
        "active_runs": [],
        "proxy_port": proxy_port,
        "dns_port": dns_port,
    });
    std::fs::write(base_dir.join("status.json"), status.to_string()).unwrap();

    DoctorReportFixture {
        _dir: dir,
        config_path,
        base_dir,
    }
}

pub(super) fn live_runner_instance(
    pid: u32,
    config_path: PathBuf,
    base_dir: PathBuf,
) -> LiveRunnerInstance {
    LiveRunnerInstance {
        pid,
        starttime: 0,
        config_path,
        base_dir,
        runner_name: "test-runner".into(),
        runner_group: "vm0/test".into(),
        subcommand: "start".into(),
        started_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

pub(super) fn phase_started_at_ago(age: Duration) -> String {
    let age = chrono::Duration::from_std(age).unwrap();
    (Utc::now() - age)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

pub(super) async fn build_test_runner_report(
    mode: &str,
    proxy_port: Option<u16>,
    dns_port: Option<u16>,
    mitm_procs: Vec<process::MitmproxyProcessInfo>,
    dns_procs: Vec<process::DnsmasqProcessInfo>,
) -> RunnerReport {
    let fixture = doctor_report_fixture(mode, proxy_port, dns_port);
    let runner = live_runner_instance(
        std::process::id(),
        fixture.config_path.clone(),
        fixture.base_dir.clone(),
    );
    let report = build_runner_report(&runner, &[], &mitm_procs, &dns_procs, &[]).await;
    assert!(report.status.is_some(), "test status should load");
    report
}

pub(super) fn mitm_proc(pid: u32, port: u16) -> process::MitmproxyProcessInfo {
    process::MitmproxyProcessInfo {
        pid,
        ppid: None,
        port,
    }
}

pub(super) fn dns_proc(pid: u32, port: u16) -> process::DnsmasqProcessInfo {
    process::DnsmasqProcessInfo { pid, port }
}

pub(super) fn empty_discovered() -> process::DiscoveredProcesses {
    process::DiscoveredProcesses {
        firecrackers: vec![],
        mitmdumps: vec![],
        dnsmasqs: vec![],
    }
}

pub(super) fn has_proxy_warning(report: &RunnerReport) -> bool {
    report.warnings.iter().any(|w| {
        matches!(
            w,
            Warning::NoMitmproxy { .. } | Warning::StaleMitmproxy { .. }
        )
    })
}

pub(super) fn has_dns_warning(report: &RunnerReport) -> bool {
    report
        .warnings
        .iter()
        .any(|w| matches!(w, Warning::NoDnsmasq { .. }))
}
