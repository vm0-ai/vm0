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
    pub snapshot: Option<&'a SnapshotConfig>,
}

/// Verify that all required system prerequisites are present.
///
/// Checks firecracker binary, kernel, rootfs, `/dev/kvm`, and network commands.
/// Collects all failures and returns them in a single `BackendNotAvailable` error.
pub(crate) async fn check_prerequisites(
    config: &PrerequisiteConfig<'_>,
) -> Result<(), SandboxError> {
    let mut errors = Vec::new();

    check_file_exists(config.binary_path, "firecracker binary", &mut errors);
    check_executable(config.binary_path, "firecracker binary", &mut errors);
    check_file_exists(config.kernel_path, "kernel", &mut errors);
    check_file_exists(config.rootfs_path, "rootfs", &mut errors);
    if let Some(snapshot) = config.snapshot {
        check_file_exists(&snapshot.snapshot_path, "snapshot state", &mut errors);
        check_file_exists(&snapshot.memory_path, "snapshot memory", &mut errors);
        check_file_exists(&snapshot.cow_path, "snapshot cow", &mut errors);
    }
    check_kvm(&mut errors);
    check_required_commands(&mut errors);
    ensure_runtime_dir(&mut errors);

    if errors.is_empty() {
        Ok(())
    } else {
        Err(SandboxError::BackendNotAvailable(errors.join("; ")))
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

fn check_required_commands(errors: &mut Vec<String>) {
    let commands = [
        "ip",
        "iptables",
        "iptables-save",
        "sysctl",
        "pgrep",
        // Required by cow_pool (sparse copy for golden snapshots).
        "cp",
        // Required by snapshot restore (unshare --mount).
        "unshare",
    ];
    for cmd in &commands {
        if which::which(cmd).is_err() {
            errors.push(format!("required command not found: {cmd}"));
        }
    }
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
