use std::time::Duration;

use api_contracts::generated::constants::runners::paths::CANONICAL_WORKING_DIR;
use sandbox::{EXEC_OUTPUT_LIMIT_64_KIB, ExecRequest, Sandbox};

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;

const WORKSPACE_MOUNT_TIMEOUT: Duration = Duration::from_secs(30);
const WORKSPACE_DEVICE: &str = "/dev/vdb";
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
const WORKSPACE_DEVICE_MOUNT_GUARD: &str = r#"workspace_device_mounted_elsewhere() {
  [ -n "$workspace_dev" ] || return 1
  while IFS=' ' read -r _ _ mount_dev _ _ _; do
    if [ "$mount_dev" = "$workspace_dev" ]; then
      return 0
    fi
  done < /proc/self/mountinfo
  return 1
}"#;

pub(crate) async fn ensure_workspace_drive_mounted(
    sandbox: &dyn Sandbox,
    run_id: RunId,
) -> RunnerResult<()> {
    let cmd = workspace_mount_command();
    let result = sandbox
        .exec(&ExecRequest {
            cmd: &cmd,
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
        "mount workspace drive failed for {run_id} with exit code {}: stderr={} stdout={}",
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
        "set -eu\nworkspace_dir={workspace_dir}\nworkspace_device={workspace_device}\n{WORKSPACE_SYMLINK_PATH_GUARD}\n{WORKSPACE_DEVICE_MOUNT_GUARD}\nensure_workspace_owner() {{\n  chown -h user:user -- \"$workspace_dir\"\n}}\nrefuse_workspace_symlink_path\nworkspace_dev=\"$(mountpoint -x -- \"$workspace_device\" 2>/dev/null || true)\"\nif mountpoint -q -- \"$workspace_dir\"; then\n  target_dev=\"$(mountpoint -d -- \"$workspace_dir\" 2>/dev/null || true)\"\n  if [ -n \"$workspace_dev\" ] && [ \"$target_dev\" = \"$workspace_dev\" ]; then\n    ensure_workspace_owner\n    exit 0\n  fi\n  echo \"refusing to mount workspace drive over existing mountpoint: $workspace_dir\" >&2\n  exit 64\nfi\nif workspace_device_mounted_elsewhere; then\n  echo \"refusing to mount workspace drive because $workspace_device is already mounted outside $workspace_dir\" >&2\n  exit 64\nfi\nmkdir -p -- \"$workspace_dir\"\nrefuse_workspace_symlink_path\nmount -t ext4 -- \"$workspace_device\" \"$workspace_dir\"\nensure_workspace_owner"
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
    fn mount_command_does_not_unmount_or_sync() {
        let cmd = workspace_mount_command();

        assert!(!cmd.contains("umount"));
        assert!(!cmd.contains("\nsync"));
    }
}
