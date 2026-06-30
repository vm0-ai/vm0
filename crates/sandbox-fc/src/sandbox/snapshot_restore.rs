use std::ffi::OsString;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::path::Path;

use sandbox::SandboxError;
use tracing::info;

use crate::api::ApiClient;
use crate::config::FirecrackerDeviceRateLimits;
use crate::factory::InvariantConfig;

/// Bash command run inside `unshare --mount` for snapshot restore.
/// Positional args are documented at the spawn site.
pub(super) const SNAPSHOT_RESTORE_INNER_CMD: &str = r#"umount -- "$4" 2>/dev/null; umount -- "$6" 2>/dev/null; mount --bind -- "$1" "$2" && mount --bind -- "$3" "$4" && mount --bind -- "$5" "$6" && exec ip netns exec "$7" "$8" --api-sock "$9""#;
pub(super) const UNSHARE_MOUNT_ARGS: &[&str] = &["--mount", "--propagation", "private"];

pub(super) async fn load_snapshot_and_apply_rate_limits(
    client: &ApiClient<'_>,
    snapshot_path: &str,
    memory_path: &str,
    rate_limits: Option<&FirecrackerDeviceRateLimits>,
) -> sandbox::Result<()> {
    // Keep the default restore path unchanged. Only hold the VM paused
    // when rate limiters must be patched before guest execution resumes.
    client
        .load_snapshot(snapshot_path, memory_path, rate_limits.is_none())
        .await
        .map_err(|e| SandboxError::Start {
            message: format!("snapshot load failed: {e}"),
        })?;
    if let Some(rate_limits) = rate_limits {
        let drive_rate_limiter = rate_limits
            .block_drive_limiter(super::nonzero_block_drive_count(2)?)
            .map_err(|e| SandboxError::Start {
                message: format!("build snapshot drive rate limiter: {e}"),
            })?;
        client
            .patch_drive_rate_limiter("rootfs", &drive_rate_limiter)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("snapshot drive rate limiter patch failed: {e}"),
            })?;
        client
            .patch_drive_rate_limiter("workspace", &drive_rate_limiter)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("snapshot workspace drive rate limiter patch failed: {e}"),
            })?;
        let inv = InvariantConfig::new();
        client
            .patch_network_rate_limiters(inv.iface_id, &rate_limits.net_rx, &rate_limits.net_tx)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("snapshot network rate limiter patch failed: {e}"),
            })?;
        client.resume().await.map_err(|e| SandboxError::Start {
            message: format!("snapshot resume failed: {e}"),
        })?;
    }

    Ok(())
}

pub(super) async fn ensure_snapshot_drive_bind_target(path: &Path) -> Result<(), SandboxError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| SandboxError::Start {
                message: format!("mkdir snapshot drive: {e}"),
            })?;
    }

    if create_snapshot_drive_bind_target_file(path).await? {
        return Ok(());
    }

    if snapshot_drive_bind_target_is_regular_file(path).await? {
        return Ok(());
    }

    if snapshot_drive_bind_target_is_mount_point(path)? {
        unmount_snapshot_drive_bind_target(path).await?;
        if create_snapshot_drive_bind_target_file(path).await? {
            return Ok(());
        }
        if snapshot_drive_bind_target_is_regular_file(path).await? {
            return Ok(());
        }
    }

    Err(SandboxError::Start {
        message: format!(
            "snapshot drive bind target is not a regular file: {}",
            path.display()
        ),
    })
}

async fn create_snapshot_drive_bind_target_file(path: &Path) -> Result<bool, SandboxError> {
    match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await
    {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(SandboxError::Start {
            message: format!("create snapshot drive bind target: {e}"),
        }),
    }
}

async fn snapshot_drive_bind_target_is_regular_file(path: &Path) -> Result<bool, SandboxError> {
    let meta = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|e| SandboxError::Start {
            message: format!("stat snapshot drive bind target: {e}"),
        })?;
    Ok(meta.file_type().is_file())
}

fn snapshot_drive_bind_target_is_mount_point(path: &Path) -> Result<bool, SandboxError> {
    let path =
        absolute_path_without_following_final_symlink(path).map_err(|e| SandboxError::Start {
            message: format!("resolve snapshot drive bind target path: {e}"),
        })?;
    let mountinfo =
        std::fs::read_to_string("/proc/self/mountinfo").map_err(|e| SandboxError::Start {
            message: format!("read /proc/self/mountinfo: {e}"),
        })?;
    Ok(mountinfo_contains_mount_point(&mountinfo, &path))
}

