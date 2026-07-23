//! Workspace drive mount and terminal freeze boundaries.
//!
//! The mount helper accepts an existing mount only when the canonical
//! workspace path is already backed by `/dev/vdb`. It rejects symlink path
//! components, unrelated mountpoints, and a workspace device mounted elsewhere.
//!
//! Workspace image promotion uses the freeze helper as a terminal consistency
//! boundary. The helper verifies the same path and device identity before it
//! freezes ext4, flushing completed writes and blocking further modifications.
//! A sandbox that crosses this boundary must be stopped and destroyed; it must
//! never be thawed or returned to the idle pool.

use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};
use shell_quote::quote_shell_arg;

use crate::error::{RunnerError, RunnerResult};
use crate::helper_exec::{format_helper_exec_failure, helper_exec_succeeded};

pub(crate) const WORKSPACE_MOUNT_TIMEOUT: Duration = Duration::from_secs(30);
const WORKSPACE_FREEZE_TIMEOUT: Duration = Duration::from_secs(30);
const WORKSPACE_DEVICE: &str = "/dev/vdb";
const WORKSPACE_MOUNT_SCRIPT: &str = include_str!("../scripts/mount-workspace-drive.sh");
const WORKSPACE_FREEZE_SCRIPT: &str = include_str!("../scripts/freeze-workspace-drive.sh");

pub(crate) async fn ensure_workspace_drive_mounted(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
) -> RunnerResult<()> {
    run_workspace_drive_command(
        sandbox,
        diagnostic_id,
        &workspace_mount_command(),
        "mount workspace drive",
        "workspace-mount",
        WORKSPACE_MOUNT_TIMEOUT,
    )
    .await
}

pub(crate) async fn freeze_workspace_drive(
    sandbox: &dyn Sandbox,
    diagnostic_id: impl std::fmt::Display,
) -> RunnerResult<()> {
    run_workspace_drive_command(
        sandbox,
        diagnostic_id,
        &workspace_freeze_command(),
        "freeze workspace drive",
        "workspace-freeze",
        WORKSPACE_FREEZE_TIMEOUT,
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
                expected_exit_codes: &[],
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

pub(crate) fn workspace_mount_command() -> String {
    workspace_command(WORKSPACE_MOUNT_SCRIPT)
}

fn workspace_freeze_command() -> String {
    workspace_command(WORKSPACE_FREEZE_SCRIPT)
}

fn workspace_command(script: &str) -> String {
    let workspace_dir = quote_shell_arg(CANONICAL_WORKING_DIR);
    let workspace_device = quote_shell_arg(WORKSPACE_DEVICE);
    format!("workspace_dir={workspace_dir}\nworkspace_device={workspace_device}\n{script}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_shell_arg_handles_single_quotes() {
        assert_eq!(quote_shell_arg("/tmp/a'b"), "'/tmp/a'\\''b'");
    }

    #[tokio::test]
    async fn workspace_drive_operations_use_bounded_privileged_exec() {
        let sandbox = sandbox_mock::MockSandbox::new("workspace-boundary-test");

        ensure_workspace_drive_mounted(&sandbox, "mount-diagnostic")
            .await
            .unwrap();
        freeze_workspace_drive(&sandbox, "freeze-diagnostic")
            .await
            .unwrap();

        let calls = sandbox.exec_calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].timeout, WORKSPACE_MOUNT_TIMEOUT);
        assert_eq!(calls[1].timeout, WORKSPACE_FREEZE_TIMEOUT);
        assert!(calls.iter().all(|call| call.sudo));
        assert!(
            calls
                .iter()
                .all(|call| call.output_limits == EXEC_OUTPUT_LIMIT_64_KIB)
        );
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
    fn mount_command_does_not_unmount_freeze_or_sync() {
        let cmd = workspace_mount_command();

        assert!(!cmd.contains("fsfreeze"));
        assert!(!cmd.contains("umount"));
        assert!(!cmd.contains("\nsync"));
    }
}
