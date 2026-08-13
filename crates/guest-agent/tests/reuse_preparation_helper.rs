#![cfg(target_os = "linux")]

use std::fs::File;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use guest_contracts::reuse_preparation::{
    REUSE_PREPARATION_EXIT_CLEANUP_FAILED, REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED,
    REUSE_PREPARATION_EXIT_INVALID_REQUEST, ReusePreparationReport, ReusePreparationRequest,
};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[test]
fn prepare_for_reuse_preserves_generation_when_candidate_runtime_is_absent() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runtime/runs");
    let current = runs.join("generation");
    let unstarted_candidate = runs.join("candidate");
    let retained = runs.join("retained");
    let stale = runs.join("stale/nested");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(current.join("logs"))?;
    std::fs::create_dir_all(retained.join("logs"))?;
    std::fs::create_dir_all(&stale)?;
    std::fs::create_dir_all(&outside)?;
    std::fs::write(
        current.join("final-session-history-identity.json"),
        b"current",
    )?;
    std::fs::write(
        retained.join("final-session-history-identity.json"),
        b"retained",
    )?;
    std::fs::write(stale.join("agent.jsonl"), b"stale")?;
    std::fs::write(runs.join("stale-file"), b"stale")?;
    std::fs::write(outside.join("keep"), b"outside")?;
    symlink(&outside, runs.join("stale-link"))?;
    assert!(!unstarted_candidate.exists());

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
        retained_runtime_dir: Some(path_string(&retained)),
    })?;

    assert!(
        output.status.success(),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report = serde_json::from_slice::<ReusePreparationReport>(&output.stdout)?;
    assert_eq!(report.removed_entries, 3);
    assert!(report.before.available_bytes > 0);
    assert!(report.after.available_bytes > 0);
    assert_eq!(
        std::fs::read(current.join("final-session-history-identity.json"))?,
        b"current"
    );
    assert_eq!(
        std::fs::read(retained.join("final-session-history-identity.json"))?,
        b"retained"
    );
    assert!(!runs.join("stale").exists());
    assert!(!runs.join("stale-file").exists());
    assert!(!runs.join("stale-link").exists());
    assert!(!unstarted_candidate.exists());
    assert_eq!(std::fs::read(outside.join("keep"))?, b"outside");
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_missing_protected_generation_before_cleanup() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runtime/runs");
    let missing_generation = runs.join("missing-generation");
    let stale = runs.join("stale");
    std::fs::create_dir_all(&stale)?;
    std::fs::write(stale.join("agent.jsonl"), b"stale")?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&missing_generation),
        retained_runtime_dir: None,
    })?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert!(!missing_generation.exists());
    assert_eq!(std::fs::read(stale.join("agent.jsonl"))?, b"stale");
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_symlinked_runtime_parent_without_touching_target() -> TestResult {
    let dir = tempfile::tempdir()?;
    let real_parent = dir.path().join("real/runs");
    let current = real_parent.join("current");
    let stale = real_parent.join("stale");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&stale)?;
    std::fs::create_dir_all(dir.path().join("linked"))?;
    symlink(&real_parent, dir.path().join("linked/runs"))?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&dir.path().join("linked/runs/current")),
        retained_runtime_dir: None,
    })?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert!(current.exists());
    assert!(stale.exists());
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_retained_runtime_from_another_parent() -> TestResult {
    let dir = tempfile::tempdir()?;
    let current = dir.path().join("runs/current");
    let retained = dir.path().join("other/retained");
    let stale = dir.path().join("runs/stale");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&retained)?;
    std::fs::create_dir_all(&stale)?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
        retained_runtime_dir: Some(path_string(&retained)),
    })?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_INVALID_REQUEST)
    );
    assert!(current.exists());
    assert!(retained.exists());
    assert!(stale.exists());
    Ok(())
}

