use crate::LOG_TAG;
use crate::error::DownloadError;
use guest_common::log_warn;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Extract a gzip-compressed tar archive into `target_path`.
pub(crate) fn extract_tar_gz(reader: impl Read, target_path: &str) -> Result<(), DownloadError> {
    let decoder = flate2::read::GzDecoder::new(reader);
    let mut archive = tar::Archive::new(decoder);

    // Extract entries one by one, validating paths to prevent symlink path traversal.
    let target = Path::new(target_path).canonicalize().map_err(|e| {
        DownloadError::fatal(format!(
            "Failed to canonicalize target path {target_path}: {e}"
        ))
    })?;

    for entry in archive
        .entries()
        .map_err(|e| DownloadError::fatal(format!("Failed to read archive entries: {e}")))?
    {
        let mut entry = entry
            .map_err(|e| DownloadError::fatal(format!("Failed to read archive entry: {e}")))?;

        let entry_path = entry
            .path()
            .map_err(|e| DownloadError::fatal(format!("Failed to read entry path: {e}")))?
            .into_owned();

        let entry_type = entry.header().entry_type();

        // Check that the entry path lexically stays within the target directory
        // (normalize to collapse any .. components before checking)
        let full_path = target.join(&entry_path);
        if !is_within(&full_path, &target) {
            log_warn!(
                LOG_TAG,
                "Skipping entry with path escaping target dir: {}",
                entry_path.display()
            );
            continue;
        }

        // For symlinks, validate the resolved link target stays within the target directory
        if entry_type.is_symlink() {
            let link_target = match entry.link_name() {
                Ok(Some(t)) => t,
                _ => {
                    log_warn!(
                        LOG_TAG,
                        "Skipping symlink with unreadable target: {}",
                        entry_path.display()
                    );
                    continue;
                }
            };
            let link_dir = full_path.parent().unwrap_or(&target);
            let resolved = link_dir.join(&*link_target);
            if !is_within(&resolved, &target) {
                log_warn!(
                    LOG_TAG,
                    "Skipping symlink with target escaping dir: {} -> {}",
                    entry_path.display(),
                    link_target.display()
                );
                continue;
            }
        }

        // For hardlinks, validate the link source stays within the target directory
        if entry_type == tar::EntryType::Link {
            let link_name = match entry.link_name() {
                Ok(Some(t)) => t,
                _ => {
                    log_warn!(
                        LOG_TAG,
                        "Skipping hardlink with unreadable source: {}",
                        entry_path.display()
                    );
                    continue;
                }
            };
            let resolved = target.join(&*link_name);
            if !is_within(&resolved, &target) {
                log_warn!(
                    LOG_TAG,
                    "Skipping hardlink with source escaping dir: {} -> {}",
                    entry_path.display(),
                    link_name.display()
                );
                continue;
            }
        }

        // Verify that parent directories haven't been replaced by symlinks pointing outside
        // the target (two-step attack: first create a symlink dir, then write entries through
        // it). Walk up to the deepest existing ancestor since the immediate parent may not
        // exist yet. This applies to ALL entry types — a symlink/hardlink entry extracted
        // through a malicious symlink directory is equally dangerous.
        if !ancestors_within_target(&full_path, &target) {
            log_warn!(
                LOG_TAG,
                "Skipping entry whose parent resolves outside target: {}",
                entry_path.display()
            );
            continue;
        }

        // TOCTOU is not a concern here: entries are processed sequentially from a single
        // archive stream, so no external actor can modify the filesystem between our checks
        // and the extraction below.
        entry.unpack_in(&target).map_err(|e| {
            DownloadError::fatal(format!(
                "Failed to extract entry {}: {e}",
                entry_path.display()
            ))
        })?;
    }

    Ok(())
}

