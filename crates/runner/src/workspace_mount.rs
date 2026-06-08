use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};

use crate::error::{RunnerError, RunnerResult};

const WORKSPACE_MOUNT_TIMEOUT: Duration = Duration::from_secs(30);
const WORKSPACE_DEVICE: &str = "/dev/vdb";
const WORKSPACE_MOUNT_SCRIPT: &str = include_str!("../scripts/mount-workspace-drive.sh");
const WORKSPACE_UNMOUNT_SCRIPT: &str = include_str!("../scripts/unmount-workspace-drive.sh");

pub(crate) async fn ensure_workspace_drive_mounted(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
) -> RunnerResult<()> {
    let cmd = workspace_mount_command();
    run_workspace_drive_command(sandbox, diagnostic_id, &cmd, "mount workspace drive").await
}

pub(crate) async fn flush_and_unmount_workspace_drive(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
) -> RunnerResult<()> {
    let cmd = workspace_unmount_command();
    run_workspace_drive_command(sandbox, diagnostic_id, &cmd, "unmount workspace drive").await
}

async fn run_workspace_drive_command(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
    cmd: &str,
    operation: &'static str,
) -> RunnerResult<()> {
    let result = sandbox
        .exec(&ExecRequest {
            cmd,
            timeout: WORKSPACE_MOUNT_TIMEOUT,
            env: &[],
            sudo: true,
            stdin_bytes: None,
            output_limits: EXEC_OUTPUT_LIMIT_64_KIB,
        })
        .await
        .map_err(RunnerError::from)?;
    if result.exit_code == 0 {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&result.stderr);
    let stdout = String::from_utf8_lossy(&result.stdout);
    Err(RunnerError::Internal(format!(
        "{operation} failed for {diagnostic_id} with exit code {}: stderr={} stdout={}",
        result.exit_code,
        stderr.trim(),
        stdout.trim()
    )))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn workspace_mount_command() -> String {
    let workspace_dir = shell_quote(CANONICAL_WORKING_DIR);
    let workspace_device = shell_quote(WORKSPACE_DEVICE);
    format!(
        "workspace_dir={workspace_dir}\nworkspace_device={workspace_device}\n{WORKSPACE_MOUNT_SCRIPT}"
    )
}

fn workspace_unmount_command() -> String {
    let workspace_dir = shell_quote(CANONICAL_WORKING_DIR);
    let workspace_device = shell_quote(WORKSPACE_DEVICE);
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
        let workspace_dir = shell_quote(workspace_dir.to_str().unwrap());
        let workspace_device = shell_quote(workspace_device.to_str().unwrap());
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
        let log_path = shell_quote(log_path.to_str().unwrap());
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
        let log_path = shell_quote(log_path.to_str().unwrap());
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
        let log_path = shell_quote(log_path.to_str().unwrap());
        let count_path = shell_quote(count_path.to_str().unwrap());
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
if [ "$count" -eq 1 ]; then
  echo "target is busy" >&2
  exit 32
fi
exit 0
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
            shell_quote(workspace_dir.to_str().unwrap()),
            shell_quote(workspace_device.to_str().unwrap()),
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
    fn wait_for_child_workspace_exe(child: &Child, workspace_dir: &Path) {
        let exe_path = format!("/proc/{}/exe", child.id());
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if fs::read_link(&exe_path)
                .ok()
                .is_some_and(|path| path.starts_with(workspace_dir))
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!(
            "holder process did not execute from workspace: pid={} workspace={}",
            child.id(),
            workspace_dir.display()
        );
    }

    #[cfg(target_os = "linux")]
    fn sleep_binary_path() -> &'static str {
        for candidate in ["/bin/sleep", "/usr/bin/sleep"] {
            if Path::new(candidate).is_file() {
                return candidate;
            }
        }
        panic!("sleep binary not found");
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
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("/tmp/a'b"), "'/tmp/a'\\''b'");
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
        assert!(stderr.contains("workspace holder:"));
        assert!(stderr.contains(&format!("pid={}", holder.id())));
        assert!(stderr.contains("ref=cwd"));
        let log = fs::read_to_string(log_path).unwrap();
        assert_eq!(log.matches("umount call=").count(), 2);
        assert!(log.contains("umount call=1 cwd=/ args=--"));
        assert!(log.contains("umount call=2 cwd=/ args=--"));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn unmount_script_terminates_workspace_exe_holder_before_retry() {
        let temp = tempfile::tempdir().unwrap();
        let workspace_dir = temp.path().join("workspace");
        let workspace_device = temp.path().join("vdb");
        let fake_bin = temp.path().join("bin");
        let log_path = temp.path().join("calls.log");
        let count_path = temp.path().join("umount-count");
        let holder_bin = workspace_dir.join("holder-sleep");
        fs::create_dir(&workspace_dir).unwrap();
        fs::create_dir(&fake_bin).unwrap();
        fs::copy(sleep_binary_path(), &holder_bin).unwrap();
        let mut permissions = fs::metadata(&holder_bin).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&holder_bin, permissions).unwrap();
        write_fake_mountpoint(&fake_bin, &workspace_dir, &workspace_device);
        write_fake_sync(&fake_bin, &log_path);
        write_busy_then_successful_fake_umount(&fake_bin, &log_path, &count_path);

        let mut holder = Command::new(&holder_bin)
            .arg("60")
            .current_dir(temp.path())
            .spawn()
            .unwrap();
        wait_for_child_workspace_exe(&holder, &workspace_dir);

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
        assert!(stderr.contains("workspace holder:"));
        assert!(stderr.contains(&format!("pid={}", holder.id())));
        assert!(stderr.contains("ref=exe"));
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
        write_busy_then_successful_fake_umount(&fake_bin, &log_path, &count_path);

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
        assert!(stderr.contains("workspace holders remain after TERM; sending KILL"));
        assert!(stderr.contains(&format!("pid={}", holder.id())));
        let log = fs::read_to_string(log_path).unwrap();
        assert_eq!(log.matches("umount call=").count(), 2);
        assert!(log.contains("umount call=1 cwd=/ args=--"));
        assert!(log.contains("umount call=2 cwd=/ args=--"));
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

        assert!(cmd.contains("scan_proc_ref \"$pid\" cwd \"$proc_dir/cwd\""));
        assert!(cmd.contains("scan_proc_ref \"$pid\" root \"$proc_dir/root\""));
        assert!(cmd.contains("scan_proc_ref \"$pid\" exe \"$proc_dir/exe\""));
        assert!(cmd.contains("for fd_ref in \"$proc_dir\"/fd/*"));
        assert!(cmd.contains("scan_proc_maps \"$pid\" \"$proc_dir/maps\""));
        assert!(cmd.contains("\"$workspace_dir\"|\"$workspace_dir\"/*) return 0 ;;"));
        assert!(cmd.contains("stripped_target=${target%\"$deleted_suffix\"}"));
        assert!(cmd.contains("proc_path_has_workspace_ref()"));
        assert!(cmd.contains("proc_maps_has_workspace_ref()"));
        assert!(cmd.contains("if pid_has_workspace_ref \"$pid\"; then"));
        assert!(cmd.contains("if proc_path_has_workspace_ref \"$proc_dir/exe\"; then"));
        assert!(cmd.contains("if proc_maps_has_workspace_ref \"$proc_dir/maps\"; then"));
        assert!(cmd.contains("WORKSPACE_HOLDER_DIAGNOSTIC_LIMIT=40"));
        assert!(cmd.contains("WORKSPACE_HOLDER_VALUE_LIMIT=240"));
        assert!(cmd.contains("WORKSPACE_HOLDER_KILL_GRACE_SECONDS=1"));
        assert!(cmd.contains("workspace holder diagnostics truncated"));
        assert!(cmd.contains("pid=%s uid=%s comm=%s ref=%s path=%s"));
        assert!(cmd.contains("comm=\"$(sanitize_log_value \"$comm\")\""));
        assert!(cmd.contains("target=\"$(sanitize_log_value \"$target\")\""));
        assert!(cmd.contains("pid_has_workspace_ref \"$pid\" || continue"));
        assert!(cmd.contains("[ \"$pid\" != \"$$\" ] || continue"));
        assert!(cmd.contains("[ \"$pid\" != \"1\" ] || continue"));

        let clean_unmount = cmd
            .find("if umount -- \"$workspace_dir\"")
            .expect("clean unmount");
        let diagnose = cmd
            .find("holder_pids=\"$(workspace_holder_pids)\"")
            .expect("holder pid collection");
        let term = cmd
            .find("term_workspace_holder_pids \"$holder_pids\"")
            .expect("TERM holders");
        let rescan = cmd
            .find("remaining_holder_pids=\"$(workspace_holder_pids)\"")
            .expect("holder rescan");
        let kill = cmd
            .find("kill_workspace_holder_pids \"$remaining_holder_pids\"")
            .expect("KILL remaining holders");
        let kill_sleep = find_after(&cmd, "sleep \"$WORKSPACE_HOLDER_KILL_GRACE_SECONDS\"", kill);
        let retry_sync = find_after(&cmd, "sync -f -- \"$workspace_dir\"", kill_sleep);
        let retry_unmount = find_after(&cmd, "umount -- \"$workspace_dir\"", retry_sync);

        assert!(
            clean_unmount < diagnose,
            "holder diagnosis must only happen after clean unmount fails"
        );
        assert!(diagnose < term, "holders must be diagnosed before TERM");
        assert!(term < rescan, "holders must be rescanned after TERM");
        assert!(
            rescan < kill,
            "KILL must only target holders confirmed by the rescan"
        );
        assert!(kill < retry_sync, "cleanup must happen before retry sync");
        assert!(
            kill < kill_sleep,
            "KILL must have a short grace period before retry sync"
        );
        assert!(
            retry_sync < retry_unmount,
            "retry sync must happen before retry unmount"
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
