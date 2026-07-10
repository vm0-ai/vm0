use super::super::*;

#[test]
fn format_uptime_minutes() {
    let now = chrono::Utc::now();
    let started = now - chrono::Duration::minutes(42);
    let s = started.to_rfc3339();
    assert_eq!(format_uptime(&s), "42m");
}

#[test]
fn format_uptime_hours_and_minutes() {
    let now = chrono::Utc::now();
    let started = now - chrono::Duration::hours(3) - chrono::Duration::minutes(15);
    let s = started.to_rfc3339();
    assert_eq!(format_uptime(&s), "3h 15m");
}

#[test]
fn format_uptime_days() {
    let now = chrono::Utc::now();
    let started = now - chrono::Duration::days(2) - chrono::Duration::hours(5);
    let s = started.to_rfc3339();
    assert_eq!(format_uptime(&s), "2d 5h 0m");
}

#[test]
fn format_uptime_invalid_timestamp() {
    assert_eq!(format_uptime("not-a-date"), "unknown");
}

#[test]
fn warning_display() {
    let w = Warning::NoFirecrackerForRun {
        run_id: "abc-123".into(),
        sandbox_id: "sbox-abc".into(),
        base_dir: PathBuf::from("/data/r1"),
    };
    assert_eq!(
        w.to_string(),
        "no firecracker process for run abc-123 (sandbox sbox-abc)"
    );

    let w = Warning::StalePreparingRun {
        run_id: "prep-123".into(),
        sandbox_id: "sbox-prep".into(),
        base_dir: PathBuf::from("/data/r1"),
    };
    assert_eq!(
        w.to_string(),
        "run prep-123 stuck preparing (sandbox sbox-prep)"
    );

    let w = Warning::FirecrackerNotInStatus {
        pid: 17,
        sandbox_id: "sbox-gone".into(),
        base_dir: PathBuf::from("/data/r1"),
    };
    assert_eq!(
        w.to_string(),
        "firecracker PID 17 (sandbox sbox-gone) not in status.json"
    );

    let w = Warning::ApiUnreachable {
        server_url: "https://example.com".into(),
        server_token: "tok".into(),
    };
    assert_eq!(w.to_string(), "API unreachable");

    let w = Warning::OrphanFirecracker {
        pid: 42,
        sandbox_id: "xyz".into(),
        ppid: Some(10),
    };
    assert_eq!(
        w.to_string(),
        "orphan firecracker PID 42 (sandbox xyz, ppid=10)"
    );

    let w = Warning::OrphanFirecracker {
        pid: 42,
        sandbox_id: "xyz".into(),
        ppid: None,
    };
    assert_eq!(
        w.to_string(),
        "orphan firecracker PID 42 (sandbox xyz, ppid=?)"
    );

    let w = Warning::StaleMitmproxy {
        pid: 555,
        port: 32821,
    };
    assert_eq!(
        w.to_string(),
        "stale mitmproxy PID 555 on port 32821 (runner stopped)"
    );

    let w = Warning::OrphanNbdDevice {
        device_index: 3,
        pid: 12345,
    };
    assert_eq!(
        w.to_string(),
        "orphan NBD device /dev/nbd3 (owner PID 12345 no longer exists)"
    );

    let w = Warning::NbdScanFailed;
    assert_eq!(w.to_string(), "NBD orphan scan failed (task panicked)");
}

#[test]
fn is_inactive_mode_classification() {
    assert!(is_inactive_mode("stopped"));
    assert!(is_inactive_mode("draining"));
    assert!(!is_inactive_mode("running"));
    assert!(!is_inactive_mode("starting"));
    assert!(!is_inactive_mode(""));
}

#[test]
fn idle_vm_diagnostic_line_includes_session_id() {
    let raw_session_id = "sess-sensitive-doctor-17975";
    let line = format_idle_vm_diagnostic_line(&IdleVm {
        session_id: raw_session_id.into(),
        sandbox_id: "sandbox-123".into(),
    });

    assert!(line.contains(raw_session_id));
    assert!(line.contains("sandbox-123"));
}
