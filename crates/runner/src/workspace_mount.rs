//! Workspace drive mount lifecycle boundary.
//!
//! This module is the Rust entry point for mounting and unmounting the sandbox
//! guest workspace drive. It injects the canonical workspace path and the
//! workspace block device (`/dev/vdb`) into the included shell helpers, then
//! executes those helpers through the sandbox sudo exec path with diagnostic
//! labels, a bounded timeout, and bounded output capture.
//!
//! The mount helper is intentionally workspace-device-only: an existing mount is
//! accepted only when the workspace path is already mounted from the workspace
//! device. It refuses symlink workspace path components, unrelated mountpoints,
//! and a workspace device that is already mounted somewhere else.
//!
//! The unmount helper verifies that the workspace path is still backed by the
//! workspace device before it syncs, unmounts, scans holders, or signals
//! processes. A clean unmount is attempted first. If that fails, diagnostics and
//! cleanup stay targeted to processes that still reference the workspace:
//! direct cwd/root/exe holder cleanup, fd holder cleanup, a slower maps scan,
//! workspace child mount cleanup, and final mount-topology diagnostics. Holder
//! and mount diagnostics are bounded and truncated.
//!
//! Keep this as a high-level contract. The included shell helpers and their
//! tests remain the source of truth for exact command behavior and limits.

use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};
use shell_quote::quote_shell_arg;

use crate::error::{RunnerError, RunnerResult};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};

const WORKSPACE_MOUNT_TIMEOUT: Duration = Duration::from_secs(30);
const WORKSPACE_UNMOUNT_TIMEOUT: Duration = Duration::from_secs(45);
const WORKSPACE_DEVICE: &str = "/dev/vdb";
const WORKSPACE_MOUNT_SCRIPT: &str = include_str!("../scripts/mount-workspace-drive.sh");
const WORKSPACE_UNMOUNT_SCRIPT: &str = include_str!("../scripts/unmount-workspace-drive.sh");

pub(crate) async fn ensure_workspace_drive_mounted(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
) -> RunnerResult<()> {
    let cmd = workspace_mount_command();
    run_workspace_drive_command(
        sandbox,
        diagnostic_id,
        &cmd,
        "mount workspace drive",
        "workspace-mount",
        WORKSPACE_MOUNT_TIMEOUT,
    )
    .await
}

pub(crate) async fn flush_and_unmount_workspace_drive(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
) -> RunnerResult<()> {
    let cmd = workspace_unmount_command();
    run_workspace_drive_command(
        sandbox,
        diagnostic_id,
        &cmd,
        "unmount workspace drive",
        "workspace-unmount",
        WORKSPACE_UNMOUNT_TIMEOUT,
    )
    .await
}

async fn run_workspace_drive_command(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
    cmd: &str,
    operation: &'static str,
    label: &'static str,
    timeout: Duration,
) -> RunnerResult<()> {
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd,
                timeout,
                env: &[],
                sudo: true,
                stdin_bytes: None,
                output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
            },
            label,
        )
        .await
        .map_err(RunnerError::from)?;
    if helper_exec_succeeded(&result) {
        return Ok(());
    }

    let mut message = format_helper_exec_failure(operation, &result);
    message.push_str(&format!("; diagnostic id: {diagnostic_id}"));
    Err(RunnerError::Internal(message))
}

fn workspace_mount_command() -> String {
    let workspace_dir = quote_shell_arg(CANONICAL_WORKING_DIR);
    let workspace_device = quote_shell_arg(WORKSPACE_DEVICE);
    format!(
        "workspace_dir={workspace_dir}\nworkspace_device={workspace_device}\n{WORKSPACE_MOUNT_SCRIPT}"
    )
}

