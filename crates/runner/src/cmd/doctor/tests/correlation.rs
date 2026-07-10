use super::super::*;
use super::support::phase_started_at_ago;

fn legacy_active_run(run_id: &str, sandbox_id: &str) -> ActiveRun {
    ActiveRun {
        run_id: run_id.into(),
        sandbox_id: sandbox_id.into(),
        phase: None,
        phase_started_at: None,
    }
}

fn phased_active_run(
    run_id: &str,
    sandbox_id: &str,
    phase: &str,
    phase_started_at: Option<String>,
) -> ActiveRun {
    ActiveRun {
        run_id: run_id.into(),
        sandbox_id: sandbox_id.into(),
        phase: Some(phase.into()),
        phase_started_at,
    }
}

fn status_info(active: Vec<(&str, &str)>, idle_sandboxes: Vec<&str>) -> StatusInfo {
    status_info_with_active_runs(
        active
            .into_iter()
            .map(|(run_id, sandbox_id)| legacy_active_run(run_id, sandbox_id))
            .collect(),
        idle_sandboxes,
    )
}

fn status_info_with_active_runs(
    active_runs: Vec<ActiveRun>,
    idle_sandboxes: Vec<&str>,
) -> StatusInfo {
    StatusInfo {
        mode: "running".into(),
        started_at: "2026-01-01T00:00:00.000Z".into(),
        active_runs,
        // Tests only need sandbox_id lookup for idle VMs; synthesize a
        // placeholder session_id.
        idle_vms: idle_sandboxes
            .into_iter()
            .enumerate()
            .map(|(i, sbid)| IdleVm {
                session_id: format!("sess-{i}"),
                sandbox_id: sbid.into(),
            })
            .collect(),
        proxy_port: None,
        dns_port: None,
    }
}

fn fc_info(pid: u32, sandbox_id: &str, base_dir: &str) -> process::FirecrackerProcessInfo {
    process::FirecrackerProcessInfo {
        pid,
        ppid: None,
        sandbox_id: sandbox_id.into(),
        base_dir: Some(PathBuf::from(base_dir)),
        identity: None,
    }
}

#[test]
fn correlate_jobs_matching() {
    // sandbox_id == run_id (first-job case: doctor still joins correctly).
    let status = status_info(vec![("abc", "abc"), ("def", "def")], vec![]);
    let fc = vec![
        fc_info(100, "abc", "/data/r1"),
        fc_info(101, "def", "/data/r1"),
    ];
    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
    assert_eq!(jobs.len(), 2);
    assert!(warnings.is_empty());
    assert!(matches!(
        jobs.first().unwrap(),
        JobStatus::Running { pid: 100, .. }
    ));
}

#[test]
fn correlate_active_reused_no_warning() {
    // Sandbox was reused: FC's sandbox_id differs from the active run_id
    // but matches via the status mapping — should emit zero warnings.
    let status = status_info(vec![("run-new", "sandbox-orig")], vec![]);
    let fc = vec![fc_info(200, "sandbox-orig", "/data/r1")];
    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
    assert_eq!(jobs.len(), 1);
    assert!(warnings.is_empty(), "reused sandbox must not warn");
    let JobStatus::Running { run_id, pid } = jobs.first().unwrap() else {
        panic!("expected Running");
    };
    assert_eq!(
        run_id, "run-new",
        "Running should carry the run_id, not sandbox_id"
    );
    assert_eq!(*pid, 200);
}

#[test]
fn correlate_idle_vm_no_warning() {
    // Parked idle VM: no active run, sandbox_id listed in idle_vms.
    // This is the exact prod-3 v0.79.12 scenario that used to
    // false-positive with 2 `FirecrackerNotInStatus` warnings.
    let status = status_info(vec![], vec!["sandbox-idle"]);
    let fc = vec![fc_info(300, "sandbox-idle", "/data/r1")];
    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
    assert!(jobs.is_empty(), "idle FC should not surface as a job");
    assert!(warnings.is_empty(), "idle FC must not warn");
}

#[test]
fn correlate_active_no_fc_warns() {
    // Active run with no matching FC process.
    let status = status_info(vec![("run-x", "sandbox-x")], vec![]);
    let fc: Vec<process::FirecrackerProcessInfo> = vec![];
    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
    assert_eq!(jobs.len(), 1);
    assert!(matches!(jobs.first().unwrap(), JobStatus::NoProcess { .. }));
    assert_eq!(warnings.len(), 1);
    let msg = warnings[0].to_string();
    assert!(msg.contains("no firecracker"), "{msg}");
    assert!(msg.contains("run-x"), "{msg}");
    assert!(msg.contains("sandbox-x"), "{msg}");
}

#[test]
fn correlate_preparing_active_without_fc_within_grace_does_not_warn() {
    let status = status_info_with_active_runs(
        vec![phased_active_run(
            "run-prep",
            "sandbox-prep",
            "preparing",
            Some(phase_started_at_ago(Duration::from_secs(5))),
        )],
        vec![],
    );
    let fc: Vec<process::FirecrackerProcessInfo> = vec![];

    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);

    assert_eq!(jobs.len(), 1);
    assert!(warnings.is_empty());
    assert!(matches!(jobs.first().unwrap(), JobStatus::Preparing { .. }));
}

