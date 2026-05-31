use std::time::Duration;

use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::workspace_image_cache::normalize_safe_guest_working_dir;

const WORKSPACE_MOUNT_TIMEOUT: Duration = Duration::from_secs(30);
const WORKSPACE_SYMLINK_PATH_GUARD: &str = r#"refuse_workspace_symlink_path() {
  check_path=
  remaining=${workspace_dir#/}
  while [ -n "$remaining" ]; do
    component=${remaining%%/*}
    if [ "$remaining" = "$component" ]; then
      remaining=
    else
      remaining=${remaining#*/}
    fi
    check_path="$check_path/$component"
    if [ -L "$check_path" ]; then
      echo "refusing to use symlink workspace path component: $check_path" >&2
      exit 64
    fi
  done
}"#;

pub(crate) async fn mount_workspace_drive(
    sandbox: &dyn Sandbox,
    run_id: RunId,
    working_dir: &str,
) -> RunnerResult<bool> {
    let Some(working_dir) = normalize_safe_guest_working_dir(working_dir) else {
        return Ok(false);
    };
    let cmd = workspace_mount_command(&working_dir);
    run_guest_workspace_command(sandbox, run_id, &cmd, "mount workspace image").await?;
    Ok(true)
}

pub(crate) async fn flush_and_unmount_workspace_drive(
    sandbox: &dyn Sandbox,
    run_id: RunId,
    working_dir: &str,
) -> RunnerResult<bool> {
    let Some(working_dir) = normalize_safe_guest_working_dir(working_dir) else {
        return Ok(false);
    };
    let cmd = workspace_unmount_command(&working_dir);
    run_guest_workspace_command(sandbox, run_id, &cmd, "unmount workspace image").await?;
    Ok(true)
}

async fn run_guest_workspace_command(
    sandbox: &dyn Sandbox,
    run_id: RunId,
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
        "{operation} failed for {run_id} with exit code {}: stderr={} stdout={}",
        result.exit_code,
        stderr.trim(),
        stdout.trim()
    )))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn workspace_mount_command(working_dir: &str) -> String {
    let working_dir = shell_quote(working_dir);
    format!(
        "set -eu\nworkspace_dir={working_dir}\nworkspace_device=/dev/vdb\n{WORKSPACE_SYMLINK_PATH_GUARD}\nensure_workspace_owner() {{\n  chown -h user:user -- \"$workspace_dir\"\n}}\nrefuse_workspace_symlink_path\nif mountpoint -q -- \"$workspace_dir\"; then\n  target_dev=\"$(mountpoint -d -- \"$workspace_dir\" 2>/dev/null || true)\"\n  workspace_dev=\"$(mountpoint -x -- \"$workspace_device\" 2>/dev/null || true)\"\n  if [ -n \"$workspace_dev\" ] && [ \"$target_dev\" = \"$workspace_dev\" ]; then\n    ensure_workspace_owner\n    exit 0\n  fi\n  echo \"refusing to mount workspace image over existing mountpoint: $workspace_dir\" >&2\n  exit 64\nfi\nmkdir -p -- \"$workspace_dir\"\nrefuse_workspace_symlink_path\nmount -t ext4 -- \"$workspace_device\" \"$workspace_dir\"\nensure_workspace_owner"
    )
}

fn workspace_unmount_command(working_dir: &str) -> String {
    let working_dir = shell_quote(working_dir);
    format!(
        "set -eu\nworkspace_dir={working_dir}\nworkspace_device=/dev/vdb\n{WORKSPACE_SYMLINK_PATH_GUARD}\nrefuse_workspace_symlink_path\nif mountpoint -q -- \"$workspace_dir\"; then\n  target_dev=\"$(mountpoint -d -- \"$workspace_dir\" 2>/dev/null || true)\"\n  workspace_dev=\"$(mountpoint -x -- \"$workspace_device\" 2>/dev/null || true)\"\n  if [ -z \"$workspace_dev\" ] || [ \"$target_dev\" != \"$workspace_dev\" ]; then\n    echo \"refusing to unmount non-workspace mountpoint: $workspace_dir\" >&2\n    exit 64\n  fi\n  sync -f -- \"$workspace_dir\" 2>/dev/null || true\n  umount -- \"$workspace_dir\"\nelse\n  echo \"workspace image is not mounted: $workspace_dir\" >&2\n  exit 65\nfi"
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
    fn workspace_unmount_command_avoids_global_sync() {
        let cmd = workspace_unmount_command("/workspace");

        assert!(!cmd.contains("\nsync\n"));
        assert!(cmd.contains("sync -f -- \"$workspace_dir\""));
        assert!(cmd.contains("umount -- \"$workspace_dir\""));
    }

    #[test]
    fn mount_and_unmount_commands_treat_working_dir_as_operand() {
        let working_dir = "/-workspace";
        let mount_cmd = workspace_mount_command(working_dir);
        let unmount_cmd = workspace_unmount_command(working_dir);

        assert!(mount_cmd.contains("workspace_dir='/-workspace'"));
        assert!(mount_cmd.contains("mount -t ext4 -- \"$workspace_device\" \"$workspace_dir\""));
        assert!(unmount_cmd.contains("workspace_dir='/-workspace'"));
        assert!(unmount_cmd.contains("umount -- \"$workspace_dir\""));
    }

    #[test]
    fn mount_and_unmount_commands_refuse_unrelated_mountpoints() {
        let mount_cmd = workspace_mount_command("/workspace");
        let unmount_cmd = workspace_unmount_command("/workspace");

        assert!(mount_cmd.contains("mountpoint -x -- \"$workspace_device\""));
        assert!(mount_cmd.contains("refusing to mount workspace image over existing mountpoint"));
        assert!(unmount_cmd.contains("mountpoint -x -- \"$workspace_device\""));
        assert!(unmount_cmd.contains("refusing to unmount non-workspace mountpoint"));
    }

    #[test]
    fn mount_command_ensures_workspace_root_owned_by_user() {
        let cmd = workspace_mount_command("/workspace");

        assert!(cmd.contains("chown -h user:user -- \"$workspace_dir\""));
        assert!(!cmd.contains("chmod "));
        assert_eq!(
            cmd.matches("ensure_workspace_owner").count(),
            3,
            "definition plus mounted and freshly mounted calls should be present"
        );
    }

    #[test]
    fn mount_and_unmount_commands_reject_workspace_symlink_components() {
        let mount_cmd = workspace_mount_command("/workspace");
        let unmount_cmd = workspace_unmount_command("/workspace");

        assert!(mount_cmd.contains("refuse_workspace_symlink_path()"));
        assert_eq!(
            mount_cmd.matches("refuse_workspace_symlink_path").count(),
            3,
            "definition plus pre-mount and post-mkdir checks should be present"
        );
        assert!(mount_cmd.contains("remaining=${workspace_dir#/}"));
        assert!(mount_cmd.contains("remaining=${remaining#*/}"));
        assert!(mount_cmd.contains("refusing to use symlink workspace path component"));
        assert!(unmount_cmd.contains("refuse_workspace_symlink_path()"));
        assert!(unmount_cmd.contains("remaining=${workspace_dir#/}"));
        assert!(unmount_cmd.contains("remaining=${remaining#*/}"));
        assert!(unmount_cmd.contains("refusing to use symlink workspace path component"));
    }

    #[test]
    fn unmount_command_fails_when_workspace_is_not_mounted() {
        let cmd = workspace_unmount_command("/workspace");

        assert!(cmd.contains("workspace image is not mounted"));
        assert!(cmd.contains("exit 65"));
    }
}
