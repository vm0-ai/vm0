use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use sandbox::SandboxError;

use crate::config::SnapshotConfig;
use crate::paths::RUNTIME_DIR;

/// Common inputs needed for prerequisite checks.
///
/// Both [`crate::factory::FirecrackerFactory`] and [`crate::snapshot::create_snapshot`]
/// construct this from their respective config types.
pub(crate) struct PrerequisiteConfig<'a> {
    pub binary_path: &'a Path,
    pub kernel_path: &'a Path,
    pub rootfs_path: &'a Path,
    pub mode: PrerequisiteMode<'a>,
}

/// Operation-specific prerequisite mode.
#[derive(Clone, Copy, Debug)]
pub(crate) enum PrerequisiteMode<'a> {
    FactoryFresh,
    FactorySnapshotRestore { snapshot: &'a SnapshotConfig },
    SnapshotCreate,
}

impl<'a> PrerequisiteMode<'a> {
    fn snapshot(self) -> Option<&'a SnapshotConfig> {
        match self {
            Self::FactorySnapshotRestore { snapshot } => Some(snapshot),
            Self::FactoryFresh | Self::SnapshotCreate => None,
        }
    }

    fn command_groups(self) -> &'static [&'static [&'static str]] {
        match self {
            Self::FactoryFresh => FACTORY_FRESH_COMMAND_GROUPS,
            Self::FactorySnapshotRestore { .. } => FACTORY_SNAPSHOT_RESTORE_COMMAND_GROUPS,
            Self::SnapshotCreate => SNAPSHOT_CREATE_COMMAND_GROUPS,
        }
    }
}

const FACTORY_FRESH_COMMAND_GROUPS: &[&[&str]] =
    &[NETWORK_COMMANDS, WORKSPACE_IMAGE_CREATE_COMMANDS];
const FACTORY_SNAPSHOT_RESTORE_COMMAND_GROUPS: &[&[&str]] = &[
    NETWORK_COMMANDS,
    COW_POOL_SNAPSHOT_RESTORE_COMMANDS,
    WORKSPACE_IMAGE_CREATE_COMMANDS,
    SNAPSHOT_PRIVATE_MOUNT_RESTORE_COMMANDS,
];
const SNAPSHOT_CREATE_COMMAND_GROUPS: &[&[&str]] = &[
    NETWORK_COMMANDS,
    WORKSPACE_IMAGE_CREATE_COMMANDS,
    SNAPSHOT_PRIVATE_MOUNT_CREATE_COMMANDS,
];

const NETWORK_COMMANDS: &[&str] = &["ip", "iptables", "iptables-save", "sysctl"];
const SNAPSHOT_PRIVATE_MOUNT_CREATE_COMMANDS: &[&str] = &["unshare", "bash", "mount"];
const SNAPSHOT_PRIVATE_MOUNT_RESTORE_COMMANDS: &[&str] = &["unshare", "bash", "mount", "umount"];
const COW_POOL_SNAPSHOT_RESTORE_COMMANDS: &[&str] = &["cp"];
const WORKSPACE_IMAGE_CREATE_COMMANDS: &[&str] = &["mkfs.ext4"];

/// Verify that all required system prerequisites are present.
///
/// Checks firecracker binary, kernel, rootfs, `/dev/kvm`, runtime directory,
/// snapshot artifacts when restoring, and host commands required by the mode.
/// Collects all failures and returns them in a single `BackendUnavailable` error.
pub(crate) async fn check_prerequisites(
    config: &PrerequisiteConfig<'_>,
) -> Result<(), SandboxError> {
    let mut errors = Vec::new();

    check_file_exists(config.binary_path, "firecracker binary", &mut errors);
    check_executable(config.binary_path, "firecracker binary", &mut errors);
    check_file_exists(config.kernel_path, "kernel", &mut errors);
    check_file_exists(config.rootfs_path, "rootfs", &mut errors);
    if let Some(snapshot) = config.mode.snapshot() {
        check_file_exists(&snapshot.snapshot_path, "snapshot state", &mut errors);
        check_file_exists(&snapshot.memory_path, "snapshot memory", &mut errors);
        check_file_exists(&snapshot.cow_path, "snapshot cow", &mut errors);
    }
    check_kvm(&mut errors);
    let commands = required_commands(config.mode);
    check_required_commands(&commands, &mut errors);
    ensure_runtime_dir(&mut errors);

    prerequisite_result(errors)
}

/// Verify host network tools before creating network namespaces.
pub(crate) fn check_network_prerequisites() -> Result<(), SandboxError> {
    let mut errors = Vec::new();
    check_required_commands(NETWORK_COMMANDS, &mut errors);
    prerequisite_result(errors)
}

fn prerequisite_result(errors: Vec<String>) -> Result<(), SandboxError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(SandboxError::BackendUnavailable {
            message: errors.join("; "),
        })
    }
}

fn check_file_exists(path: &Path, label: &str, errors: &mut Vec<String>) {
    if !path.exists() {
        errors.push(format!("{label} not found: {}", path.display()));
    }
}

fn check_executable(path: &Path, label: &str, errors: &mut Vec<String>) {
    if let Ok(meta) = path.metadata()
        && meta.permissions().mode() & 0o111 == 0
    {
        errors.push(format!("{label} is not executable: {}", path.display()));
    }
}