#[test]
fn prepare_for_reuse_fails_closed_when_runtime_parent_is_not_a_directory() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runs");
    let current = runs.join("current");
    let outside = dir.path().join("outside");
    std::fs::write(&runs, b"not-a-directory")?;
    std::fs::create_dir_all(&outside)?;
    std::fs::write(outside.join("keep"), b"outside")?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
        retained_runtime_dir: None,
    })?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert_eq!(std::fs::read(&runs)?, b"not-a-directory");
    assert_eq!(std::fs::read(outside.join("keep"))?, b"outside");
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_nested_filesystem_without_touching_it() -> TestResult {
    let mounted_data = tempfile::tempdir_in("/dev/shm")?;
    std::fs::write(mounted_data.path().join("keep"), b"mounted-data")?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: "/dev/shm".into(),
        retained_runtime_dir: None,
    })?;

    assert_mount_boundary_failure(&output);
    assert_eq!(
        std::fs::read(mounted_data.path().join("keep"))?,
        b"mounted-data"
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_same_filesystem_bind_mount() -> TestResult {
    if let Some(mount_path) = find_existing_same_filesystem_nested_mount()? {
        let output = run_helper(&ReusePreparationRequest {
            current_runtime_dir: path_string(&mount_path),
            retained_runtime_dir: None,
        })?;

        assert_mount_boundary_failure(&output);
        assert!(mount_path.exists());
        return Ok(());
    }

    let dir = tempfile::tempdir()?;
    let mounted_source = dir.path().join("outside");
    let runs = dir.path().join("runs");
    let current = runs.join("current");
    let stale_mount = runs.join("stale/nested-mount");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&stale_mount)?;
    std::fs::create_dir_all(&mounted_source)?;
    std::fs::write(mounted_source.join("keep"), b"mounted-data")?;
    let request = ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
        retained_runtime_dir: None,
    };

    let output = run_helper_with_bind_mount(&request, &mounted_source, &stale_mount)?;

    assert_mount_boundary_failure(&output);
    assert!(current.exists());
    assert!(runs.join("stale").exists());
    assert_eq!(std::fs::read(mounted_source.join("keep"))?, b"mounted-data");
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_missing_containment_capability() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::remove_file(containment.base.join("cgroup.kill"))?;

    let output = run_helper_with_containment(&request, &containment)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_stale_operation_cgroup() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::create_dir(containment.base.join("exec-stale"))?;

    let output = run_helper_with_containment(&request, &containment)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_missing_current_operation_cgroup() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::remove_dir_all(containment.base.join("exec-current"))?;

    let output = run_helper_with_containment(&request, &containment)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_unpopulated_exec_cgroup() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(containment.base.join("cgroup.events"), b"populated 0\n")?;

    let output = run_helper_with_containment(&request, &containment)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_direct_processes_in_exec_base() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(containment.base.join("cgroup.procs"), b"42\n")?;

    let output = run_helper_with_containment(&request, &containment)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_current_process_outside_exec_base() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;

    let output =
        run_helper_with_current_group(&request, &containment, "/outside/exec-current/workload")?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_missing_controller() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(
        containment.base.join("cgroup.subtree_control"),
        b"cpu memory\n",
    )?;

    let output = run_helper_with_containment(&request, &containment)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_missing_ancestor_memory_protection() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(containment.base.join("memory.min"), b"0\n")?;

    let output = run_helper_with_containment(&request, &containment)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_direct_processes_in_operation_parent() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(containment.base.join("exec-current/cgroup.procs"), b"42\n")?;

    let output = run_helper_with_containment(&request, &containment)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_populated_control_leaf() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(
        containment.base.join("exec-current/control/cgroup.events"),
        b"populated 1\n",
    )?;

    let output = run_helper_with_containment(&request, &containment)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_nested_workload_cgroup() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::create_dir(containment.base.join("exec-current/workload/unexpected"))?;

    let output = run_helper_with_containment(&request, &containment)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_stale_workload_pid_limit() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;
    std::fs::write(
        containment.base.join("exec-current/workload/pids.max"),
        b"2048\n",
    )?;

    let output = run_helper_with_containment(&request, &containment)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_helper_in_control_leaf() -> TestResult {
    let (request, _runtime) = reusable_request()?;
    let containment = ContainmentFixture::new()?;

    let output =
        run_helper_with_current_group(&request, &containment, "/vm0-exec/exec-current/control")?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CONTAINMENT_FAILED)
    );
    Ok(())
}

struct ContainmentFixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    base: PathBuf,
}

impl ContainmentFixture {
    fn new() -> TestResult<Self> {
        let directory = tempfile::tempdir()?;
        let root = directory.path().join("cgroup");
        let base = root.join("vm0-exec");
        std::fs::create_dir_all(&base)?;
        for (filename, content) in [
            ("cgroup.controllers", "cpu memory pids\n"),
            ("cgroup.procs", ""),
            ("cgroup.events", "populated 1\nfrozen 0\n"),
            ("cgroup.kill", ""),
            ("cgroup.subtree_control", "cpu memory pids\n"),
        ] {
            std::fs::write(base.join(filename), content)?;
        }
        std::fs::write(
            base.join("memory.min"),
            guest_contracts::process_containment::CONTROL_MEMORY_RESERVE_BYTES.to_string(),
        )?;
        let operation = base.join("exec-current");
        std::fs::create_dir(&operation)?;
        for (filename, content) in [
            ("cgroup.controllers", "cpu memory pids\n"),
            ("cgroup.procs", ""),
            ("cgroup.events", "populated 1\nfrozen 0\n"),
            ("cgroup.kill", ""),
            ("cgroup.subtree_control", "cpu memory pids\n"),
        ] {
            std::fs::write(operation.join(filename), content)?;
        }
        for (leaf, populated) in [("control", "0"), ("workload", "1")] {
            let leaf = operation.join(leaf);
            std::fs::create_dir(&leaf)?;
            for (filename, content) in [
                ("cgroup.procs", ""),
                (
                    "cgroup.events",
                    if populated == "1" {
                        "populated 1\nfrozen 0\n"
                    } else {
                        "populated 0\nfrozen 0\n"
                    },
                ),
                ("cgroup.kill", ""),
                ("cgroup.subtree_control", ""),
            ] {
                std::fs::write(leaf.join(filename), content)?;
            }
        }
        let policy = guest_contracts::process_containment::WorkloadResourcePolicy::for_current_guest_capacity()
            .map_err(std::io::Error::other)?;
        let workload = operation.join("workload");
        for (filename, value) in [
            (
                "cpu.max",
                format!("{} {}", policy.cpu_quota_us, policy.cpu_period_us),
            ),
            ("memory.high", policy.memory_high_bytes.to_string()),
            ("memory.max", policy.memory_max_bytes.to_string()),
            ("memory.oom.group", "1".to_string()),
            ("pids.max", policy.pids_max.to_string()),
        ] {
            std::fs::write(workload.join(filename), value)?;
        }
        Ok(Self {
            _directory: directory,
            root,
            base,
        })
    }
}

