use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::SystemTime;

use tracing::warn;

use crate::error::{RunnerError, RunnerResult};

/// Like `next_entry()`, but logs a warning and returns `None` on I/O error
/// instead of propagating — suitable for best-effort scans like GC.
///
/// Returning `None` terminates a `while let Some(entry)` loop, so an error
/// stops iteration for the current directory (remaining entries are skipped).
pub(super) async fn next_entry_warn(
    entries: &mut tokio::fs::ReadDir,
    label: &str,
    dir: &Path,
) -> Option<tokio::fs::DirEntry> {
    match entries.next_entry().await {
        Ok(entry) => entry,
        Err(e) => {
            warn!("{label}: read entry in {}: {e}", dir.display());
            None
        }
    }
}

pub(super) async fn read_dir_or_missing(path: &Path) -> RunnerResult<Option<tokio::fs::ReadDir>> {
    match tokio::fs::read_dir(path).await {
        Ok(rd) => Ok(Some(rd)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(RunnerError::Internal(format!(
            "read {}: {e}",
            path.display()
        ))),
    }
}

pub(super) enum GcDirStatus {
    RealDir(std::fs::Metadata),
    Missing,
    NotDirectory,
}

pub(super) async fn gc_path_dir_status(path: &Path) -> std::io::Result<GcDirStatus> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(meta) if meta.file_type().is_dir() => Ok(GcDirStatus::RealDir(meta)),
        Ok(_) => Ok(GcDirStatus::NotDirectory),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(GcDirStatus::Missing),
        Err(e) => Err(e),
    }
}

pub(super) async fn gc_entry_is_real_dir(entry: &tokio::fs::DirEntry) -> std::io::Result<bool> {
    match entry.file_type().await {
        Ok(file_type) => Ok(file_type.is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Compute total disk usage (st_blocks * 512) and last-used time for a directory.
///
/// Last-used time comes from the root directory's own mtime, which `touch_mtime`
/// updates on every cache hit and `runner start`.
pub(super) async fn dir_stats(dir: &Path) -> (u64, SystemTime) {
    const BYTES_PER_BLOCK: u64 = 512;

    let root_meta = match tokio::fs::symlink_metadata(dir).await {
        Ok(meta) => meta,
        Err(_) => return (0, SystemTime::UNIX_EPOCH),
    };
    let mtime = root_meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    if !root_meta.file_type().is_dir() {
        return (root_meta.blocks() * BYTES_PER_BLOCK, mtime);
    }

    let mut total_bytes = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(current_meta) = tokio::fs::symlink_metadata(&current).await else {
            tracing::debug!("dir_stats: cannot stat {}", current.display());
            continue;
        };
        if !current_meta.file_type().is_dir() {
            continue;
        }

        let mut entries = match tokio::fs::read_dir(&current).await {
            Ok(rd) => rd,
            Err(e) => {
                tracing::debug!("dir_stats: cannot read {}: {e}", current.display());
                continue;
            }
        };
        while let Some(entry) = next_entry_warn(&mut entries, "dir_stats", &current).await {
            let path = entry.path();
            let Ok(meta) = tokio::fs::symlink_metadata(&path).await else {
                tracing::debug!("dir_stats: cannot stat {}", entry.path().display());
                continue;
            };
            total_bytes += meta.blocks() * BYTES_PER_BLOCK;
            if meta.file_type().is_dir() {
                stack.push(path);
            }
        }
    }

    (total_bytes, mtime)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn dir_stats_does_not_recurse_through_symlinked_child_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let normal_child = root.join("normal");
        std::fs::create_dir_all(&normal_child).unwrap();
        std::fs::write(normal_child.join("inside.bin"), vec![1u8; 4096]).unwrap();

        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("outside.bin"), vec![2u8; 1024 * 1024]).unwrap();
        let link = root.join("linked");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let symlink_bytes = std::fs::symlink_metadata(&link).unwrap().blocks() * 512;

        let (with_symlink, _) = dir_stats(&root).await;
        std::fs::remove_file(&link).unwrap();
        let (without_symlink, _) = dir_stats(&root).await;

        assert_eq!(
            with_symlink,
            without_symlink + symlink_bytes,
            "dir_stats should count the symlink itself but not recurse into its target"
        );
    }
}
