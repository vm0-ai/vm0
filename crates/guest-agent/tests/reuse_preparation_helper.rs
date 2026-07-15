#![cfg(target_os = "linux")]

use std::io::Write;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;
use std::process::{Command, Output, Stdio};

use guest_contracts::reuse_preparation::{
    REUSE_PREPARATION_EXIT_CLEANUP_FAILED, REUSE_PREPARATION_EXIT_INVALID_REQUEST,
    ReusePreparationReport, ReusePreparationRequest,
};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

#[test]
fn prepare_for_reuse_removes_only_unprotected_runtime_entries() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runtime/runs");
    let current = runs.join("current");
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
    assert_eq!(std::fs::read(outside.join("keep"))?, b"outside");
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
fn prepare_for_reuse_fails_closed_when_stale_directory_cannot_be_opened() -> TestResult {
    let dir = tempfile::tempdir()?;
    let runs = dir.path().join("runs");
    let current = runs.join("current");
    let stale = runs.join("stale");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&stale)?;
    std::fs::set_permissions(&stale, std::fs::Permissions::from_mode(0o000))?;

    let output = run_helper(&ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
        retained_runtime_dir: None,
    })?;

    std::fs::set_permissions(&stale, std::fs::Permissions::from_mode(0o700))?;
    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED)
    );
    assert!(current.exists());
    assert!(stale.exists());
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_nested_filesystem_without_touching_it() -> TestResult {
    let dir = tempfile::tempdir()?;
    let mounted_source = tempfile::tempdir_in("/dev/shm")?;
    let runs = dir.path().join("runs");
    let current = runs.join("current");
    let stale_mount = runs.join("stale/nested-mount");
    std::fs::create_dir_all(&current)?;
    std::fs::create_dir_all(&stale_mount)?;
    std::fs::write(mounted_source.path().join("keep"), b"mounted-data")?;
    let request = ReusePreparationRequest {
        current_runtime_dir: path_string(&current),
        retained_runtime_dir: None,
    };
    let output = run_helper_with_bind_mount(&request, mounted_source.path(), &stale_mount)?;

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(current.exists());
    assert!(runs.join("stale").exists());
    assert_eq!(
        std::fs::read(mounted_source.path().join("keep"))?,
        b"mounted-data"
    );
    Ok(())
}

#[test]
fn prepare_for_reuse_rejects_same_filesystem_bind_mount() -> TestResult {
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

    assert_eq!(
        output.status.code(),
        Some(REUSE_PREPARATION_EXIT_CLEANUP_FAILED),
        "stdout={}, stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(current.exists());
    assert!(runs.join("stale").exists());
    assert_eq!(std::fs::read(mounted_source.join("keep"))?, b"mounted-data");
    Ok(())
}

fn run_helper(request: &ReusePreparationRequest) -> Result<Output, Box<dyn std::error::Error>> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_guest-agent"))
        .env_clear()
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
    let mut child = Command::new("/usr/bin/unshare")
        .env_clear()
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

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
