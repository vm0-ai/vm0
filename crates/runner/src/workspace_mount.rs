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
    fn unmount_command_checks_mount_identity_before_sync_and_unmount() {
        let cmd = workspace_unmount_command();
        let mountpoint_check = cmd
            .find("if ! mountpoint -q -- \"$workspace_dir\"")
            .expect("mountpoint presence check");
        let identity_check = cmd
            .find("if [ -z \"$workspace_dev\" ] || [ \"$target_dev\" != \"$workspace_dev\" ]")
            .expect("workspace device identity check");
        let sync = cmd.find("sync -f -- \"$workspace_dir\"").expect("sync");
        let unmount = cmd.find("umount -- \"$workspace_dir\"").expect("umount");

        assert!(
            mountpoint_check < identity_check,
            "mountpoint must exist before comparing device identity"
        );
        assert!(
            identity_check < sync,
            "device identity must be verified before sync"
        );
        assert!(
            identity_check < unmount,
            "device identity must be verified before unmount"
        );
    }
}