fn workspace_unmount_command() -> String {
    let workspace_dir = quote_shell_arg(CANONICAL_WORKING_DIR);
    let workspace_device = quote_shell_arg(WORKSPACE_DEVICE);
    let workspace_mountinfo_path = quote_shell_arg("/proc/self/mountinfo");
    format!(
        "workspace_dir={workspace_dir}\nworkspace_device={workspace_device}\nworkspace_mountinfo_path={workspace_mountinfo_path}\n{WORKSPACE_UNMOUNT_SCRIPT}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    #[cfg(target_os = "linux")]
    use std::process::{Child, ExitStatus};
    use std::process::{Command, Output};
    #[cfg(target_os = "linux")]
    use std::time::Instant;

    fn find_after(haystack: &str, needle: &str, start: usize) -> usize {
        start
            + haystack[start..]
                .find(needle)
                .unwrap_or_else(|| panic!("missing {needle} after byte {start}"))
    }

    fn write_executable(path: &Path, content: &str) {
        fs::write(path, content).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    fn fake_path_env(fake_bin: &Path) -> String {
        let path = std::env::var("PATH").unwrap_or_default();
        if path.is_empty() {
            fake_bin.display().to_string()
        } else {
            format!("{}:{path}", fake_bin.display())
        }
    }

    fn write_fake_mountpoint(fake_bin: &Path, workspace_dir: &Path, workspace_device: &Path) {
        let workspace_dir = quote_shell_arg(workspace_dir.to_str().unwrap());
        let workspace_device = quote_shell_arg(workspace_device.to_str().unwrap());
        write_executable(
            &fake_bin.join("mountpoint"),
            &format!(
                r#"#!/bin/sh
set -eu
workspace_dir={workspace_dir}
workspace_device={workspace_device}
case "$1" in
  -x)
    if [ "$2" = "--" ] && [ "$3" = "$workspace_device" ]; then
      echo 123
      exit 0
    fi
    ;;
  -q)
    if [ "$2" = "--" ] && [ "$3" = "$workspace_dir" ]; then
      exit 0
    fi
    ;;
  -d)
    if [ "$2" = "--" ] && [ "$3" = "$workspace_dir" ]; then
      echo 123
      exit 0
    fi
    ;;
esac
exit 1
"#
            ),
        );
    }

    fn write_fake_sync(fake_bin: &Path, log_path: &Path) {
        let log_path = quote_shell_arg(log_path.to_str().unwrap());
        write_executable(
            &fake_bin.join("sync"),
            &format!(
                r#"#!/bin/sh
set -eu
printf 'sync cwd=%s args=%s\n' "$(pwd)" "$*" >> {log_path}
"#
            ),
        );
    }

    fn write_successful_fake_umount(fake_bin: &Path, log_path: &Path) {
        let log_path = quote_shell_arg(log_path.to_str().unwrap());
        write_executable(
            &fake_bin.join("umount"),
            &format!(
                r#"#!/bin/sh
set -eu
printf 'umount cwd=%s args=%s\n' "$(pwd)" "$*" >> {log_path}
exit 0
"#
            ),
        );
    }

    fn write_busy_then_successful_fake_umount(fake_bin: &Path, log_path: &Path, count_path: &Path) {
        write_busy_until_successful_fake_umount(fake_bin, log_path, count_path, 1);
    }

    fn write_busy_twice_then_successful_fake_umount(
        fake_bin: &Path,
        log_path: &Path,
        count_path: &Path,
    ) {
        write_busy_until_successful_fake_umount(fake_bin, log_path, count_path, 2);
    }

    fn write_busy_until_successful_fake_umount(
        fake_bin: &Path,
        log_path: &Path,
        count_path: &Path,
        busy_calls: u32,
    ) {
        let log_path = quote_shell_arg(log_path.to_str().unwrap());
        let count_path = quote_shell_arg(count_path.to_str().unwrap());
        write_executable(
            &fake_bin.join("umount"),
            &format!(
                r#"#!/bin/sh
set -eu
count=0
if [ -f {count_path} ]; then
  count="$(cat {count_path})"
fi
count=$((count + 1))
printf '%s\n' "$count" > {count_path}
printf 'umount call=%s cwd=%s args=%s\n' "$count" "$(pwd)" "$*" >> {log_path}
if [ "$count" -le {busy_calls} ]; then
  echo "target is busy" >&2
  exit 32
fi
exit 0
"#
            ),
        );
    }

    fn write_always_busy_fake_umount(fake_bin: &Path, log_path: &Path, count_path: &Path) {
        let log_path = quote_shell_arg(log_path.to_str().unwrap());
        let count_path = quote_shell_arg(count_path.to_str().unwrap());
        write_executable(
            &fake_bin.join("umount"),
            &format!(
                r#"#!/bin/sh
set -eu
count=0
if [ -f {count_path} ]; then
  count="$(cat {count_path})"
fi
count=$((count + 1))
printf '%s\n' "$count" > {count_path}
printf 'umount call=%s cwd=%s args=%s\n' "$count" "$(pwd)" "$*" >> {log_path}
echo "target is busy" >&2
exit 32
"#
            ),
        );
    }

    fn write_child_mount_cleanup_fake_umount(
        fake_bin: &Path,
        workspace_dir: &Path,
        log_path: &Path,
        count_path: &Path,
    ) {
        let workspace_dir = quote_shell_arg(workspace_dir.to_str().unwrap());
        let log_path = quote_shell_arg(log_path.to_str().unwrap());
        let count_path = quote_shell_arg(count_path.to_str().unwrap());
        write_executable(
            &fake_bin.join("umount"),
            &format!(
                r#"#!/bin/sh
set -eu
workspace_dir={workspace_dir}
target=$2
printf 'umount target=%s args=%s\n' "$target" "$*" >> {log_path}
if [ "$target" != "$workspace_dir" ]; then
  exit 0
fi
count=0
if [ -f {count_path} ]; then
  count="$(cat {count_path})"
fi
count=$((count + 1))
printf '%s\n' "$count" > {count_path}
if [ "$count" -lt 4 ]; then
  echo "target is busy" >&2
  exit 32
fi
exit 0
"#
            ),
        );
    }

    fn write_trailing_newline_child_mount_fake_umount(
        fake_bin: &Path,
        workspace_dir: &Path,
        expected_child_mount: &Path,
        log_path: &Path,
        count_path: &Path,
        child_unmounted_marker_path: &Path,
    ) {
        let workspace_dir = quote_shell_arg(workspace_dir.to_str().unwrap());
        let expected_child_mount = quote_shell_arg(expected_child_mount.to_str().unwrap());
        let log_path = quote_shell_arg(log_path.to_str().unwrap());
        let count_path = quote_shell_arg(count_path.to_str().unwrap());
        let child_unmounted_marker_path =
            quote_shell_arg(child_unmounted_marker_path.to_str().unwrap());
        write_executable(
            &fake_bin.join("umount"),
            &format!(
                r#"#!/bin/sh
set -eu
workspace_dir={workspace_dir}
expected_child_mount={expected_child_mount}
target=$2
printf 'umount target=%s args=%s\n' "$target" "$*" >> {log_path}
if [ "$target" = "$expected_child_mount" ]; then
  printf unmounted > {child_unmounted_marker_path}
  exit 0
fi
if [ "$target" != "$workspace_dir" ]; then
  echo "unexpected child mount target" >&2
  exit 33
fi
count=0
if [ -f {count_path} ]; then
  count="$(cat {count_path})"
fi
count=$((count + 1))
printf '%s\n' "$count" > {count_path}
if [ -f {child_unmounted_marker_path} ] && [ "$count" -ge 2 ]; then
  exit 0
fi
echo "target is busy" >&2
exit 32
"#
            ),
        );
    }

    fn write_child_mount_failure_parent_success_fake_umount(
        fake_bin: &Path,
        workspace_dir: &Path,
        log_path: &Path,
        count_path: &Path,
    ) {
        let workspace_dir = quote_shell_arg(workspace_dir.to_str().unwrap());
        let log_path = quote_shell_arg(log_path.to_str().unwrap());
        let count_path = quote_shell_arg(count_path.to_str().unwrap());
        write_executable(
            &fake_bin.join("umount"),
            &format!(
                r#"#!/bin/sh
set -eu
workspace_dir={workspace_dir}
target=$2
printf 'umount target=%s args=%s\n' "$target" "$*" >> {log_path}
if [ "$target" != "$workspace_dir" ]; then
  echo "child mount is already gone" >&2
  exit 32
fi
count=0
if [ -f {count_path} ]; then
  count="$(cat {count_path})"
fi
count=$((count + 1))
printf '%s\n' "$count" > {count_path}
if [ "$count" -lt 4 ]; then
  echo "target is busy" >&2
  exit 32
fi
exit 0
"#
            ),
        );
    }

    fn write_mountinfo(path: &Path, lines: &[String]) {
        fs::write(path, format!("{}\n", lines.join("\n"))).unwrap();
    }

    fn mountinfo_line(
        mount_id: u32,
        parent_id: u32,
        mount_dev: &str,
        mount_root: &str,
        mount_point: &Path,
    ) -> String {
        let mount_point = encode_mountinfo_path_for_test(mount_point);
        format!(
            "{mount_id} {parent_id} {mount_dev} {mount_root} {mount_point} rw,relatime - ext4 /dev/vdb rw"
        )
    }

    fn encode_mountinfo_path_for_test(path: &Path) -> String {
        path.display()
            .to_string()
            .replace('\\', "\\134")
            .replace(' ', "\\040")
            .replace('\t', "\\011")
            .replace('\n', "\\012")
    }

    fn run_unmount_script(
        workspace_dir: &Path,
        workspace_device: &Path,
        fake_bin: &Path,
    ) -> Output {
        run_unmount_script_with_mountinfo(workspace_dir, workspace_device, fake_bin, None)
    }

    fn run_unmount_script_with_mountinfo(
        workspace_dir: &Path,
        workspace_device: &Path,
        fake_bin: &Path,
        mountinfo_path: Option<&Path>,
    ) -> Output {
        let workspace_mountinfo_path = quote_shell_arg(
            mountinfo_path
                .unwrap_or(Path::new("/proc/self/mountinfo"))
                .to_str()
                .unwrap(),
        );
        let cmd = format!(
            "workspace_dir={}\nworkspace_device={}\nworkspace_mountinfo_path={}\n{}",
            quote_shell_arg(workspace_dir.to_str().unwrap()),
            quote_shell_arg(workspace_device.to_str().unwrap()),
            workspace_mountinfo_path,
            WORKSPACE_UNMOUNT_SCRIPT
        );
        Command::new("sh")
            .arg("-c")
            .arg(cmd)
            .current_dir(workspace_dir)
            .env("PATH", fake_path_env(fake_bin))
            .output()
            .unwrap()
    }

    #[cfg(target_os = "linux")]
    fn wait_for_child_workspace_cwd(child: &Child, workspace_dir: &Path) {
        let cwd_path = format!("/proc/{}/cwd", child.id());
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if fs::read_link(&cwd_path).ok().as_deref() == Some(workspace_dir) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!(
            "holder process did not enter workspace cwd: pid={} workspace={}",
            child.id(),
            workspace_dir.display()
        );
    }

    #[cfg(target_os = "linux")]
    fn wait_for_child_workspace_fd(child: &Child, workspace_dir: &Path) {
        let fd_dir = format!("/proc/{}/fd", child.id());
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if let Ok(entries) = fs::read_dir(&fd_dir) {
                for entry in entries.flatten() {
                    if fs::read_link(entry.path())
                        .ok()
                        .is_some_and(|path| path.starts_with(workspace_dir))
                    {
                        return;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!(
            "holder process did not keep a workspace fd: pid={} workspace={}",
            child.id(),
            workspace_dir.display()
        );
    }

    #[cfg(target_os = "linux")]
    fn wait_for_child_exit_or_kill(child: &mut Child) -> Option<ExitStatus> {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if let Some(status) = child.try_wait().unwrap() {
                return Some(status);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status);
        }
        let _ = child.kill();
        let _ = child.wait().unwrap();
        None
    }

    #[test]
    fn quote_shell_arg_handles_single_quotes() {
        assert_eq!(quote_shell_arg("/tmp/a'b"), "'/tmp/a'\\''b'");
    }

    #[test]
    fn mount_command_uses_canonical_workspace_and_workspace_device() {
        let cmd = workspace_mount_command();

        assert!(cmd.contains("workspace_dir='/home/user/workspace'"));
        assert!(cmd.contains("workspace_device='/dev/vdb'"));
        assert!(cmd.contains("mount -t ext4 -- \"$workspace_device\" \"$workspace_dir\""));
    }

    #[test]
    fn mount_command_is_idempotent_for_existing_workspace_mount() {
        let cmd = workspace_mount_command();

        assert!(cmd.contains("mountpoint -q -- \"$workspace_dir\""));
        assert!(cmd.contains("mountpoint -x -- \"$workspace_device\""));
        assert!(cmd.contains("[ \"$target_dev\" = \"$workspace_dev\" ]"));
        assert!(cmd.contains("exit 0"));
    }

    #[test]
    fn mount_command_rejects_unrelated_mountpoints_and_symlink_components() {
        let cmd = workspace_mount_command();

        assert!(cmd.contains("refusing to mount workspace drive over existing mountpoint"));
        assert!(cmd.contains("refuse_workspace_symlink_path()"));
        assert!(cmd.contains("refusing to use symlink workspace path component"));
        assert!(cmd.contains("workspace_device_mounted_elsewhere()"));
        assert!(cmd.contains("already mounted outside"));
        assert_eq!(
            cmd.matches("refuse_workspace_symlink_path").count(),
            3,
            "definition plus pre-mount and post-mkdir checks should be present"
        );
    }

    #[test]
    fn mount_command_checks_elsewhere_mount_after_idempotent_path_and_before_mount() {
        let cmd = workspace_mount_command();
        let idempotent_check = cmd
            .find("if mountpoint -q -- \"$workspace_dir\"")
            .expect("canonical mountpoint check");
        let elsewhere_check = cmd
            .find("if workspace_device_mounted_elsewhere")
            .expect("elsewhere device mount check");
        let mkdir = cmd.find("mkdir -p -- \"$workspace_dir\"").expect("mkdir");
        let mount = cmd
            .find("mount -t ext4 -- \"$workspace_device\" \"$workspace_dir\"")
            .expect("mount");

        assert!(
            idempotent_check < elsewhere_check,
            "canonical idempotent mount check must run before elsewhere guard"
        );
        assert!(
            elsewhere_check < mkdir,
            "elsewhere guard must run before creating the workspace directory"
        );
        assert!(
            elsewhere_check < mount,
            "elsewhere guard must run before attempting a new mount"
        );
    }

    #[test]
    fn mount_command_does_not_unmount_or_sync() {
        let cmd = workspace_mount_command();

        assert!(!cmd.contains("umount"));
        assert!(!cmd.contains("\nsync"));
    }

    #[tokio::test]
    async fn workspace_drive_commands_use_operation_specific_timeouts() {
        let sandbox = sandbox_mock::MockSandbox::new("workspace-timeout-test");

        ensure_workspace_drive_mounted(&sandbox, "mount-diagnostic")
            .await
            .unwrap();
        flush_and_unmount_workspace_drive(&sandbox, "unmount-diagnostic")
            .await
            .unwrap();

        let calls = sandbox.exec_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].timeout, WORKSPACE_MOUNT_TIMEOUT);
        assert_eq!(calls[1].timeout, WORKSPACE_UNMOUNT_TIMEOUT);
        assert_eq!(calls[0].sudo, calls[1].sudo);
        assert!(calls[0].sudo);
        assert_eq!(calls[0].output_limits, calls[1].output_limits);
    }

    #[test]
    fn unmount_command_uses_canonical_workspace_and_workspace_device() {
        let cmd = workspace_unmount_command();

        assert!(cmd.contains("workspace_dir='/home/user/workspace'"));
        assert!(cmd.contains("workspace_device='/dev/vdb'"));
        assert!(cmd.contains("workspace_mountinfo_path='/proc/self/mountinfo'"));
        assert!(cmd.contains("sync -f -- \"$workspace_dir\""));
        assert!(cmd.contains("umount -- \"$workspace_dir\""));
        assert_eq!(cmd.matches("umount -- \"$workspace_dir\"").count(), 2);
    }

    #[test]
    fn unmount_script_leaves_workspace_cwd_before_clean_unmount() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        fs::create_dir(&workspace_dir).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_successful_fake_umount(&fake_bin, &log_path);

        let output = run_unmount_script(&workspace_dir, &workspace_device, &fake_bin);
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(
            output.status.success(),
            "stderr={} stdout={}",
            stderr,
            String::from_utf8_lossy(&output.stdout)
        );
        assert!(!stderr.contains("workspace mount diagnostics"));
        let log = fs::read_to_string(log_path).unwrap();
        assert!(log.contains("sync cwd=/ args=-f --"));
        assert!(log.contains("umount cwd=/ args=--"));
        assert!(log.contains(&workspace_dir.display().to_string()));
        assert_eq!(log.matches("umount cwd=").count(), 1);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_terminates_workspace_cwd_holder_before_retry() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        let count_path = temp.path().join("umount-count");
        fs::create_dir(&workspace_dir).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_busy_then_successful_fake_umount(&fake_bin, &log_path, &count_path);

        let mut holder = Command::new("sh")
            .arg("-c")
            .arg("cd \"$1\" && exec sleep 60")
            .arg("holder")
            .arg(&workspace_dir)
            .spawn()
            .unwrap();
        wait_for_child_workspace_cwd(&holder, &workspace_dir);

        let output = run_unmount_script(&workspace_dir, &workspace_device, &fake_bin);
        let holder_status = wait_for_child_exit_or_kill(&mut holder);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success(), "stderr={stderr} stdout={stdout}");
        let holder_status = holder_status
            .unwrap_or_else(|| panic!("holder process was still running: stderr={stderr}"));
        assert!(
            !holder_status.success(),
            "holder should be terminated by signal"
        );
        assert!(stderr.contains("workspace drive unmount failed; diagnosing holders"));
        assert!(stderr.contains("workspace holder: phase=direct"));
        assert!(stderr.contains(&format!("pid={}", holder.id())));
        assert!(stderr.contains("ref=cwd"));
        assert!(stderr.contains("workspace holder cleanup: direct TERM started"));
        assert!(
            stderr
                .contains("workspace holder cleanup: retry umount after direct cleanup succeeded")
        );
        assert!(!stderr.contains("workspace holder cleanup: fd scan started"));
        assert!(!stderr.contains("workspace mount diagnostics"));
        let log = fs::read_to_string(log_path).unwrap();
        assert_eq!(log.matches("umount call=").count(), 2);
        assert!(log.contains("umount call=1 cwd=/ args=--"));
        assert!(log.contains("umount call=2 cwd=/ args=--"));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_terminates_workspace_fd_holder_before_retry() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        let count_path = temp.path().join("umount-count");
        let holder_file = workspace_dir.join("holder-file");
        fs::create_dir(&workspace_dir).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        fs::write(&holder_file, "busy").unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_busy_twice_then_successful_fake_umount(&fake_bin, &log_path, &count_path);

        let mut holder = Command::new("sh")
            .arg("-c")
            .arg("exec 9< \"$1\" && exec sleep 60")
            .arg("holder")
            .arg(&holder_file)
            .spawn()
            .unwrap();
        wait_for_child_workspace_fd(&holder, &workspace_dir);

        let output = run_unmount_script(&workspace_dir, &workspace_device, &fake_bin);
        let holder_status = wait_for_child_exit_or_kill(&mut holder);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success(), "stderr={stderr} stdout={stdout}");
        let holder_status = holder_status
            .unwrap_or_else(|| panic!("holder process was still running: stderr={stderr}"));
        assert!(
            !holder_status.success(),
            "holder should be terminated by signal"
        );
        assert!(stderr.contains("workspace holder cleanup: direct scan started"));
        assert!(stderr.contains("no direct workspace holder processes found"));
        assert!(stderr.contains("workspace holder cleanup: fd scan started"));
        assert!(stderr.contains("workspace holder: phase=fd"));
        assert!(stderr.contains(&format!("pid={}", holder.id())));
        assert!(stderr.contains("ref=fd"));
        assert!(stderr.contains("workspace holder cleanup: fd TERM started"));
        assert!(
            stderr.contains("workspace holder cleanup: retry umount after fd cleanup succeeded")
        );
        assert!(!stderr.contains("workspace mount diagnostics"));
        let log = fs::read_to_string(log_path).unwrap();
        assert_eq!(log.matches("umount call=").count(), 3);
        assert!(log.contains("umount call=1 cwd=/ args=--"));
        assert!(log.contains("umount call=2 cwd=/ args=--"));
        assert!(log.contains("umount call=3 cwd=/ args=--"));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_kills_workspace_cwd_holder_that_ignores_term() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        let count_path = temp.path().join("umount-count");
        fs::create_dir(&workspace_dir).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_busy_twice_then_successful_fake_umount(&fake_bin, &log_path, &count_path);

        let mut holder = Command::new("sh")
            .arg("-c")
            .arg("trap '' TERM; cd \"$1\" && exec sleep 60")
            .arg("holder")
            .arg(&workspace_dir)
            .spawn()
            .unwrap();
        wait_for_child_workspace_cwd(&holder, &workspace_dir);

        let output = run_unmount_script(&workspace_dir, &workspace_device, &fake_bin);
        let holder_status = wait_for_child_exit_or_kill(&mut holder);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success(), "stderr={stderr} stdout={stdout}");
        let holder_status = holder_status
            .unwrap_or_else(|| panic!("holder process was still running: stderr={stderr}"));
        assert!(
            !holder_status.success(),
            "holder should be killed after ignoring TERM"
        );
        assert!(
            stderr.contains("workspace holder cleanup: retry umount after direct cleanup failed")
        );
        assert!(stderr.contains("workspace holder cleanup: direct KILL started"));
        assert!(stderr.contains(
            "workspace holder cleanup: retry umount after direct KILL cleanup succeeded"
        ));
        assert!(stderr.contains(&format!("pid={}", holder.id())));
        let log = fs::read_to_string(log_path).unwrap();
        assert_eq!(log.matches("umount call=").count(), 3);
        assert!(log.contains("umount call=1 cwd=/ args=--"));
        assert!(log.contains("umount call=2 cwd=/ args=--"));
        assert!(log.contains("umount call=3 cwd=/ args=--"));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_reports_no_direct_or_fd_holders_before_slow_maps_scan() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        let count_path = temp.path().join("umount-count");
        fs::create_dir(&workspace_dir).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_always_busy_fake_umount(&fake_bin, &log_path, &count_path);

        let output = run_unmount_script(&workspace_dir, &workspace_device, &fake_bin);
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(!output.status.success(), "stderr={stderr}");
        assert!(stderr.contains("workspace holder cleanup: direct scan started"));
        assert!(stderr.contains("no direct workspace holder processes found"));
        assert!(
            stderr.contains("workspace holder cleanup: retry umount after direct cleanup failed")
        );
        assert!(stderr.contains("workspace holder cleanup: fd scan started"));
        assert!(stderr.contains("no fd workspace holder processes found"));
        assert!(stderr.contains("workspace holder cleanup: retry umount after fd cleanup failed"));
        assert!(stderr.contains("workspace holder cleanup: slow maps scan started"));
        assert!(stderr.contains("no workspace maps holder processes found"));
        assert!(stderr.contains("workspace mount cleanup: child scan started"));
        assert!(stderr.contains("no workspace child mounts found"));
        assert!(
            stderr.contains(
                "workspace holder cleanup: retry umount after child mount cleanup failed"
            )
        );
        assert!(stderr.contains("workspace mount diagnostics: mountinfo scan started"));
        let log = fs::read_to_string(log_path).unwrap();
        assert_eq!(log.matches("umount call=").count(), 4);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_reports_mount_topology_when_process_holders_are_empty() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let child_mount = workspace_dir.join("nested");
        let sibling_mount = temp.path().join("same-device");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        let count_path = temp.path().join("umount-count");
        let mountinfo_path = temp.path().join("mountinfo");
        fs::create_dir_all(&child_mount).unwrap();
        fs::create_dir(&sibling_mount).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_always_busy_fake_umount(&fake_bin, &log_path, &count_path);
        write_mountinfo(
            &mountinfo_path,
            &[
                mountinfo_line(100, 1, "123", "/", &workspace_dir),
                mountinfo_line(101, 100, "456", "/", &child_mount),
                mountinfo_line(102, 1, "123", "/", &sibling_mount),
            ],
        );

        let output = run_unmount_script_with_mountinfo(
            &workspace_dir,
            &workspace_device,
            &fake_bin,
            Some(&mountinfo_path),
        );
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(!output.status.success(), "stderr={stderr}");
        assert!(stderr.contains("workspace holder cleanup: direct scan holder_pid_count=0"));
        assert!(stderr.contains("workspace holder cleanup: fd scan holder_pid_count=0"));
        assert!(stderr.contains("workspace holder cleanup: slow maps scan holder_pid_count=0"));
        assert!(stderr.contains("workspace mount cleanup: child unmount started"));
        assert!(stderr.contains("workspace mount diagnostics: mountinfo scan started"));
        assert!(stderr.contains("workspace mount: category=workspace id=100"));
        assert!(stderr.contains("workspace mount: category=child id=101"));
        assert!(stderr.contains("workspace mount: category=same-device id=102"));
        assert!(stderr.contains("workspace mount diagnostics: mountinfo scan completed"));
        let log = fs::read_to_string(log_path).unwrap();
        assert!(log.contains(&child_mount.display().to_string()));
        assert!(!log.contains(&sibling_mount.display().to_string()));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_unmounts_workspace_child_mounts_before_parent_retry() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let shallow_child = workspace_dir.join("child with space\\040literal\\backslash");
        let deep_child = shallow_child.join("grandchild");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        let count_path = temp.path().join("umount-count");
        let mountinfo_path = temp.path().join("mountinfo");
        fs::create_dir_all(&deep_child).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_child_mount_cleanup_fake_umount(&fake_bin, &workspace_dir, &log_path, &count_path);
        write_mountinfo(
            &mountinfo_path,
            &[
                mountinfo_line(100, 1, "123", "/", &workspace_dir),
                mountinfo_line(101, 100, "456", "/", &shallow_child),
                mountinfo_line(102, 101, "789", "/", &deep_child),
            ],
        );

        let output = run_unmount_script_with_mountinfo(
            &workspace_dir,
            &workspace_device,
            &fake_bin,
            Some(&mountinfo_path),
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success(), "stderr={stderr} stdout={stdout}");
        assert!(stderr.contains("workspace mount cleanup: child scan started"));
        assert!(stderr.contains("workspace mount cleanup: child unmount succeeded"));
        assert!(!stderr.contains("workspace mount diagnostics"));

        let log = fs::read_to_string(log_path).unwrap();
        let mountinfo = fs::read_to_string(&mountinfo_path).unwrap();
        let deep_unmount = log
            .find(&format!("umount target={} ", deep_child.display()))
            .unwrap_or_else(|| {
                panic!(
                    "deep child unmount missing: expected={} mountinfo={mountinfo} log={log}",
                    deep_child.display()
                )
            });
        let shallow_unmount = log
            .find(&format!("umount target={} ", shallow_child.display()))
            .expect("shallow child unmount");
        let final_parent_unmount = log
            .rfind(&format!("umount target={} ", workspace_dir.display()))
            .expect("final parent unmount");
        assert!(
            deep_unmount < shallow_unmount,
            "deeper child mount should unmount before shallower child: {log}"
        );
        assert!(
            shallow_unmount < final_parent_unmount,
            "child mounts should unmount before final parent retry: {log}"
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_preserves_trailing_newline_in_mountinfo_paths() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let child_mount = workspace_dir.join("child\n");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        let count_path = temp.path().join("umount-count");
        let mountinfo_path = temp.path().join("mountinfo");
        let child_unmounted_marker_path = temp.path().join("child-unmounted");
        fs::create_dir_all(&child_mount).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_trailing_newline_child_mount_fake_umount(
            &fake_bin,
            &workspace_dir,
            &child_mount,
            &log_path,
            &count_path,
            &child_unmounted_marker_path,
        );
        write_mountinfo(
            &mountinfo_path,
            &[
                mountinfo_line(100, 1, "123", "/", &workspace_dir),
                mountinfo_line(101, 100, "456", "/", &child_mount),
            ],
        );

        let output = run_unmount_script_with_mountinfo(
            &workspace_dir,
            &workspace_device,
            &fake_bin,
            Some(&mountinfo_path),
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success(), "stderr={stderr} stdout={stdout}");
        assert_eq!(
            fs::read_to_string(child_unmounted_marker_path).unwrap(),
            "unmounted"
        );
        assert!(!stderr.contains("unexpected child mount target"));
        assert!(!stderr.contains("workspace mount diagnostics"));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_sanitizes_control_characters_in_mount_logs() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let child_mount = workspace_dir.join("child\r\u{1b}\\c");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        let count_path = temp.path().join("umount-count");
        let mountinfo_path = temp.path().join("mountinfo");
        fs::create_dir_all(&child_mount).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_child_mount_cleanup_fake_umount(&fake_bin, &workspace_dir, &log_path, &count_path);
        write_mountinfo(
            &mountinfo_path,
            &[
                mountinfo_line(100, 1, "123", "/", &workspace_dir),
                mountinfo_line(101, 100, "456", "/", &child_mount),
            ],
        );

        let output = run_unmount_script_with_mountinfo(
            &workspace_dir,
            &workspace_device,
            &fake_bin,
            Some(&mountinfo_path),
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let expected_log_path = format!("mount={}/child  \\c", workspace_dir.display());

        assert!(output.status.success(), "stderr={stderr} stdout={stdout}");
        assert!(
            !stderr.contains('\r'),
            "stderr should sanitize CR: {stderr:?}"
        );
        assert!(
            !stderr.contains('\u{1b}'),
            "stderr should sanitize ESC: {stderr:?}"
        );
        assert!(
            stderr.contains(&expected_log_path),
            "stderr should preserve printable backslashes without echo truncation: {stderr:?}"
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_skips_child_mounts_with_symlink_components() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let outside_dir = temp.path().join("outside");
        let symlink_path = workspace_dir.join("redirect");
        let unsafe_child_mount = symlink_path.join("child");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        let count_path = temp.path().join("umount-count");
        let mountinfo_path = temp.path().join("mountinfo");
        fs::create_dir(&workspace_dir).unwrap();
        fs::create_dir(&outside_dir).unwrap();
        fs::create_dir(outside_dir.join("child")).unwrap();
        std::os::unix::fs::symlink(&outside_dir, &symlink_path).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_always_busy_fake_umount(&fake_bin, &log_path, &count_path);
        write_mountinfo(
            &mountinfo_path,
            &[
                mountinfo_line(100, 1, "123", "/", &workspace_dir),
                mountinfo_line(101, 100, "456", "/", &unsafe_child_mount),
            ],
        );

        let output = run_unmount_script_with_mountinfo(
            &workspace_dir,
            &workspace_device,
            &fake_bin,
            Some(&mountinfo_path),
        );
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(!output.status.success(), "stderr={stderr}");
        assert!(stderr.contains("workspace mount cleanup: child unmount skipped unsafe path"));
        assert!(!stderr.contains("workspace mount cleanup: child unmount started"));
        let log = fs::read_to_string(log_path).unwrap();
        assert!(!log.contains(&unsafe_child_mount.display().to_string()));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_succeeds_when_child_cleanup_races_with_parent_unmount() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let child_mount = workspace_dir.join("child");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        let count_path = temp.path().join("umount-count");
        let mountinfo_path = temp.path().join("mountinfo");
        fs::create_dir_all(&child_mount).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_child_mount_failure_parent_success_fake_umount(
            &fake_bin,
            &workspace_dir,
            &log_path,
            &count_path,
        );
        write_mountinfo(
            &mountinfo_path,
            &[
                mountinfo_line(100, 1, "123", "/", &workspace_dir),
                mountinfo_line(101, 100, "456", "/", &child_mount),
            ],
        );

        let output = run_unmount_script_with_mountinfo(
            &workspace_dir,
            &workspace_device,
            &fake_bin,
            Some(&mountinfo_path),
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);

        assert!(output.status.success(), "stderr={stderr} stdout={stdout}");
        assert!(stderr.contains("workspace mount cleanup: child unmount failed exit_code=32"));
        assert!(stderr.contains(
            "workspace mount cleanup: parent unmount succeeded after child cleanup failure"
        ));
        assert!(!stderr.contains("workspace mount diagnostics"));
    }

    #[test]
    fn unmount_command_rejects_missing_or_unrelated_mountpoints() {
        let cmd = workspace_unmount_command();

        assert!(cmd.contains("refuse_workspace_symlink_path()"));
        assert!(cmd.contains("refusing to use symlink workspace path component"));
        assert!(cmd.contains("if ! mountpoint -q -- \"$workspace_dir\""));
        assert!(cmd.contains("workspace drive is not mounted"));
        assert!(
            cmd.contains("[ -z \"$workspace_dev\" ] || [ \"$target_dev\" != \"$workspace_dev\" ]")
        );
        assert!(cmd.contains("refusing to unmount non-workspace mountpoint"));
    }

    #[test]
    fn unmount_command_checks_mount_identity_before_sync_unmount_and_cleanup() {
        let cmd = workspace_unmount_command();
        let mountpoint_check = cmd
            .find("if ! mountpoint -q -- \"$workspace_dir\"")
            .expect("mountpoint presence check");
        let identity_check = cmd
            .find("if [ -z \"$workspace_dev\" ] || [ \"$target_dev\" != \"$workspace_dev\" ]")
            .expect("workspace device identity check");
        let leave_workspace_cwd = cmd.find("cd /").expect("leave workspace cwd");
        let sync = cmd.find("sync -f -- \"$workspace_dir\"").expect("sync");
        let unmount = cmd.find("umount -- \"$workspace_dir\"").expect("umount");
        let holder_scan = cmd
            .find("for proc_dir in /proc/[0-9]*")
            .expect("holder scan");
        let kill = cmd.find("kill -TERM").expect("holder kill");

        assert!(
            mountpoint_check < identity_check,
            "mountpoint must exist before comparing device identity"
        );
        assert!(
            identity_check < sync,
            "device identity must be verified before sync"
        );
        assert!(
            identity_check < leave_workspace_cwd,
            "device identity must be verified before leaving cwd"
        );
        assert!(
            leave_workspace_cwd < sync,
            "script must leave a possible workspace cwd before sync"
        );
        assert!(
            leave_workspace_cwd < unmount,
            "script must leave a possible workspace cwd before unmount"
        );
        assert!(
            identity_check < unmount,
            "device identity must be verified before unmount"
        );
        assert!(
            identity_check < holder_scan,
            "device identity must be verified before scanning holders"
        );
        assert!(
            identity_check < kill,
            "device identity must be verified before killing holders"
        );
        assert!(
            unmount < holder_scan,
            "clean unmount must be attempted before scanning holders"
        );
        assert!(
            unmount < kill,
            "clean unmount must be attempted before killing holders"
        );
    }

    #[test]
    fn unmount_command_diagnoses_and_cleans_workspace_holders_before_retry() {
        let cmd = workspace_unmount_command();

        assert!(cmd.contains("scan_workspace_direct_holder_refs()"));
        assert!(cmd.contains("scan_workspace_fd_holder_refs()"));
        assert!(cmd.contains("scan_workspace_maps_holder_refs()"));
        assert!(cmd.contains("scan_workspace_mountinfo_refs()"));
        assert!(cmd.contains("scan_workspace_child_mountpoints()"));
        assert!(cmd.contains("decode_mountinfo_path()"));
        assert!(cmd.contains("decode_mountinfo_path_to_result()"));
        assert!(cmd.contains("is_safe_workspace_child_mountpoint_path()"));
        assert!(cmd.contains("\"\"|\".\"|\"..\") return 1 ;;"));
        assert!(cmd.contains("cleanup_workspace_child_mounts()"));
        assert!(cmd.contains("log_workspace_mount_diagnostics()"));
        assert!(cmd.contains("scan_proc_ref \"$pid\" cwd \"$proc_dir/cwd\""));
        assert!(cmd.contains("scan_proc_ref \"$pid\" root \"$proc_dir/root\""));
        assert!(cmd.contains("scan_proc_ref \"$pid\" exe \"$proc_dir/exe\""));
        assert!(cmd.contains("for fd_ref in \"$proc_dir\"/fd/*"));
        assert!(cmd.contains("scan_proc_maps \"$pid\" \"$proc_dir/maps\""));
        assert!(cmd.contains("\"$workspace_dir\"|\"$workspace_dir\"/*) return 0 ;;"));
        assert!(cmd.contains("stripped_target=${target%\"$deleted_suffix\"}"));
        assert!(cmd.contains("proc_path_has_workspace_ref()"));
        assert!(cmd.contains("proc_maps_has_workspace_ref()"));
        assert!(cmd.contains("pid_has_direct_workspace_ref()"));
        assert!(cmd.contains("pid_has_fd_workspace_ref()"));
        assert!(cmd.contains("pid_has_cleanup_workspace_ref()"));
        assert!(cmd.contains("if proc_path_has_workspace_ref \"$proc_dir/exe\"; then"));
        assert!(cmd.contains("if proc_maps_has_workspace_ref \"$proc_dir/maps\"; then"));
        assert!(cmd.contains("WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT=40"));
        assert!(cmd.contains("WORKSPACE_HOLDER_MAPS_LINE_LIMIT=4096"));
        assert!(cmd.contains("WORKSPACE_HOLDER_VALUE_LIMIT=240"));
        assert!(cmd.contains("WORKSPACE_HOLDER_KILL_GRACE_SECONDS=1"));
        assert!(cmd.contains("WORKSPACE_MOUNT_DIAGNOSTIC_LIMIT=40"));
        assert!(cmd.contains(
            "workspace_mountinfo_path=${workspace_mountinfo_path:-/proc/self/mountinfo}"
        ));
        assert!(cmd.contains("wait_for_workspace_holder_records_to_clear()"));
        assert!(cmd.contains("holder_records_have_workspace_ref()"));
        assert!(cmd.contains("diagnostics truncated after $WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT"));
        assert!(cmd.contains(
            "workspace mount diagnostics truncated after $WORKSPACE_MOUNT_DIAGNOSTIC_LIMIT"
        ));
        assert!(cmd.contains("workspace holder cleanup: direct scan started"));
        assert!(cmd.contains("workspace holder cleanup: direct TERM started"));
        assert!(cmd.contains("workspace holder cleanup: direct KILL started"));
        assert!(cmd.contains("workspace holder cleanup: fd scan started"));
        assert!(cmd.contains("workspace holder cleanup: fd TERM started"));
        assert!(cmd.contains("workspace holder cleanup: fd KILL started"));
        assert!(cmd.contains("workspace holder cleanup: slow maps scan started"));
        assert!(cmd.contains("workspace holder cleanup: maps KILL started"));
        assert!(cmd.contains("workspace mount cleanup: child scan started"));
        assert!(cmd.contains("workspace mount cleanup: child unmount started"));
        assert!(cmd.contains("workspace mount cleanup: child unmount skipped unsafe path"));
        assert!(cmd.contains("workspace mount diagnostics: mountinfo scan started"));
        assert!(cmd.contains("pid=%s uid=%s comm=%s ref=%s path=%s"));
        assert!(cmd.contains(
            "workspace mount: category=%s id=%s parent=%s dev=%s root=%s mount=%s options=%s"
        ));
        assert!(cmd.contains("comm=\"$(sanitize_log_value \"$comm\")\""));
        assert!(cmd.contains("target=\"$(sanitize_log_value \"$target\")\""));
        assert!(cmd.contains("pid_has_cleanup_workspace_ref \"$pid\" \"$ref_mode\" || continue"));
        assert!(cmd.contains("[ \"$pid\" != \"$$\" ] || return 1"));
        assert!(cmd.contains("[ \"$pid\" != \"1\" ] || return 1"));
        assert!(!cmd.contains("workspace_fast_holder_pids()"));
        assert!(!cmd.contains("wait_for_fast_workspace_holders_to_clear()"));

        let clean_unmount = cmd
            .find("if umount -- \"$workspace_dir\"")
            .expect("clean unmount");
        let direct_scan = cmd
            .find("scan_workspace_direct_holder_refs | collect_and_log_workspace_holders")
            .expect("direct holder scan");
        let direct_term = cmd
            .find("term_workspace_holder_record_pids \"$direct_holder_records\" direct")
            .expect("direct TERM holders");
        let direct_term_wait = cmd
            .find(
                "wait_for_workspace_holder_records_to_clear \"$direct_holder_records\" direct \"$WORKSPACE_HOLDER_TERM_GRACE_SECONDS\"",
            )
            .expect("direct TERM holder wait");
        let direct_term_retry = cmd
            .find("retry_workspace_unmount \"direct cleanup\"")
            .expect("direct TERM retry unmount");
        let direct_rescan = cmd
            .find("scan_workspace_direct_holder_refs | collect_and_log_workspace_holders \"$remaining_direct_holder_records\"")
            .expect("direct holder rescan");
        let direct_kill = cmd
            .find("kill_workspace_holder_record_pids \"$remaining_direct_holder_records\" direct")
            .expect("direct KILL remaining holders");
        let direct_kill_wait = find_after(
            &cmd,
            "wait_for_workspace_holder_records_to_clear \"$remaining_direct_holder_records\" direct \"$WORKSPACE_HOLDER_KILL_GRACE_SECONDS\"",
            direct_kill,
        );
        let direct_kill_retry = find_after(
            &cmd,
            "retry_workspace_unmount \"direct KILL cleanup\"",
            direct_kill_wait,
        );
        let fd_scan = find_after(
            &cmd,
            "scan_workspace_fd_holder_refs | collect_and_log_workspace_holders",
            direct_kill_retry,
        );
        let fd_term = find_after(
            &cmd,
            "term_workspace_holder_record_pids \"$fd_holder_records\" fd",
            fd_scan,
        );
        let fd_term_wait = find_after(
            &cmd,
            "wait_for_workspace_holder_records_to_clear \"$fd_holder_records\" fd \"$WORKSPACE_HOLDER_TERM_GRACE_SECONDS\"",
            fd_term,
        );
        let fd_term_retry =
            find_after(&cmd, "retry_workspace_unmount \"fd cleanup\"", fd_term_wait);
        let fd_rescan = find_after(
            &cmd,
            "scan_workspace_fd_holder_refs | collect_and_log_workspace_holders \"$remaining_fd_holder_records\"",
            fd_term_retry,
        );
        let fd_kill = find_after(
            &cmd,
            "kill_workspace_holder_record_pids \"$remaining_fd_holder_records\" fd",
            fd_rescan,
        );
        let fd_kill_wait = find_after(
            &cmd,
            "wait_for_workspace_holder_records_to_clear \"$remaining_fd_holder_records\" fd \"$WORKSPACE_HOLDER_KILL_GRACE_SECONDS\"",
            fd_kill,
        );
        let fd_kill_retry = find_after(
            &cmd,
            "retry_workspace_unmount \"fd KILL cleanup\"",
            fd_kill_wait,
        );
        let maps_scan = find_after(
            &cmd,
            "scan_workspace_maps_holder_refs | collect_and_log_workspace_holders",
            fd_kill_retry,
        );
        let maps_kill = find_after(
            &cmd,
            "kill_workspace_holder_record_pids \"$maps_holder_records\" maps",
            maps_scan,
        );
        let maps_wait = find_after(
            &cmd,
            "wait_for_workspace_holder_records_to_clear \"$maps_holder_records\" maps \"$WORKSPACE_HOLDER_KILL_GRACE_SECONDS\"",
            maps_kill,
        );
        let child_scan = find_after(
            &cmd,
            "echo \"workspace mount cleanup: child scan started\"",
            maps_wait,
        );
        let child_cleanup = find_after(&cmd, "cleanup_workspace_child_mounts", child_scan);
        let child_retry = find_after(
            &cmd,
            "retry_workspace_unmount \"child mount cleanup\"",
            child_cleanup,
        );
        let mount_diagnostics = find_after(&cmd, "log_workspace_mount_diagnostics", child_retry);

        assert!(
            clean_unmount < direct_scan,
            "direct holder diagnosis must only happen after clean unmount fails"
        );
        assert!(
            direct_scan < direct_term,
            "direct holders must be diagnosed before TERM"
        );
        assert!(
            direct_term < direct_term_wait,
            "direct TERM must wait for holder refs to clear"
        );
        assert!(
            direct_term_wait < direct_term_retry,
            "direct TERM wait must precede retry unmount"
        );
        assert!(
            direct_term_retry < direct_rescan,
            "direct holders must be rescanned only after TERM retry fails"
        );
        assert!(
            direct_rescan < direct_kill,
            "direct KILL must only target holders confirmed by the rescan"
        );
        assert!(
            direct_kill < direct_kill_wait,
            "direct KILL must wait for holder refs to clear before retry sync"
        );
        assert!(
            direct_kill_wait < direct_kill_retry,
            "direct KILL wait must happen before KILL retry unmount"
        );
        assert!(
            direct_kill_retry < fd_scan,
            "fd scan must run only after direct TERM/KILL retries"
        );
        assert!(
            fd_scan < fd_term,
            "fd holders must be diagnosed before TERM"
        );
        assert!(
            fd_term < fd_term_wait,
            "fd TERM must wait for holder refs to clear"
        );
        assert!(
            fd_term_wait < fd_term_retry,
            "fd TERM wait must precede retry unmount"
        );
        assert!(
            fd_term_retry < fd_rescan,
            "fd holders must be rescanned only after TERM retry fails"
        );
        assert!(
            fd_rescan < fd_kill,
            "fd KILL must only target holders confirmed by the rescan"
        );
        assert!(
            fd_kill < fd_kill_wait,
            "fd KILL must wait for holder refs to clear before retry sync"
        );
        assert!(
            fd_kill_wait < fd_kill_retry,
            "fd KILL wait must happen before KILL retry unmount"
        );
        assert!(
            fd_kill_retry < maps_scan,
            "slow maps scan must run after direct and fd retries"
        );
        assert!(
            maps_kill < maps_wait,
            "maps KILL must wait for maps refs to clear"
        );
        assert!(
            maps_wait < child_scan,
            "maps wait must happen before child mount cleanup"
        );
        assert!(
            child_scan < child_cleanup,
            "child mount cleanup must start after the maps cleanup phase"
        );
        assert!(
            child_cleanup < child_retry,
            "child mounts must be cleaned before the final parent retry"
        );
        assert!(
            child_retry < mount_diagnostics,
            "mount diagnostics should only run after the final parent retry fails"
        );
    }

    #[test]
    fn unmount_command_avoids_lazy_unmount_and_broad_cleanup() {
        let cmd = workspace_unmount_command();

        assert!(!cmd.contains("umount -l"));
        assert!(!cmd.contains("umount -f"));
        assert!(!cmd.contains("pkill"));
        assert!(!cmd.contains("killall"));
        assert!(!cmd.contains("cmdline"));
        assert!(!cmd.contains("environ"));
    }
}
