use std::fs::Metadata;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use nix::unistd::{AccessFlags, eaccess};
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

    check_artifact_prerequisites(config, &mut errors);
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

fn check_artifact_prerequisites(config: &PrerequisiteConfig<'_>, errors: &mut Vec<String>) {
    check_executable_file(config.binary_path, "firecracker binary", errors);
    check_readable_file(config.kernel_path, "kernel", errors);
    let rootfs_blocks = check_readable_file(config.rootfs_path, "rootfs", errors)
        .and_then(|metadata| check_rootfs_size(config.rootfs_path, metadata.len(), errors));

    if let Some(snapshot) = config.mode.snapshot() {
        check_readable_file(&snapshot.snapshot_path, "snapshot state", errors);
        check_readable_file(&snapshot.memory_path, "snapshot memory", errors);
        let snapshot_cow_len =
            check_readable_file(&snapshot.cow_path, "snapshot cow", errors).map(|m| m.len());
        let bitmap_path = nbd_cow::cow::bitmap_path_for(&snapshot.cow_path);
        check_bitmap_file(
            &bitmap_path,
            "snapshot cow bitmap",
            rootfs_blocks,
            snapshot_cow_len,
            errors,
        );
    }
}

fn check_regular_file(path: &Path, label: &str, errors: &mut Vec<String>) -> Option<Metadata> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Some(metadata),
        Ok(_) => {
            errors.push(format!("{label} is not a regular file: {}", path.display()));
            None
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            errors.push(format!("{label} not found: {}", path.display()));
            None
        }
        Err(e) => {
            errors.push(format!("failed to stat {label}: {}: {e}", path.display()));
            None
        }
    }
}

fn check_readable_file(path: &Path, label: &str, errors: &mut Vec<String>) -> Option<Metadata> {
    let metadata = check_regular_file(path, label, errors)?;
    if let Err(e) = std::fs::File::open(path) {
        errors.push(format!("{label} is not readable: {}: {e}", path.display()));
        return None;
    }
    Some(metadata)
}

fn check_executable_file(path: &Path, label: &str, errors: &mut Vec<String>) {
    if let Some(metadata) = check_regular_file(path, label, errors) {
        check_executable(path, label, &metadata, errors);
    }
}

fn check_executable(path: &Path, label: &str, metadata: &Metadata, errors: &mut Vec<String>) {
    if metadata.permissions().mode() & 0o111 == 0 {
        errors.push(format!("{label} is not executable: {}", path.display()));
        return;
    }
    if let Err(e) = eaccess(path, AccessFlags::X_OK) {
        errors.push(format!(
            "{label} is not executable: {}: {e}",
            path.display()
        ));
    }
}

fn check_rootfs_size(path: &Path, size: u64, errors: &mut Vec<String>) -> Option<usize> {
    if size == 0 {
        errors.push(format!("rootfs is empty: {}", path.display()));
        return None;
    }

    let block_size = nbd_cow::BLOCK_SIZE as u64;
    if !size.is_multiple_of(block_size) {
        errors.push(format!(
            "rootfs size {size} is not a multiple of {block_size} bytes: {}",
            path.display()
        ));
        return None;
    }

    match usize::try_from(size / block_size) {
        Ok(blocks) => Some(blocks),
        Err(_) => {
            errors.push(format!(
                "rootfs block count is too large: {}",
                path.display()
            ));
            None
        }
    }
}

