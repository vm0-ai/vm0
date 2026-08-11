use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::SystemTime;

use tracing::warn;

use crate::error::{RunnerError, RunnerResult};

fn warn_next_entry_error(label: &str, dir: &Path, error: &std::io::Error) {
    warn!("{label}: read entry in {}: {error}", dir.display());
}

/// Like `next_entry()`, but logs an I/O error before returning it.
pub(super) async fn next_entry_warn(
    entries: &mut tokio::fs::ReadDir,
    label: &str,
    dir: &Path,
) -> std::io::Result<Option<tokio::fs::DirEntry>> {
    match entries.next_entry().await {
        Ok(entry) => Ok(entry),
        Err(error) => {
            warn_next_entry_error(label, dir, &error);
            Err(error)
        }
    }
}

/// Stop a best-effort directory scan after logging an I/O error.
pub(super) async fn next_entry_warn_or_stop(
    entries: &mut tokio::fs::ReadDir,
    label: &str,
    dir: &Path,
) -> Option<tokio::fs::DirEntry> {
    next_entry_warn(entries, label, dir).await.ok().flatten()
}

/// Stateful directory reader for GC scans whose completeness authorizes deletion.
pub(super) struct GcDirEntryReader {
    #[cfg(test)]
    entries_before_error: Option<usize>,
}

impl GcDirEntryReader {
    pub(super) const fn new() -> Self {
        Self {
            #[cfg(test)]
            entries_before_error: None,
        }
    }

    #[cfg(test)]
    pub(super) const fn failing_after(successful_entries: usize) -> Self {
        Self {
            entries_before_error: Some(successful_entries),
        }
    }

    pub(super) async fn next_entry_warn(
        &mut self,
        entries: &mut tokio::fs::ReadDir,
        label: &str,
        dir: &Path,
    ) -> std::io::Result<Option<tokio::fs::DirEntry>> {
        #[cfg(test)]
        if let Some(remaining) = &mut self.entries_before_error {
            if *remaining == 0 {
                self.entries_before_error = None;
                let error = std::io::Error::other("injected directory iteration failure");
                warn_next_entry_error(label, dir, &error);
                return Err(error);
            }
            *remaining -= 1;
        }

        next_entry_warn(entries, label, dir).await
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
    let stats = collect_dir_stats(dir).await;
    (stats.size, stats.mtime)
}

pub(super) struct DirStats {
    pub(super) size: u64,
    pub(super) mtime: SystemTime,
    /// Present only when the full directory walk completed.
    pub(super) root_metadata: Option<std::fs::Metadata>,
}

/// Compute directory stats while retaining the root metadata fetched for the walk.
pub(super) async fn collect_dir_stats(dir: &Path) -> DirStats {
    let mut entry_reader = GcDirEntryReader::new();
    collect_dir_stats_with_reader(dir, &mut entry_reader).await
}

async fn collect_dir_stats_with_reader(
    dir: &Path,
    entry_reader: &mut GcDirEntryReader,
) -> DirStats {
    const BYTES_PER_BLOCK: u64 = 512;

    let root_meta = match tokio::fs::symlink_metadata(dir).await {
        Ok(meta) => meta,
        Err(_) => {
            return DirStats {
                size: 0,
                mtime: SystemTime::UNIX_EPOCH,
                root_metadata: None,
            };
        }
    };
    let mtime = root_meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    if !root_meta.file_type().is_dir() {
        return DirStats {
            size: root_meta.blocks() * BYTES_PER_BLOCK,
            mtime,
            root_metadata: Some(root_meta),
        };
    }

    let mut total_bytes = 0u64;
    let mut complete = true;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let current_meta = match tokio::fs::symlink_metadata(&current).await {
            Ok(metadata) => metadata,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        if !current_meta.file_type().is_dir() {
            complete = false;
            continue;
        }

        let mut entries = match tokio::fs::read_dir(&current).await {
            Ok(rd) => rd,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        loop {
            let entry = match entry_reader
                .next_entry_warn(&mut entries, "dir_stats", &current)
                .await
            {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(_) => {
                    complete = false;
                    break;
                }
            };
            let path = entry.path();
            let meta = match tokio::fs::symlink_metadata(&path).await {
                Ok(metadata) => metadata,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            total_bytes += meta.blocks() * BYTES_PER_BLOCK;
            if meta.file_type().is_dir() {
                stack.push(path);
            }
        }
    }

    DirStats {
        size: total_bytes,
        mtime,
        root_metadata: complete.then_some(root_meta),
    }
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

    #[tokio::test]
    async fn collect_dir_stats_withholds_root_metadata_after_incomplete_walk() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("archive.tar.gz"), vec![1u8; 4096]).unwrap();
        let mut entry_reader = GcDirEntryReader::failing_after(0);

        let stats = collect_dir_stats_with_reader(&root, &mut entry_reader).await;

        assert!(stats.root_metadata.is_none());
    }
}