fn check_kvm(errors: &mut Vec<String>) {
    let kvm = Path::new("/dev/kvm");
    if !kvm.exists() {
        errors.push("/dev/kvm not found (KVM not available)".to_string());
    } else if let Err(e) = std::fs::File::options().read(true).write(true).open(kvm) {
        errors.push(format!("/dev/kvm not accessible: {e}"));
    }
}

fn check_required_commands(commands: &[&str], errors: &mut Vec<String>) {
    for cmd in commands {
        if which::which(cmd).is_err() {
            errors.push(format!("required command not found: {cmd}"));
        }
    }
}

fn required_commands(mode: PrerequisiteMode<'_>) -> Vec<&'static str> {
    required_commands_for_groups(mode.command_groups())
}

fn required_commands_for_groups<'a>(command_groups: &[&'a [&'a str]]) -> Vec<&'a str> {
    let mut commands = Vec::new();
    for group in command_groups {
        for &cmd in *group {
            if !commands.contains(&cmd) {
                commands.push(cmd);
            }
        }
    }
    commands
}

/// Create `/run/vm0` with mode 1777 (world-writable + sticky bit) if needed.
fn ensure_runtime_dir(errors: &mut Vec<String>) {
    if let Err(e) = std::fs::create_dir_all(RUNTIME_DIR) {
        errors.push(format!("failed to create {RUNTIME_DIR}: {e}"));
        return;
    }
    if let Err(e) = std::fs::set_permissions(RUNTIME_DIR, std::fs::Permissions::from_mode(0o1777)) {
        errors.push(format!("failed to chmod {RUNTIME_DIR}: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn snapshot_config() -> SnapshotConfig {
        SnapshotConfig {
            snapshot_path: PathBuf::from("/tmp/snapshot.bin"),
            memory_path: PathBuf::from("/tmp/memory.bin"),
            cow_path: PathBuf::from("/tmp/cow.img"),
            drive_bind_path: PathBuf::from("/tmp/cow-device-bind"),
            workspace_drive_bind_path: PathBuf::from("/tmp/workspace-device-bind"),
            vsock_bind_dir: PathBuf::from("/tmp/vsock"),
        }
    }

    #[test]
    fn factory_fresh_commands_include_network_and_workspace_image_create() {
        let mode = PrerequisiteMode::FactoryFresh;
        assert_eq!(
            required_commands(mode),
            vec!["ip", "iptables", "iptables-save", "sysctl", "mkfs.ext4"]
        );
    }

    #[test]
    fn snapshot_restore_commands_include_cp_mkfs_and_private_mount_restore() {
        let snapshot = snapshot_config();
        let mode = PrerequisiteMode::FactorySnapshotRestore {
            snapshot: &snapshot,
        };

        assert_eq!(
            required_commands(mode),
            vec![
                "ip",
                "iptables",
                "iptables-save",
                "sysctl",
                "cp",
                "mkfs.ext4",
                "unshare",
                "bash",
                "mount",
                "umount",
            ]
        );
    }

    #[test]
    fn snapshot_create_commands_include_private_mount_create_without_sparse_copy() {
        let mode = PrerequisiteMode::SnapshotCreate;
        let commands = required_commands(mode);

        assert_eq!(
            commands,
            vec![
                "ip",
                "iptables",
                "iptables-save",
                "sysctl",
                "mkfs.ext4",
                "unshare",
                "bash",
                "mount",
            ]
        );
    }

    #[test]
    fn required_commands_do_not_include_pgrep_without_dependency() {
        let snapshot = snapshot_config();
        let modes = [
            PrerequisiteMode::FactoryFresh,
            PrerequisiteMode::FactorySnapshotRestore {
                snapshot: &snapshot,
            },
            PrerequisiteMode::SnapshotCreate,
        ];

        for mode in modes {
            let commands = required_commands(mode);
            assert!(!commands.contains(&"pgrep"), "mode: {mode:?}");
        }
    }

    #[test]
    fn conntrack_is_optional_not_hard_required() {
        let snapshot = snapshot_config();
        let modes = [
            PrerequisiteMode::FactoryFresh,
            PrerequisiteMode::FactorySnapshotRestore {
                snapshot: &snapshot,
            },
            PrerequisiteMode::SnapshotCreate,
        ];

        for mode in modes {
            let commands = required_commands(mode);
            assert!(!commands.contains(&"conntrack"), "mode: {mode:?}");
        }
    }

    #[test]
    fn network_prerequisites_use_network_command_set() {
        assert_eq!(
            required_commands_for_groups(&[NETWORK_COMMANDS]),
            vec!["ip", "iptables", "iptables-save", "sysctl"]
        );
    }

    #[test]
    fn snapshot_artifacts_are_present_only_for_restore_mode() {
        let snapshot = snapshot_config();
        assert!(PrerequisiteMode::FactoryFresh.snapshot().is_none());
        assert!(PrerequisiteMode::SnapshotCreate.snapshot().is_none());
        let restore_snapshot = PrerequisiteMode::FactorySnapshotRestore {
            snapshot: &snapshot,
        }
        .snapshot();
        assert!(matches!(restore_snapshot, Some(s) if std::ptr::eq(s, &snapshot)));
    }
}