/// Lexically normalize a path by collapsing `.` and `..` components.
/// Unlike `canonicalize()`, this does not touch the filesystem.
fn normalize_path(path: &Path) -> PathBuf {
    let mut components: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                // Only pop Normal components; don't pop RootDir or Prefix
                if matches!(components.last(), Some(Component::Normal(_))) {
                    components.pop();
                }
            }
            Component::CurDir => {}
            c => components.push(c),
        }
    }
    components.iter().collect()
}

/// Check whether `path` stays within `target` after lexical normalization.
fn is_within(path: &Path, target: &Path) -> bool {
    normalize_path(path).starts_with(target)
}

/// Walk up from `path`'s parent toward `target`, find the deepest existing ancestor,
/// canonicalize it, and verify it still resolves within `target`.
/// Returns false if any ancestor resolves outside `target` (e.g., a symlink directory
/// was planted earlier in the archive to redirect writes outside the target).
fn ancestors_within_target(path: &Path, target: &Path) -> bool {
    // Start from parent — path itself is the entry being extracted (doesn't exist yet).
    let Some(mut ancestor) = path.parent() else {
        return true;
    };
    loop {
        if ancestor == target {
            return true; // Reached target itself, which is already canonical
        }
        // Use symlink_metadata (lstat) instead of exists (stat) so we detect
        // dangling symlinks — exists() follows symlinks and returns false for them.
        if ancestor.symlink_metadata().is_ok() {
            return match ancestor.canonicalize() {
                Ok(canonical) => canonical.starts_with(target),
                Err(_) => false, // dangling symlink or permission error
            };
        }
        match ancestor.parent() {
            Some(parent) => ancestor = parent,
            None => return true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_removes_dot() {
        assert_eq!(normalize_path(Path::new("/a/./b")), PathBuf::from("/a/b"));
    }

    #[test]
    fn normalize_path_collapses_parent() {
        assert_eq!(
            normalize_path(Path::new("/a/b/../c")),
            PathBuf::from("/a/c")
        );
    }

    #[test]
    fn normalize_path_does_not_escape_root() {
        // Going above root should not pop the root component
        assert_eq!(normalize_path(Path::new("/a/../../b")), PathBuf::from("/b"));
    }

    #[test]
    fn normalize_path_already_clean() {
        assert_eq!(
            normalize_path(Path::new("/usr/local/bin")),
            PathBuf::from("/usr/local/bin")
        );
    }

    #[test]
    fn normalize_path_multiple_dots() {
        assert_eq!(
            normalize_path(Path::new("/a/./b/./c")),
            PathBuf::from("/a/b/c")
        );
    }

    #[test]
    fn is_within_simple_child() {
        assert!(is_within(
            Path::new("/target/subdir/file.txt"),
            Path::new("/target")
        ));
    }

    #[test]
    fn is_within_rejects_traversal() {
        assert!(!is_within(
            Path::new("/target/../etc/passwd"),
            Path::new("/target")
        ));
    }

    #[test]
    fn is_within_exact_match() {
        assert!(is_within(Path::new("/target"), Path::new("/target")));
    }

    #[test]
    fn is_within_dot_in_path() {
        assert!(is_within(
            Path::new("/target/./subdir"),
            Path::new("/target")
        ));
    }

    #[test]
    fn is_within_rejects_sibling() {
        assert!(!is_within(
            Path::new("/target/../sibling/file"),
            Path::new("/target")
        ));
    }

    #[test]
    fn ancestors_within_target_simple() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path();
        std::fs::create_dir_all(target.join("sub")).unwrap();
        assert!(ancestors_within_target(
            &target.join("sub/file.txt"),
            target
        ));
    }

    #[test]
    fn ancestors_within_target_non_existent_parent() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path();
        // Parent "sub" doesn't exist yet — should walk up to target itself
        assert!(ancestors_within_target(
            &target.join("sub/deep/file.txt"),
            target
        ));
    }

    #[test]
    fn ancestors_within_target_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // Create a symlink inside target that points outside
        std::os::unix::fs::symlink(&outside, target.join("escape")).unwrap();
        assert!(!ancestors_within_target(
            &target.join("escape/file.txt"),
            &target
        ));
    }
}
