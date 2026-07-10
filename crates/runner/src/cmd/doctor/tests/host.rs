use super::super::*;
use super::support::live_runner_instance;

#[test]
fn parse_netns_list_line_valid() {
    assert_eq!(
        parse_netns_list_line("vm0-ns-00-0a (id: 42)"),
        Some(("vm0-ns-00-0a", 0))
    );
    assert_eq!(
        parse_netns_list_line("vm0-ns-3f-ff"),
        Some(("vm0-ns-3f-ff", 63))
    );
}

#[test]
fn parse_netns_list_line_ignores_malformed_names() {
    assert_eq!(parse_netns_list_line(""), None);
    assert_eq!(parse_netns_list_line("   "), None);
    assert_eq!(parse_netns_list_line("not-a-ns"), None);
    assert_eq!(parse_netns_list_line("vm0-ns-"), None);
    assert_eq!(parse_netns_list_line("vm0-ns-00"), None);
    assert_eq!(parse_netns_list_line("vm0-ns-00-extra"), None);
    assert_eq!(parse_netns_list_line("vm0-ns-00-zz"), None);
    assert_eq!(parse_netns_list_line("vm0-ns-00-0a-extra"), None);
    assert_eq!(parse_netns_list_line("vm0-ns-0A-00"), None);
    assert_eq!(parse_netns_list_line("vm0-ns-00-0A"), None);
    assert_eq!(parse_netns_list_line("vm0-ns-40-00"), None);
    assert_eq!(parse_netns_list_line("vm0-ns-ff-00"), None);
}

#[test]
fn find_stopped_services_detects_missing() {
    let installed = vec![
        InstalledService {
            unit_name: "vm0-runner-active".into(),
            config_path: Some(PathBuf::from("/data/active.yaml")),
        },
        InstalledService {
            unit_name: "vm0-runner-stopped".into(),
            config_path: Some(PathBuf::from("/data/stopped.yaml")),
        },
    ];
    let reports = vec![RunnerReport {
        live_runner: live_runner_instance(
            1,
            PathBuf::from("/data/active.yaml"),
            PathBuf::from("/data/active"),
        ),
        service_type: ServiceType::Installed("vm0-runner-active".into()),
        status: None,
        api_ok: None,
        proxy_pid: None,
        dns_pid: None,
        jobs: vec![],
        warnings: vec![],
    }];
    let stopped = find_stopped_services(&installed, &reports);
    assert_eq!(stopped.len(), 1);
    assert_eq!(stopped[0].unit_name, "vm0-runner-stopped");
    assert_eq!(stopped[0].config_info, "/data/stopped.yaml");
}

#[test]
fn is_test_tld_matches_dot_test() {
    assert!(is_test_tld("https://not-a-real-server.test/api"));
    assert!(is_test_tld("https://sub.domain.test"));
    assert!(is_test_tld("https://test"));
    assert!(is_test_tld("https://server.test:8080/api"));
}

#[test]
fn is_test_tld_rejects_substring_match() {
    assert!(!is_test_tld("https://attestation.service.internal/api"));
    assert!(!is_test_tld("https://my.testing.company.com/api"));
    assert!(!is_test_tld("https://contest.example.com"));
}

#[test]
fn is_test_tld_handles_edge_cases() {
    assert!(!is_test_tld("not-a-url"));
    assert!(!is_test_tld("https://example.com/.test"));
    assert!(!is_test_tld("https://example.com?q=.test"));
}

#[tokio::test]
async fn is_lock_free_returns_true_when_file_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("no-such-file.lock");
    assert!(is_lock_free(path.to_str().unwrap()).await);
}

#[tokio::test]
async fn is_lock_free_returns_true_when_lock_not_held() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("free.lock");
    std::fs::File::create(&path).unwrap();
    assert!(is_lock_free(path.to_str().unwrap()).await);
}

#[tokio::test]
async fn is_lock_free_returns_false_when_lock_held() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("held.lock");
    let file = std::fs::File::create(&path).unwrap();
    // Hold an exclusive lock for the duration of the test.
    let _lock = nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock)
        .expect("failed to acquire test lock");
    assert!(!is_lock_free(path.to_str().unwrap()).await);
}
