use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::{RunnerError, RunnerResult};
use crate::paths::HomePaths;

const FIRECRACKER_VERSION: &str = "v1.14.1";
const KERNEL_VERSION: &str = "6.1.155";

// SHA256 checksums for installed artifacts, keyed by arch.
const FIRECRACKER_SHA256_X86_64: &str =
    "ef68f03e2dcaa4c07347a4b11989bedb350c982e62da7a3f74bc40f4f840e0ce";
const FIRECRACKER_SHA256_AARCH64: &str =
    "d1bc4cbd166a3b572cdb55019634aed48a5426e2253f126b18654596367d2bf4";
const KERNEL_SHA256_X86_64: &str =
    "e41c7048bd2475e7e788153823fcb9166a7e0b78c4c443bd6446d015fa735f53";
const KERNEL_SHA256_AARCH64: &str =
    "61baeae1ac6197be4fc5c71fa78df266acdc33c54570290d2f611c2b42c105be";

/// "v1.14.1" → "v1.14"
const FIRECRACKER_MINOR: &str = strip_patch(FIRECRACKER_VERSION);

#[allow(clippy::panic, clippy::indexing_slicing)] // compile-time only
const fn strip_patch(version: &str) -> &str {
    let bytes = version.as_bytes();
    let mut i = bytes.len();
    while i > 0 {
        i -= 1;
        if bytes[i] == b'.' {
            // SAFETY: splitting a UTF-8 str at an ASCII '.' boundary yields valid UTF-8
            return unsafe {
                std::str::from_utf8_unchecked(std::slice::from_raw_parts(bytes.as_ptr(), i))
            };
        }
    }
    panic!("FIRECRACKER_VERSION must be in vMAJOR.MINOR.PATCH format")
}

pub async fn run_setup() -> RunnerResult<()> {
    let arch = check_architecture()?;
    check_system_dependencies();

    let paths = HomePaths::new()?;
    create_directories(&paths, FIRECRACKER_VERSION).await?;
    download_firecracker(&paths, arch).await?;
    download_kernel(&paths, arch).await?;
    check_kvm();

    tracing::info!("setup complete");
    Ok(())
}

fn check_architecture() -> RunnerResult<&'static str> {
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => {
            return Err(RunnerError::Config(format!(
                "unsupported architecture: {other}"
            )));
        }
    };
    tracing::info!("[OK] architecture: {arch}");
    Ok(arch)
}

fn check_system_dependencies() {
    // Required by `runner start` (sandbox networking)
    let required = ["ip", "iptables", "iptables-save", "sysctl"];
    // Only needed by specific commands (build-rootfs, etc.)
    let optional = ["pgrep", "mkfs.ext4", "mksquashfs", "docker"];

    let missing_required: Vec<&str> = required
        .iter()
        .filter(|dep| which::which(dep).is_err())
        .copied()
        .collect();
    let missing_optional: Vec<&str> = optional
        .iter()
        .filter(|dep| which::which(dep).is_err())
        .copied()
        .collect();

    if missing_required.is_empty() {
        tracing::info!("[OK] all required system dependencies found");
    } else {
        tracing::warn!(
            "missing required dependencies (needed by `runner start`): {}",
            missing_required.join(", ")
        );
    }

    if !missing_optional.is_empty() {
        tracing::warn!(
            "missing optional dependencies (needed by other commands): {}",
            missing_optional.join(", ")
        );
    }
}

async fn create_directories(paths: &HomePaths, fc_version: &str) -> RunnerResult<()> {
    tokio::fs::create_dir_all(paths.bin_dir())
        .await
        .map_err(|e| RunnerError::Internal(format!("create bin dir: {e}")))?;
    tokio::fs::create_dir_all(paths.firecracker_dir(fc_version))
        .await
        .map_err(|e| RunnerError::Internal(format!("create firecracker dir: {e}")))?;
    tokio::fs::create_dir_all(paths.runners_dir())
        .await
        .map_err(|e| RunnerError::Internal(format!("create runners dir: {e}")))?;
    tracing::info!("[OK] directory structure created");
    Ok(())
}

/// Write contents to a PID-unique temp file, set permissions, then atomically rename.
/// Cleans up the temp file on failure.
async fn atomic_install(target: &Path, contents: &[u8], mode: Option<u32>) -> RunnerResult<()> {
    let tmp_path = target.with_extension(format!("tmp.{}", std::process::id()));

    let result = async {
        tokio::fs::write(&tmp_path, contents)
            .await
            .map_err(|e| RunnerError::Internal(format!("write {}: {e}", target.display())))?;
        if let Some(mode) = mode {
            tokio::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(mode))
                .await
                .map_err(|e| RunnerError::Internal(format!("chmod {}: {e}", target.display())))?;
        }
        tokio::fs::rename(&tmp_path, target)
            .await
            .map_err(|e| RunnerError::Internal(format!("rename to {}: {e}", target.display())))
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
    }
    result
}

fn verify_sha256(data: &[u8], expected_hex: &str, label: &str) -> RunnerResult<()> {
    let actual = format!("{:x}", Sha256::digest(data));
    if actual != expected_hex {
        return Err(RunnerError::Internal(format!(
            "{label} SHA256 mismatch: expected {expected_hex}, got {actual}"
        )));
    }
    tracing::info!("[OK] {label} SHA256 verified");
    Ok(())
}