#[test]
fn correlate_preparing_active_without_fc_beyond_grace_warns() {
    let status = status_info_with_active_runs(
        vec![phased_active_run(
            "run-stale",
            "sandbox-stale",
            "preparing",
            Some(phase_started_at_ago(
                PREPARING_NO_PROCESS_GRACE + Duration::from_secs(1),
            )),
        )],
        vec![],
    );
    let fc: Vec<process::FirecrackerProcessInfo> = vec![];

    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);

    assert_eq!(jobs.len(), 1);
    assert!(matches!(
        jobs.first().unwrap(),
        JobStatus::Preparing { pid: None, .. }
    ));
    assert_eq!(warnings.len(), 1);
    let msg = warnings[0].to_string();
    assert!(msg.contains("stuck preparing"), "{msg}");
    assert!(msg.contains("run-stale"), "{msg}");
    assert!(msg.contains("sandbox-stale"), "{msg}");
}

#[test]
fn correlate_preparing_active_with_fc_within_grace_stays_preparing() {
    let status = status_info_with_active_runs(
        vec![phased_active_run(
            "run-prep",
            "sandbox-prep",
            "preparing",
            Some(phase_started_at_ago(Duration::from_secs(5))),
        )],
        vec![],
    );
    let fc = vec![fc_info(123, "sandbox-prep", "/data/r1")];

    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);

    assert_eq!(jobs.len(), 1);
    assert!(warnings.is_empty());
    let JobStatus::Preparing { run_id, pid } = jobs.first().unwrap() else {
        panic!("expected preparing job");
    };
    assert_eq!(run_id, "run-prep");
    assert_eq!(*pid, Some(123));
}

#[test]
fn correlate_preparing_active_with_fc_beyond_grace_warns() {
    let status = status_info_with_active_runs(
        vec![phased_active_run(
            "run-stale-with-fc",
            "sandbox-stale-with-fc",
            "preparing",
            Some(phase_started_at_ago(
                PREPARING_NO_PROCESS_GRACE + Duration::from_secs(1),
            )),
        )],
        vec![],
    );
    let fc = vec![fc_info(456, "sandbox-stale-with-fc", "/data/r1")];

    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);

    assert_eq!(jobs.len(), 1);
    let JobStatus::Preparing { run_id, pid } = jobs.first().unwrap() else {
        panic!("expected preparing job");
    };
    assert_eq!(run_id, "run-stale-with-fc");
    assert_eq!(*pid, Some(456));
    assert_eq!(warnings.len(), 1);
    let msg = warnings[0].to_string();
    assert!(msg.contains("stuck preparing"), "{msg}");
    assert!(msg.contains("run-stale-with-fc"), "{msg}");
    assert!(msg.contains("sandbox-stale-with-fc"), "{msg}");
}

#[test]
fn correlate_preparing_active_without_timestamp_warns() {
    let status = status_info_with_active_runs(
        vec![phased_active_run(
            "run-missing-ts",
            "sandbox-missing-ts",
            "preparing",
            None,
        )],
        vec![],
    );
    let fc: Vec<process::FirecrackerProcessInfo> = vec![];

    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);

    assert_eq!(jobs.len(), 1);
    assert!(matches!(
        jobs.first().unwrap(),
        JobStatus::Preparing { pid: None, .. }
    ));
    assert_eq!(warnings.len(), 1);
}

#[test]
fn correlate_orphan_fc_warns() {
    // FC process with a sandbox_id outside both active and idle sets.
    let status = status_info(vec![("run-a", "sandbox-a")], vec!["sandbox-idle"]);
    let fc = vec![
        fc_info(400, "sandbox-a", "/data/r1"),      // active, OK
        fc_info(401, "sandbox-idle", "/data/r1"),   // idle, OK
        fc_info(402, "sandbox-orphan", "/data/r1"), // orphan, warn
    ];
    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
    assert_eq!(jobs.len(), 2, "one active job + one orphan surface");
    assert_eq!(warnings.len(), 1);
    let msg = warnings[0].to_string();
    assert!(msg.contains("sandbox-orphan"), "{msg}");
    assert!(msg.contains("not in status.json"), "{msg}");

    // The orphan row must carry the sandbox_id in `NotInStatus`, not
    // misfiled into a `run_id` variant. Type-checking this here locks
    // in the distinction so future refactors can't quietly regress.
    let orphan_row = jobs
        .iter()
        .find(|j| matches!(j, JobStatus::NotInStatus { .. }))
        .expect("orphan row missing");
    let JobStatus::NotInStatus { sandbox_id } = orphan_row else {
        panic!("orphan row must be NotInStatus");
    };
    assert_eq!(sandbox_id, "sandbox-orphan");
}

#[test]
fn correlate_jobs_ignores_other_runners() {
    let status = status_info(vec![("abc", "sbox-abc")], vec![]);
    // This firecracker belongs to a different runner (different base_dir)
    let fc = vec![process::FirecrackerProcessInfo {
        pid: 300,
        ppid: None,
        sandbox_id: "sbox-abc".into(),
        base_dir: Some(PathBuf::from("/data/r2")),
        identity: None,
    }];
    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
    assert_eq!(jobs.len(), 1);
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].to_string().contains("no firecracker process"));
}

#[test]
fn correlate_jobs_empty_status_empty_fcs() {
    let status = status_info(vec![], vec![]);
    let fc: Vec<process::FirecrackerProcessInfo> = vec![];
    let (jobs, warnings) = correlate_jobs(&status, Path::new("/data/r1"), &fc);
    assert!(jobs.is_empty());
    assert!(warnings.is_empty());
}

// -- persists() recheck tests --------------------------------------------
//
// These exercise the resolution logic used in the recheck loop. Each
// writes a real status.json (since persists() calls read_status
// internally) and asserts whether the warning clears.
