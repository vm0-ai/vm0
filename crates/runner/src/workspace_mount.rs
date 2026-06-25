use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};
use shell_quote::quote_shell_arg;

use crate::error::{RunnerError, RunnerResult};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};

const WORKSPACE_MOUNT_TIMEOUT: Duration = Duration::from_secs(30);
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
    )
    .await
}

async fn run_workspace_drive_command(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
    cmd: &str,
    operation: &'static str,
    label: &'static str,
) -> RunnerResult<()> {
    let result = sandbox
        .exec_with_diagnostic_label(
            &ExecRequest {
                cmd,
                timeout: WORKSPACE_MOUNT_TIMEOUT,
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
    format!(
        "workspace_dir={workspace_dir}\nworkspace_device={workspace_device}\n{WORKSPACE_UNMOUNT_SCRIPT}"
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

    fn run_unmount_script(
        workspace_dir: &Path,
        workspace_device: &Path,
        fake_bin: &Path,
    ) -> Output {
        let cmd = format!(
            "workspace_dir={}\nworkspace_device={}\n{}",
            quote_shell_arg(workspace_dir.to_str().unwrap()),
            quote_shell_arg(workspace_device.to_str().unwrap()),
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

    #[test]
    fn unmount_command_uses_canonical_workspace_and_workspace_device() {
        let cmd = workspace_unmount_command();

        assert!(cmd.contains("workspace_dir='/home/user/workspace'"));
        assert!(cmd.contains("workspace_device='/dev/vdb'"));
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

        assert!(
            output.status.success(),
            "stderr={} stdout={}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
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
        assert!(stderr.contains("workspace holder: phase=fast"));
        assert!(stderr.contains(&format!("pid={}", holder.id())));
        assert!(stderr.contains("ref=cwd"));
        assert!(stderr.contains("workspace holder cleanup: TERM started"));
        assert!(
            stderr.contains("workspace holder cleanup: retry umount after fast cleanup succeeded")
        );
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
        write_busy_then_successful_fake_umount(&fake_bin, &log_path, &count_path);

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
        assert!(stderr.contains("workspace holder: phase=fast"));
        assert!(stderr.contains(&format!("pid={}", holder.id())));
        assert!(stderr.contains("ref=fd"));
        assert!(stderr.contains("workspace holder cleanup: TERM started"));
        assert!(
            stderr.contains("workspace holder cleanup: retry umount after fast cleanup succeeded")
        );
        let log = fs::read_to_string(log_path).unwrap();
        assert_eq!(log.matches("umount call=").count(), 2);
        assert!(log.contains("umount call=1 cwd=/ args=--"));
        assert!(log.contains("umount call=2 cwd=/ args=--"));
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
            stderr.contains("workspace holder cleanup: retry umount after fast cleanup failed")
        );
        assert!(stderr.contains("workspace holder cleanup: KILL started"));
        assert!(
            stderr.contains(
                "workspace holder cleanup: retry umount after fast KILL cleanup succeeded"
            )
        );
        assert!(stderr.contains(&format!("pid={}", holder.id())));
        let log = fs::read_to_string(log_path).unwrap();
        assert_eq!(log.matches("umount call=").count(), 3);
        assert!(log.contains("umount call=1 cwd=/ args=--"));
        assert!(log.contains("umount call=2 cwd=/ args=--"));
        assert!(log.contains("umount call=3 cwd=/ args=--"));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_reports_no_fast_holders_before_slow_maps_scan() {
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
        assert!(stderr.contains("workspace holder cleanup: fast scan started"));
        assert!(stderr.contains("no fast workspace holder processes found"));
        assert!(
            stderr.contains("workspace holder cleanup: retry umount after fast cleanup failed")
        );
        assert!(stderr.contains("workspace holder cleanup: slow maps scan started"));
        assert!(stderr.contains("no workspace maps holder processes found"));
        assert!(
            stderr.contains(
                "workspace holder cleanup: retry umount after slow maps diagnostics failed"
            )
        );
        let log = fs::read_to_string(log_path).unwrap();
        assert_eq!(log.matches("umount call=").count(), 3);
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

        assert!(cmd.contains("scan_workspace_fast_holder_refs()"));
        assert!(cmd.contains("scan_workspace_maps_holder_refs()"));
        assert!(cmd.contains("scan_proc_ref \"$pid\" cwd \"$proc_dir/cwd\""));
        assert!(cmd.contains("scan_proc_ref \"$pid\" root \"$proc_dir/root\""));
        assert!(cmd.contains("scan_proc_ref \"$pid\" exe \"$proc_dir/exe\""));
        assert!(cmd.contains("for fd_ref in \"$proc_dir\"/fd/*"));
        assert!(cmd.contains("scan_proc_maps \"$pid\" \"$proc_dir/maps\""));
        assert!(cmd.contains("\"$workspace_dir\"|\"$workspace_dir\"/*) return 0 ;;"));
        assert!(cmd.contains("stripped_target=${target%\"$deleted_suffix\"}"));
        assert!(cmd.contains("proc_path_has_workspace_ref()"));
        assert!(cmd.contains("proc_maps_has_workspace_ref()"));
        assert!(cmd.contains("if pid_has_fast_workspace_ref \"$pid\"; then"));
        assert!(cmd.contains("if proc_path_has_workspace_ref \"$proc_dir/exe\"; then"));
        assert!(cmd.contains("if proc_maps_has_workspace_ref \"$proc_dir/maps\"; then"));
        assert!(cmd.contains("WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT=40"));
        assert!(cmd.contains("WORKSPACE_HOLDER_MAPS_LINE_LIMIT=4096"));
        assert!(cmd.contains("WORKSPACE_HOLDER_VALUE_LIMIT=240"));
        assert!(cmd.contains("WORKSPACE_HOLDER_KILL_GRACE_SECONDS=1"));
        assert!(cmd.contains("wait_for_fast_workspace_holders_to_clear()"));
        assert!(cmd.contains("wait_for_maps_workspace_holders_to_clear()"));
        assert!(cmd.contains("diagnostics truncated after $WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT"));
        assert!(cmd.contains("workspace holder cleanup: fast scan started"));
        assert!(cmd.contains("workspace holder cleanup: TERM started"));
        assert!(cmd.contains("workspace holder cleanup: KILL started"));
        assert!(cmd.contains("workspace holder cleanup: slow maps scan started"));
        assert!(cmd.contains("workspace holder cleanup: maps KILL started"));
        assert!(cmd.contains("pid=%s uid=%s comm=%s ref=%s path=%s"));
        assert!(cmd.contains("comm=\"$(sanitize_log_value \"$comm\")\""));
        assert!(cmd.contains("target=\"$(sanitize_log_value \"$target\")\""));
        assert!(cmd.contains("pid_has_fast_workspace_ref \"$pid\" || continue"));
        assert!(cmd.contains("pid_has_maps_workspace_ref \"$pid\" || continue"));
        assert!(cmd.contains("[ \"$pid\" != \"$$\" ] || continue"));
        assert!(cmd.contains("[ \"$pid\" != \"1\" ] || continue"));

        let clean_unmount = cmd
            .find("if umount -- \"$workspace_dir\"")
            .expect("clean unmount");
        let fast_scan = cmd
            .find("scan_workspace_fast_holder_refs | collect_and_log_workspace_holders")
            .expect("fast holder scan");
        let term = cmd
            .find("term_workspace_holder_record_pids \"$holder_records\"")
            .expect("TERM holders");
        let term_wait = cmd
            .find(
                "wait_for_fast_workspace_holders_to_clear \"$WORKSPACE_HOLDER_TERM_GRACE_SECONDS\"",
            )
            .expect("TERM holder wait");
        let term_retry = cmd
            .find("retry_workspace_unmount \"fast cleanup\"")
            .expect("TERM retry unmount");
        let rescan = cmd
            .find("scan_workspace_fast_holder_refs | collect_and_log_workspace_holders \"$remaining_holder_records\"")
            .expect("holder rescan");
        let kill = cmd
            .find("kill_workspace_holder_record_pids \"$remaining_holder_records\" fast")
            .expect("KILL remaining holders");
        let kill_wait = find_after(
            &cmd,
            "wait_for_fast_workspace_holders_to_clear \"$WORKSPACE_HOLDER_KILL_GRACE_SECONDS\"",
            kill,
        );
        let kill_retry = find_after(
            &cmd,
            "retry_workspace_unmount \"fast KILL cleanup\"",
            kill_wait,
        );
        let maps_scan = find_after(
            &cmd,
            "scan_workspace_maps_holder_refs | collect_and_log_workspace_holders",
            kill_retry,
        );
        let maps_kill = find_after(
            &cmd,
            "kill_workspace_holder_record_pids \"$maps_holder_records\" maps",
            maps_scan,
        );
        let maps_wait = find_after(
            &cmd,
            "wait_for_maps_workspace_holders_to_clear \"$maps_holder_records\" \"$WORKSPACE_HOLDER_KILL_GRACE_SECONDS\"",
            maps_kill,
        );
        let maps_retry = find_after(
            &cmd,
            "retry_workspace_unmount \"slow maps diagnostics\"",
            maps_wait,
        );

        assert!(
            clean_unmount < fast_scan,
            "fast holder diagnosis must only happen after clean unmount fails"
        );
        assert!(fast_scan < term, "holders must be diagnosed before TERM");
        assert!(term < term_wait, "TERM must wait for holder refs to clear");
        assert!(
            term_wait < term_retry,
            "TERM wait must precede retry unmount"
        );
        assert!(
            term_retry < rescan,
            "holders must be rescanned only after TERM retry fails"
        );
        assert!(
            rescan < kill,
            "KILL must only target holders confirmed by the rescan"
        );
        assert!(
            kill < kill_wait,
            "KILL must wait for holder refs to clear before retry sync"
        );
        assert!(
            kill_wait < kill_retry,
            "KILL wait must happen before KILL retry unmount"
        );
        assert!(
            kill_retry < maps_scan,
            "slow maps scan must run after fast TERM/KILL retries"
        );
        assert!(
            maps_kill < maps_wait,
            "maps KILL must wait for maps refs to clear"
        );
        assert!(
            maps_wait < maps_retry,
            "maps wait must happen before final retry unmount"
        );
    }

    #[test]
    fn unmount_command_avoids_lazy_unmount_and_broad_cleanup() {
        let cmd = workspace_unmount_command();

        assert!(!cmd.contains("umount -l"));
        assert!(!cmd.contains("pkill"));
        assert!(!cmd.contains("killall"));
        assert!(!cmd.contains("cmdline"));
        assert!(!cmd.contains("environ"));
    }
}