async fn is_firecracker_installed(bin_path: &Path) -> bool {
    if !tokio::fs::try_exists(bin_path).await.unwrap_or(false) {
        return false;
    }
    let Ok(output) = tokio::process::Command::new(bin_path)
        .arg("--version")
        .output()
        .await
    else {
        return false;
    };
    let version_str = String::from_utf8_lossy(&output.stdout);
    let version_no_prefix = FIRECRACKER_VERSION
        .strip_prefix('v')
        .unwrap_or(FIRECRACKER_VERSION);
    version_str.contains(version_no_prefix)
}

async fn download_firecracker(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let bin_path = paths.firecracker_bin(FIRECRACKER_VERSION);

    if is_firecracker_installed(&bin_path).await {
        tracing::info!(
            "[OK] firecracker {FIRECRACKER_VERSION} already installed, skipping download"
        );
        return Ok(());
    }

    let url = format!(
        "https://github.com/firecracker-microvm/firecracker/releases/download/{FIRECRACKER_VERSION}/firecracker-{FIRECRACKER_VERSION}-{arch}.tgz"
    );
    tracing::info!("downloading firecracker from {url}");

    let response = reqwest::get(&url)
        .await
        .map_err(|e| RunnerError::Internal(format!("download firecracker: {e}")))?;

    if !response.status().is_success() {
        return Err(RunnerError::Internal(format!(
            "download firecracker: HTTP {}",
            response.status()
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| RunnerError::Internal(format!("read firecracker response: {e}")))?;

    // Extract the firecracker binary from the tarball
    let decoder = flate2::read::GzDecoder::new(&bytes[..]);
    let mut archive = tar::Archive::new(decoder);

    let expected_name = format!("firecracker-{FIRECRACKER_VERSION}-{arch}");

    let entries = archive
        .entries()
        .map_err(|e| RunnerError::Internal(format!("read tarball entries: {e}")))?;

    let mut contents = None;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| RunnerError::Internal(format!("read tarball entry: {e}")))?;

        let path = entry
            .path()
            .map_err(|e| RunnerError::Internal(format!("read entry path: {e}")))?;

        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();

        if file_name == expected_name {
            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| RunnerError::Internal(format!("read firecracker binary: {e}")))?;
            contents = Some(buf);
            break;
        }
    }

    let contents = contents.ok_or_else(|| {
        RunnerError::Internal(format!(
            "firecracker binary '{expected_name}' not found in tarball"
        ))
    })?;

    let expected_sha = match arch {
        "x86_64" => FIRECRACKER_SHA256_X86_64,
        _ => FIRECRACKER_SHA256_AARCH64,
    };
    verify_sha256(&contents, expected_sha, "firecracker binary")?;

    match atomic_install(&bin_path, &contents, Some(0o755)).await {
        Ok(()) => {
            tracing::info!("[OK] firecracker {FIRECRACKER_VERSION} installed");
            Ok(())
        }
        Err(e) => {
            // Another runner may have completed the install
            if is_firecracker_installed(&bin_path).await {
                tracing::info!(
                    "[OK] firecracker {FIRECRACKER_VERSION} installed by another process"
                );
                return Ok(());
            }
            Err(e)
        }
    }
}

async fn download_kernel(paths: &HomePaths, arch: &str) -> RunnerResult<()> {
    let kernel_path = paths.kernel_bin(FIRECRACKER_VERSION, KERNEL_VERSION);

    if tokio::fs::try_exists(&kernel_path).await.unwrap_or(false) {
        tracing::info!("[OK] kernel vmlinux-{KERNEL_VERSION} already present, skipping download");
        return Ok(());
    }

    let url = format!(
        "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/{FIRECRACKER_MINOR}/{arch}/vmlinux-{KERNEL_VERSION}"
    );
    tracing::info!("downloading kernel from {url}");

    let response = reqwest::get(&url)
        .await
        .map_err(|e| RunnerError::Internal(format!("download kernel: {e}")))?;

    if !response.status().is_success() {
        return Err(RunnerError::Internal(format!(
            "download kernel: HTTP {}",
            response.status()
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| RunnerError::Internal(format!("read kernel response: {e}")))?;

    let expected_sha = match arch {
        "x86_64" => KERNEL_SHA256_X86_64,
        _ => KERNEL_SHA256_AARCH64,
    };
    verify_sha256(&bytes, expected_sha, "kernel")?;

    match atomic_install(&kernel_path, &bytes, None).await {
        Ok(()) => {
            tracing::info!("[OK] kernel vmlinux-{KERNEL_VERSION} installed");
            Ok(())
        }
        Err(e) => {
            // Another runner may have completed the install
            if tokio::fs::try_exists(&kernel_path).await.unwrap_or(false) {
                tracing::info!("[OK] kernel vmlinux-{KERNEL_VERSION} installed by another process");
                return Ok(());
            }
            Err(e)
        }
    }
}

fn check_kvm() {
    use std::fs::File;

    match File::options().read(true).write(true).open("/dev/kvm") {
        Ok(_) => {
            tracing::info!("[OK] KVM accessible");
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::warn!("/dev/kvm not found — ensure bare-metal with KVM enabled");
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            tracing::warn!("/dev/kvm not accessible — run: sudo chmod 666 /dev/kvm");
        }
        Err(e) => {
            tracing::warn!("/dev/kvm check failed: {e}");
        }
    }
}