fn absolute_path_without_following_final_symlink(path: &Path) -> io::Result<std::path::PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn mountinfo_contains_mount_point(mountinfo: &str, path: &Path) -> bool {
    mountinfo.lines().any(|line| {
        let Some(encoded_mount_point) = line.split_whitespace().nth(4) else {
            return false;
        };
        decode_mountinfo_path(encoded_mount_point) == path
    })
}

fn decode_mountinfo_path(encoded: &str) -> std::path::PathBuf {
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        let Some(&byte) = bytes.get(i) else {
            break;
        };
        if byte == b'\\' {
            let escape = (bytes.get(i + 1), bytes.get(i + 2), bytes.get(i + 3));
            let (Some(&first), Some(&second), Some(&third)) = escape else {
                decoded.push(byte);
                i += 1;
                continue;
            };
            if !is_octal_digit(first) || !is_octal_digit(second) || !is_octal_digit(third) {
                decoded.push(byte);
                i += 1;
                continue;
            }

            let value =
                ((first - b'0') as u16) * 64 + ((second - b'0') as u16) * 8 + (third - b'0') as u16;
            if value <= u8::MAX as u16 {
                decoded.push(value as u8);
                i += 4;
            } else {
                decoded.push(byte);
                i += 1;
            }
        } else {
            decoded.push(byte);
            i += 1;
        }
    }

    std::path::PathBuf::from(OsString::from_vec(decoded))
}

fn is_octal_digit(byte: u8) -> bool {
    (b'0'..=b'7').contains(&byte)
}

