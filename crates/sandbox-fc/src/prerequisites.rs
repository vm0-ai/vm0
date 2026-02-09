use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use sandbox::SandboxError;

use crate::config::FirecrackerConfig;

/// Verify that all required system prerequisites are present before creating the factory.
///
/// Checks firecracker binary, kernel, rootfs, `/dev/kvm`, network commands, and sudo access.
/// Collects all failures and returns them in a single `BackendNotAvailable` error.
pub fn check_prerequisites(config: &FirecrackerConfig) -> Result<(), SandboxError> {
    let mut errors = Vec::new();

    check_file_exists(&config.binary_path, "firecracker binary", &mut errors);
    check_executable(&config.binary_path, "firecracker binary", &mut errors);
    check_file_exists(&config.kernel_path, "kernel", &mut errors);
    check_file_exists(&config.rootfs_path, "rootfs", &mut errors);
    if let Some(snapshot) = &config.snapshot {
        check_file_exists(&snapshot.snapshot_path, "snapshot state", &mut errors);
        check_file_exists(&snapshot.memory_path, "snapshot memory", &mut errors);
        check_file_exists(&snapshot.overlay_path, "snapshot overlay", &mut errors);
    }
    check_kvm(&mut errors);
    check_required_commands(config, &mut errors);
    check_sudo(&mut errors);

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
    }
}

fn check_required_commands(config: &FirecrackerConfig, errors: &mut Vec<String>) {
    let mut commands = vec!["ip", "iptables", "iptables-save", "sysctl", "pgrep"];
    if config.snapshot.is_none() {
        commands.push("mkfs.ext4");
    }
    for cmd in &commands {
        if which::which(cmd).is_err() {
            errors.push(format!("required command not found: {cmd}"));
        }
    }
}

fn check_sudo(errors: &mut Vec<String>) {
    let sudo_ok = std::process::Command::new("sudo")
        .args(["-n", "true"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !sudo_ok {
        errors.push(
            "root/sudo access required for network configuration; \
             please run with sudo or configure sudoers"
                .to_string(),
        );
    }
}