fn check_bitmap_file(
    path: &Path,
    label: &str,
    expected_blocks: Option<usize>,
    cow_file_len: Option<u64>,
    errors: &mut Vec<String>,
) {
    if check_readable_file(path, label, errors).is_none() {
        return;
    }

    let Some(expected_blocks) = expected_blocks else {
        return;
    };

    let result = match cow_file_len {
        Some(cow_file_len) => nbd_cow::cow::validate_bitmap_cow_coverage(
            path,
            cow_file_len,
            nbd_cow::BLOCK_SIZE,
            expected_blocks,
        ),
        None => nbd_cow::cow::validate_bitmap(path, expected_blocks),
    };
    if let Err(e) = result {
        errors.push(format!("{label} is invalid: {}: {e}", path.display()));
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
    use std::fs::File;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::path::{Path, PathBuf};

    use super::*;

    struct ArtifactFixture {
        _dir: tempfile::TempDir,
        binary_path: PathBuf,
        kernel_path: PathBuf,
        rootfs_path: PathBuf,
        snapshot: SnapshotConfig,
    }

    impl ArtifactFixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let binary_path = dir.path().join("firecracker");
            let kernel_path = dir.path().join("vmlinux");
            let rootfs_path = dir.path().join("rootfs.ext4");
            let snapshot_path = dir.path().join("snapshot.bin");
            let memory_path = dir.path().join("memory.bin");
            let cow_path = dir.path().join("cow.img");
            let bitmap_path = nbd_cow::cow::bitmap_path_for(&cow_path);

            write_sized_file(&binary_path, 1);
            std::fs::set_permissions(&binary_path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod binary");
            write_sized_file(&kernel_path, 1);
            write_sized_file(&rootfs_path, nbd_cow::BLOCK_SIZE as u64);
            write_sized_file(&snapshot_path, 1);
            write_sized_file(&memory_path, 1);
            write_sized_file(&cow_path, nbd_cow::BLOCK_SIZE as u64);
            write_bitmap_file(&bitmap_path, 1, 0);

            Self {
                _dir: dir,
                binary_path,
                kernel_path,
                rootfs_path,
                snapshot: SnapshotConfig {
                    snapshot_path,
                    memory_path,
                    cow_path,
                    drive_bind_path: PathBuf::from("/tmp/cow-device-bind"),
                    workspace_drive_bind_path: PathBuf::from("/tmp/workspace-device-bind"),
                    vsock_bind_dir: PathBuf::from("/tmp/vsock"),
                },
            }
        }

        fn bitmap_path(&self) -> PathBuf {
            nbd_cow::cow::bitmap_path_for(&self.snapshot.cow_path)
        }

        fn fresh_config(&self) -> PrerequisiteConfig<'_> {
            PrerequisiteConfig {
                binary_path: &self.binary_path,
                kernel_path: &self.kernel_path,
                rootfs_path: &self.rootfs_path,
                mode: PrerequisiteMode::FactoryFresh,
            }
        }

        fn snapshot_create_config(&self) -> PrerequisiteConfig<'_> {
            PrerequisiteConfig {
                binary_path: &self.binary_path,
                kernel_path: &self.kernel_path,
                rootfs_path: &self.rootfs_path,
                mode: PrerequisiteMode::SnapshotCreate,
            }
        }

        fn restore_config(&self) -> PrerequisiteConfig<'_> {
            PrerequisiteConfig {
                binary_path: &self.binary_path,
                kernel_path: &self.kernel_path,
                rootfs_path: &self.rootfs_path,
                mode: PrerequisiteMode::FactorySnapshotRestore {
                    snapshot: &self.snapshot,
                },
            }
        }
    }

    fn write_sized_file(path: &Path, size: u64) {
        let file = File::create(path).unwrap_or_else(|e| panic!("create {}: {e}", path.display()));
        file.set_len(size)
            .unwrap_or_else(|e| panic!("set size {}: {e}", path.display()));
    }

    fn write_bitmap_file(path: &Path, blocks: u64, word: u64) {
        let mut data = blocks.to_le_bytes().to_vec();
        data.extend_from_slice(&word.to_le_bytes());
        std::fs::write(path, data)
            .unwrap_or_else(|e| panic!("write bitmap {}: {e}", path.display()));
    }

    fn replace_file_with_dir(path: &Path) {
        std::fs::remove_file(path).unwrap_or_else(|e| panic!("remove {}: {e}", path.display()));
        std::fs::create_dir(path).unwrap_or_else(|e| panic!("create dir {}: {e}", path.display()));
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .unwrap_or_else(|e| panic!("chmod dir {}: {e}", path.display()));
    }

    fn artifact_errors(config: PrerequisiteConfig<'_>) -> Vec<String> {
        let mut errors = Vec::new();
        check_artifact_prerequisites(&config, &mut errors);
        errors
    }

    fn assert_no_errors(errors: &[String]) {
        assert!(errors.is_empty(), "unexpected errors: {errors:#?}");
    }

    fn assert_error_contains(errors: &[String], expected: &str) {
        assert!(
            errors.iter().any(|error| error.contains(expected)),
            "expected error containing {expected:?}, got {errors:#?}"
        );
    }

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

    #[test]
    fn valid_fresh_artifacts_pass() {
        let fixture = ArtifactFixture::new();

        let errors = artifact_errors(fixture.fresh_config());

        assert_no_errors(&errors);
    }

    #[test]
    fn valid_restore_artifacts_pass() {
        let fixture = ArtifactFixture::new();

        let errors = artifact_errors(fixture.restore_config());

        assert_no_errors(&errors);
    }

    #[test]
    fn artifact_prerequisites_reject_directory_artifacts() {
        let fixture = ArtifactFixture::new();
        let bitmap_path = fixture.bitmap_path();
        for path in [
            &fixture.binary_path,
            &fixture.kernel_path,
            &fixture.rootfs_path,
            &fixture.snapshot.snapshot_path,
            &fixture.snapshot.memory_path,
            &fixture.snapshot.cow_path,
            &bitmap_path,
        ] {
            replace_file_with_dir(path);
        }

        let errors = artifact_errors(fixture.restore_config());

        assert_error_contains(&errors, "firecracker binary is not a regular file");
        assert_error_contains(&errors, "kernel is not a regular file");
        assert_error_contains(&errors, "rootfs is not a regular file");
        assert_error_contains(&errors, "snapshot state is not a regular file");
        assert_error_contains(&errors, "snapshot memory is not a regular file");
        assert_error_contains(&errors, "snapshot cow is not a regular file");
        assert_error_contains(&errors, "snapshot cow bitmap is not a regular file");
    }

    #[test]
    fn artifact_prerequisites_report_missing_paths() {
        let fixture = ArtifactFixture::new();
        std::fs::remove_file(&fixture.kernel_path).expect("remove kernel");

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "kernel not found");
    }

    #[test]
    fn artifact_prerequisites_accept_symlink_to_file() {
        let fixture = ArtifactFixture::new();
        let kernel_target = fixture.kernel_path.with_file_name("linked-vmlinux");
        write_sized_file(&kernel_target, 1);
        std::fs::remove_file(&fixture.kernel_path).expect("remove kernel");
        symlink(&kernel_target, &fixture.kernel_path).expect("symlink kernel");

        let errors = artifact_errors(fixture.fresh_config());

        assert_no_errors(&errors);
    }

    #[test]
    fn artifact_prerequisites_reject_symlink_to_directory() {
        let fixture = ArtifactFixture::new();
        let kernel_target = fixture.kernel_path.with_file_name("kernel-dir");
        std::fs::create_dir(&kernel_target).expect("create kernel dir");
        std::fs::remove_file(&fixture.kernel_path).expect("remove kernel");
        symlink(&kernel_target, &fixture.kernel_path).expect("symlink kernel");

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "kernel is not a regular file");
    }

    #[test]
    fn artifact_prerequisites_reject_non_executable_binary() {
        let fixture = ArtifactFixture::new();
        std::fs::set_permissions(&fixture.binary_path, std::fs::Permissions::from_mode(0o644))
            .expect("chmod binary");

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "firecracker binary is not executable");
    }

    #[test]
    fn artifact_prerequisites_reject_binary_without_current_user_execute_access() {
        if nix::unistd::geteuid().as_raw() == 0 {
            return;
        }

        let fixture = ArtifactFixture::new();
        std::fs::set_permissions(&fixture.binary_path, std::fs::Permissions::from_mode(0o001))
            .expect("chmod binary");

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "firecracker binary is not executable");
    }

    #[test]
    fn artifact_prerequisites_reject_empty_rootfs() {
        let fixture = ArtifactFixture::new();
        write_sized_file(&fixture.rootfs_path, 0);

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "rootfs is empty");
    }

    #[test]
    fn artifact_prerequisites_reject_unaligned_rootfs() {
        let fixture = ArtifactFixture::new();
        write_sized_file(&fixture.rootfs_path, nbd_cow::BLOCK_SIZE as u64 + 1);

        let errors = artifact_errors(fixture.fresh_config());

        assert_error_contains(&errors, "rootfs size");
        assert_error_contains(&errors, "not a multiple");
    }

    #[test]
    fn restore_mode_requires_snapshot_cow_bitmap() {
        let fixture = ArtifactFixture::new();
        std::fs::remove_file(fixture.bitmap_path()).expect("remove bitmap");

        let fresh_errors = artifact_errors(fixture.fresh_config());
        let snapshot_create_errors = artifact_errors(fixture.snapshot_create_config());
        let restore_errors = artifact_errors(fixture.restore_config());

        assert_no_errors(&fresh_errors);
        assert_no_errors(&snapshot_create_errors);
        assert_error_contains(&restore_errors, "snapshot cow bitmap not found");
    }

    #[test]
    fn restore_mode_rejects_mismatched_snapshot_cow_bitmap() {
        let fixture = ArtifactFixture::new();
        write_bitmap_file(&fixture.bitmap_path(), 2, 0);

        let errors = artifact_errors(fixture.restore_config());

        assert_error_contains(&errors, "snapshot cow bitmap is invalid");
        assert_error_contains(&errors, "bitmap block count mismatch");
    }

    #[test]
    fn restore_mode_rejects_truncated_snapshot_cow_bitmap() {
        let fixture = ArtifactFixture::new();
        std::fs::write(fixture.bitmap_path(), 1u64.to_le_bytes()).expect("write bitmap");

        let errors = artifact_errors(fixture.restore_config());

        assert_error_contains(&errors, "snapshot cow bitmap is invalid");
        assert_error_contains(&errors, "bitmap data truncated");
    }

    #[test]
    fn restore_mode_rejects_snapshot_cow_too_short_for_dirty_bitmap() {
        let fixture = ArtifactFixture::new();
        write_sized_file(&fixture.snapshot.cow_path, 0);
        write_bitmap_file(&fixture.bitmap_path(), 1, 1);

        let errors = artifact_errors(fixture.restore_config());

        assert_error_contains(&errors, "snapshot cow bitmap is invalid");
        assert_error_contains(&errors, "dirty bitmap references COW data");
    }

    #[test]
    fn restore_mode_accepts_short_snapshot_cow_for_clean_bitmap() {
        let fixture = ArtifactFixture::new();
        write_sized_file(&fixture.snapshot.cow_path, 0);
        write_bitmap_file(&fixture.bitmap_path(), 1, 0);

        let errors = artifact_errors(fixture.restore_config());

        assert_no_errors(&errors);
    }
}