async fn unmount_snapshot_drive_bind_target(path: &Path) -> Result<(), SandboxError> {
    let output = tokio::process::Command::new("umount")
        .arg(path)
        .output()
        .await
        .map_err(|e| SandboxError::Start {
            message: format!("spawn umount for snapshot drive bind target: {e}"),
        })?;

    if output.status.success() || !snapshot_drive_bind_target_is_mount_point(path)? {
        if output.status.success() {
            info!(
                path = %path.display(),
                "cleared stale snapshot drive bind target mount"
            );
        }
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(SandboxError::Start {
        message: format!(
            "umount stale snapshot drive bind target {}: {}",
            path.display(),
            stderr.trim()
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_restore_inner_cmd_uses_positional_args_without_touch() {
        assert!(!SNAPSHOT_RESTORE_INNER_CMD.contains("$0"));
        for arg in ["$1", "$2", "$3", "$4", "$5", "$6", "$7", "$8", "$9"] {
            let quoted = format!(r#""{arg}""#);
            assert!(
                SNAPSHOT_RESTORE_INNER_CMD.contains(&quoted),
                "expected quoted positional {arg} in inner_cmd: {SNAPSHOT_RESTORE_INNER_CMD}"
            );
        }
        for unexpected in ["$10", "$11"] {
            assert!(
                !SNAPSHOT_RESTORE_INNER_CMD.contains(unexpected),
                "unexpected positional {unexpected} in inner_cmd: {SNAPSHOT_RESTORE_INNER_CMD}"
            );
        }

        assert!(
            SNAPSHOT_RESTORE_INNER_CMD.starts_with(
                r#"umount -- "$4" 2>/dev/null; umount -- "$6" 2>/dev/null; mount --bind"#
            ),
            "inner_cmd must clear stale bind mount before binding: {SNAPSHOT_RESTORE_INNER_CMD}"
        );
        assert!(
            SNAPSHOT_RESTORE_INNER_CMD.contains(
                r#"&& mount --bind -- "$3" "$4" && mount --bind -- "$5" "$6" && exec ip netns exec"#
            ),
            "inner_cmd must bind COW and workspace devices before execing firecracker: {SNAPSHOT_RESTORE_INNER_CMD}"
        );
        assert!(
            !SNAPSHOT_RESTORE_INNER_CMD.contains("touch"),
            "bind target creation must stay in Rust: {SNAPSHOT_RESTORE_INNER_CMD}"
        );
    }

    #[test]
    fn snapshot_restore_unshare_uses_private_mount_propagation() {
        assert_eq!(UNSHARE_MOUNT_ARGS, ["--mount", "--propagation", "private"]);
    }

    #[test]
    fn mountinfo_contains_exact_snapshot_drive_bind_target() {
        let mountinfo = "\
36 25 0:32 / /tmp/snapshot-work/cow-device-bind rw,relatime - ext4 /dev/nbd0 rw
37 25 0:33 / /tmp/snapshot-work rw,relatime - ext4 /dev/root rw
";

        assert!(mountinfo_contains_mount_point(
            mountinfo,
            std::path::Path::new("/tmp/snapshot-work/cow-device-bind"),
        ));
        assert!(!mountinfo_contains_mount_point(
            mountinfo,
            std::path::Path::new("/tmp/snapshot-work/cow"),
        ));
    }

    #[test]
    fn mountinfo_decodes_escaped_mount_point_path() {
        let mountinfo =
            r"36 25 0:32 / /tmp/vm0\040snapshot/cow-device-bind rw,relatime - ext4 /dev/nbd0 rw";

        assert!(mountinfo_contains_mount_point(
            mountinfo,
            std::path::Path::new("/tmp/vm0 snapshot/cow-device-bind"),
        ));
    }

    #[test]
    fn normal_temp_bind_target_is_not_a_mount_point() {
        let dir = tempfile::tempdir().unwrap();
        let bind_target = dir.path().join("cow-device-bind");
        std::fs::write(&bind_target, b"").unwrap();

        assert!(!snapshot_drive_bind_target_is_mount_point(&bind_target).unwrap());
    }

    #[tokio::test]
    async fn snapshot_drive_bind_target_rejects_existing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let bind_target = dir.path().join("cow-device-bind");
        tokio::fs::create_dir(&bind_target).await.unwrap();

        let result = ensure_snapshot_drive_bind_target(&bind_target).await;

        assert!(
            matches!(result, Err(SandboxError::Start { message }) if message.contains("not a regular file"))
        );
    }

    #[tokio::test]
    async fn snapshot_drive_bind_target_rejects_existing_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let bind_target = dir.path().join("cow-device-bind");
        tokio::fs::write(&target, b"").await.unwrap();
        std::os::unix::fs::symlink(&target, &bind_target).unwrap();

        let result = ensure_snapshot_drive_bind_target(&bind_target).await;

        assert!(
            matches!(result, Err(SandboxError::Start { message }) if message.contains("not a regular file"))
        );
    }

    #[tokio::test]
    async fn snapshot_drive_bind_target_creates_missing_file_and_parent() {
        let dir = tempfile::tempdir().unwrap();
        let bind_target = dir.path().join("snapshot-work").join("cow-device-bind");

        ensure_snapshot_drive_bind_target(&bind_target)
            .await
            .unwrap();

        let meta = tokio::fs::symlink_metadata(&bind_target).await.unwrap();
        assert!(meta.file_type().is_file());
    }

    #[tokio::test]
    async fn snapshot_drive_bind_target_allows_concurrent_first_use() {
        let dir = tempfile::tempdir().unwrap();
        let bind_target = dir.path().join("snapshot-work").join("cow-device-bind");
        let left = bind_target.clone();
        let right = bind_target.clone();

        let (left_result, right_result) = tokio::join!(
            ensure_snapshot_drive_bind_target(&left),
            ensure_snapshot_drive_bind_target(&right),
        );

        left_result.unwrap();
        right_result.unwrap();
        let meta = tokio::fs::symlink_metadata(&bind_target).await.unwrap();
        assert!(meta.file_type().is_file());
    }

    #[tokio::test]
    async fn snapshot_drive_bind_target_allows_existing_file() {
        use std::os::unix::fs::MetadataExt;

        let dir = tempfile::tempdir().unwrap();
        let bind_target = dir.path().join("cow-device-bind");
        tokio::fs::write(&bind_target, b"existing target")
            .await
            .unwrap();
        let before = tokio::fs::symlink_metadata(&bind_target).await.unwrap();

        ensure_snapshot_drive_bind_target(&bind_target)
            .await
            .unwrap();

        let after = tokio::fs::symlink_metadata(&bind_target).await.unwrap();
        assert_eq!(
            before.ino(),
            after.ino(),
            "existing bind target must not be replaced"
        );
        assert_eq!(
            tokio::fs::read(&bind_target).await.unwrap(),
            b"existing target",
            "existing bind target must not be truncated"
        );
    }
}
