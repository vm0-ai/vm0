use super::super::*;
use super::support::{
    build_test_runner_report, dns_proc, doctor_report_fixture, empty_discovered, has_dns_warning,
    has_proxy_warning, live_runner_instance, mitm_proc,
};
use httpmock::prelude::*;

#[tokio::test]
async fn report_uses_registry_identity_when_config_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let base_dir = dir.path().join("runner");
    std::fs::create_dir_all(&base_dir).unwrap();
    std::fs::write(
        base_dir.join("status.json"),
        r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [],
            "started_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z"
        }"#,
    )
    .unwrap();
    let runner = live_runner_instance(
        std::process::id(),
        dir.path().join("missing-runner.yaml"),
        base_dir.clone(),
    );

    let report = build_runner_report(&runner, &[], &[], &[], &[]).await;

    assert_eq!(report.live_runner.runner_name, "test-runner");
    assert_eq!(report.live_runner.base_dir, base_dir);
    assert_eq!(
        report.live_runner.config_path,
        dir.path().join("missing-runner.yaml")
    );
    assert_eq!(report.live_runner.pid, std::process::id());
    assert_eq!(report.live_runner.subcommand, "start");
    assert!(report.status.is_some());
    assert_eq!(report.api_ok, None);
}

#[tokio::test]
async fn report_uses_registry_subcommand() {
    let fixture = doctor_report_fixture("running", None, None);
    let mut runner = live_runner_instance(
        std::process::id(),
        fixture.config_path.clone(),
        fixture.base_dir.clone(),
    );
    runner.subcommand = "benchmark".into();

    let report = build_runner_report(&runner, &[], &[], &[], &[]).await;

    assert_eq!(report.live_runner.subcommand, "benchmark");
}

#[tokio::test]
async fn build_runner_reports_requires_live_registry_entries() {
    let server = MockServer::start_async().await;
    let api = server
        .mock_async(|when, then| {
            when.method("HEAD").path("/api");
            then.status(200);
        })
        .await;
    let fixture = doctor_report_fixture("running", None, None);
    let config = serde_json::json!({
        "name": "spoofed-runner",
        "group": "vm0/test",
        "base_dir": fixture.base_dir.display().to_string(),
        "ca_dir": fixture._dir.path().join("ca").display().to_string(),
        "firecracker": {
            "binary": fixture._dir.path().join("firecracker").display().to_string(),
            "kernel": fixture._dir.path().join("vmlinux").display().to_string(),
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
        "server": {
            "url": server.url("/api"),
            "token": "spoofed-token",
        },
    });
    std::fs::write(
        &fixture.config_path,
        serde_yaml_ng::to_string(&config).unwrap(),
    )
    .unwrap();
    let discovered = empty_discovered();

    let reports = build_runner_reports(&[], &discovered, &[]).await;

    assert!(reports.is_empty());
    api.assert_calls_async(0).await;
}

#[tokio::test]
async fn report_warns_for_running_without_proxy() {
    let report = build_test_runner_report("running", Some(32821), None, vec![], vec![]).await;
    assert!(
        report
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::NoMitmproxy { port: 32821, .. }))
    );
}

#[tokio::test]
async fn report_warns_stale_proxy_on_stopped_runner() {
    let report = build_test_runner_report(
        "stopped",
        Some(32821),
        None,
        vec![mitm_proc(999, 32821)],
        vec![],
    )
    .await;
    assert!(report.warnings.iter().any(|w| matches!(
        w,
        Warning::StaleMitmproxy {
            pid: 999,
            port: 32821,
        }
    )));
}

#[tokio::test]
async fn report_no_warning_for_stopped_without_proxy() {
    let report = build_test_runner_report("stopped", Some(32821), None, vec![], vec![]).await;
    assert!(!has_proxy_warning(&report));
}

#[tokio::test]
async fn report_no_warning_for_draining_proxy() {
    let without_proxy =
        build_test_runner_report("draining", Some(32821), None, vec![], vec![]).await;
    assert!(!has_proxy_warning(&without_proxy));

    let with_proxy = build_test_runner_report(
        "draining",
        Some(32821),
        None,
        vec![mitm_proc(999, 32821)],
        vec![],
    )
    .await;
    assert!(!has_proxy_warning(&with_proxy));
}

#[tokio::test]
async fn report_no_proxy_or_dns_warning_while_starting() {
    let report =
        build_test_runner_report("starting", Some(32821), Some(5353), vec![], vec![]).await;

    assert!(!has_proxy_warning(&report));
    assert!(!has_dns_warning(&report));
}

#[tokio::test]
async fn report_no_warning_for_running_with_proxy() {
    let report = build_test_runner_report(
        "running",
        Some(32821),
        None,
        vec![mitm_proc(999, 32821)],
        vec![],
    )
    .await;
    assert!(!has_proxy_warning(&report));
}

#[tokio::test]
async fn report_warns_for_running_when_only_unrelated_proxy_exists() {
    let report = build_test_runner_report(
        "running",
        Some(32821),
        None,
        vec![mitm_proc(999, 32822)],
        vec![],
    )
    .await;
    assert!(
        report
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::NoMitmproxy { port: 32821, .. }))
    );
}

#[tokio::test]
async fn report_no_stale_proxy_warning_for_stopped_with_unrelated_proxy() {
    let report = build_test_runner_report(
        "stopped",
        Some(32821),
        None,
        vec![mitm_proc(999, 32822)],
        vec![],
    )
    .await;
    assert!(!has_proxy_warning(&report));
}

#[tokio::test]
async fn report_warns_for_running_without_dnsmasq() {
    let report = build_test_runner_report("running", None, Some(5353), vec![], vec![]).await;
    assert!(
        report
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::NoDnsmasq { port: 5353, .. }))
    );
}

#[tokio::test]
async fn report_no_warning_for_running_with_dnsmasq() {
    let report = build_test_runner_report(
        "running",
        None,
        Some(5353),
        vec![],
        vec![dns_proc(888, 5353)],
    )
    .await;
    assert!(!has_dns_warning(&report));
}

#[tokio::test]
async fn report_warns_for_running_when_only_unrelated_dnsmasq_exists() {
    let report = build_test_runner_report(
        "running",
        None,
        Some(5353),
        vec![],
        vec![dns_proc(888, 5354)],
    )
    .await;
    assert!(
        report
            .warnings
            .iter()
            .any(|w| matches!(w, Warning::NoDnsmasq { port: 5353, .. }))
    );
}