fn reusable_request() -> TestResult<(ReusePreparationRequest, tempfile::TempDir)> {
    let runtime = tempfile::tempdir()?;
    let current = runtime.path().join("runs/current");
    std::fs::create_dir_all(&current)?;
    Ok((
        ReusePreparationRequest {
            current_runtime_dir: path_string(&current),
            retained_runtime_dir: None,
        },
        runtime,
    ))
}

fn run_helper(request: &ReusePreparationRequest) -> Result<Output, Box<dyn std::error::Error>> {
    let containment = ContainmentFixture::new()?;
    run_helper_with_containment(request, &containment)
}

fn run_helper_with_containment(
    request: &ReusePreparationRequest,
    containment: &ContainmentFixture,
) -> Result<Output, Box<dyn std::error::Error>> {
    run_helper_with_current_group(request, containment, "/vm0-exec/exec-current/workload")
}

fn run_helper_with_current_group(
    request: &ReusePreparationRequest,
    containment: &ContainmentFixture,
    current_group: &str,
) -> Result<Output, Box<dyn std::error::Error>> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_guest-agent"))
        .env_clear()
        .env("VM0_TEST_PROCESS_CONTAINMENT_ROOT", &containment.root)
        .env("VM0_TEST_PROCESS_CONTAINMENT_CURRENT_GROUP", current_group)
        .arg("prepare-for-reuse")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("helper stdin was not piped"))?
        .write_all(&serde_json::to_vec(request)?)?;
    Ok(child.wait_with_output()?)
}

fn run_helper_with_bind_mount(
    request: &ReusePreparationRequest,
    mount_source: &Path,
    mount_target: &Path,
) -> Result<Output, Box<dyn std::error::Error>> {
    let containment = ContainmentFixture::new()?;
    let mut child = Command::new("/usr/bin/unshare")
        .env_clear()
        .env("VM0_TEST_PROCESS_CONTAINMENT_ROOT", &containment.root)
        .env(
            "VM0_TEST_PROCESS_CONTAINMENT_CURRENT_GROUP",
            "/vm0-exec/exec-current/workload",
        )
        .env("VM0_MOUNT_SOURCE", mount_source)
        .env("VM0_MOUNT_TARGET", mount_target)
        .env("VM0_HELPER", env!("CARGO_BIN_EXE_guest-agent"))
        .args([
            "--user",
            "--map-root-user",
            "--mount",
            "/bin/sh",
            "-c",
            "/usr/bin/mount --bind \"$VM0_MOUNT_SOURCE\" \"$VM0_MOUNT_TARGET\" && exec \"$VM0_HELPER\" prepare-for-reuse",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("helper stdin was not piped"))?
        .write_all(&serde_json::to_vec(request)?)?;
    Ok(child.wait_with_output()?)
}

fn find_existing_same_filesystem_nested_mount() -> TestResult<Option<PathBuf>> {
    for candidate in ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys"] {
        let path = Path::new(candidate);
        let Some(parent) = path.parent() else {
            continue;
        };
        if !path.is_dir() {
            continue;
        }
        let parent_identity = path_mount_identity(parent)?;
        let candidate_identity = path_mount_identity(path)?;
        if parent_identity.0 == candidate_identity.0 && parent_identity.1 != candidate_identity.1 {
            return Ok(Some(path.to_path_buf()));
        }
    }
    Ok(None)
}

fn path_mount_identity(path: &Path) -> TestResult<(u64, u64)> {
    let file = File::open(path)?;
    let device = file.metadata()?.dev();
    let fdinfo = std::fs::read_to_string(format!("/proc/self/fdinfo/{}", file.as_raw_fd()))?;
    let mount_id = fdinfo
        .lines()
        .find_map(|line| line.strip_prefix("mnt_id:"))
        .ok_or_else(|| std::io::Error::other("mount identity is unavailable"))?
        .trim()
        .parse()?;
    Ok((device, mount_id))
}

fn assert_mount_boundary_failure(output: &Output) {
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED),
        "stdout={}, stderr={stderr}",
        String::from_utf8_lossy(&output.stdout),
    );
    assert!(
        stderr.contains("mount or filesystem boundary"),
        "unexpected stderr: {stderr}"
    );
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
