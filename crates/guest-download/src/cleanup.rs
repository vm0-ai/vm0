use crate::LOG_TAG;
use guest_common::{log_info, log_warn};
use std::fs;

/// Remove stale files from cleanup paths, preserving directories that belong
/// to unchanged storages.
///
/// For each path in `cleanup_paths`:
/// - If no `preserved` path is a child of it: `remove_dir_all` (clean slate).
/// - If a preserved path is a child: remove only top-level entries that don't
///   overlap with any preserved child path.
pub(crate) fn cleanup_stale_paths(cleanup_paths: &[String], preserved: &[String]) {
    // Sort cleanup paths shortest-first so parents are cleaned before children.
    let mut sorted: Vec<&str> = cleanup_paths.iter().map(|s| s.as_str()).collect();
    sorted.sort_by_key(|p| p.len());

    for path in sorted {
        let path_with_slash = format!("{path}/");

        // Find preserved paths that are children of this cleanup path.
        let has_preserved_children = preserved
            .iter()
            .any(|p| p.as_str().starts_with(&path_with_slash));

        if !has_preserved_children {
            // No unchanged children — safe to remove everything.
            if let Err(e) = fs::remove_dir_all(path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log_warn!(LOG_TAG, "Failed to clean {path}: {e}");
                }
            } else {
                log_info!(LOG_TAG, "Cleaned stale path: {path}");
            }
        } else {
            // Has unchanged children — selectively remove entries that don't
            // overlap with preserved paths.
            let entries = match fs::read_dir(path) {
                Ok(entries) => entries,
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        log_warn!(LOG_TAG, "Failed to read dir {path}: {e}");
                    }
                    continue;
                }
            };
            for entry in entries.flatten() {
                let entry_path = entry.path();
                let entry_str = entry_path.to_string_lossy();
                let entry_prefix = format!("{entry_str}/");

                // Check if this entry is or contains a preserved path.
                let is_preserved = preserved
                    .iter()
                    .any(|p| p == entry_str.as_ref() || p.starts_with(&entry_prefix));

                if !is_preserved {
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        if let Err(e) = fs::remove_dir_all(&entry_path) {
                            log_warn!(LOG_TAG, "Failed to remove {}: {e}", entry_str);
                        }
                    } else if let Err(e) = fs::remove_file(&entry_path) {
                        log_warn!(LOG_TAG, "Failed to remove {}: {e}", entry_str);
                    }
                }
            }
            log_info!(
                LOG_TAG,
                "Selectively cleaned {path} (preserved {} children)",
                preserved
                    .iter()
                    .filter(|p| p.as_str().starts_with(&path_with_slash))
                    .count()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disable_system_log() {
        guest_common::log::clear_system_log_file();
    }

    #[test]
    fn cleanup_removes_path_without_preserved_children() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mount");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("stale.txt"), "old").unwrap();

        cleanup_stale_paths(&[path.to_string_lossy().into()], &[]);
        assert!(!path.exists());
    }

    #[test]
    fn cleanup_preserves_unchanged_children() {
        disable_system_log();
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("claude");
        let child = parent.join("skills").join("foo");
        fs::create_dir_all(&child).unwrap();
        fs::write(parent.join("CLAUDE.md"), "old instructions").unwrap();
        fs::write(child.join("skill.md"), "keep me").unwrap();

        let parent_str = parent.to_string_lossy().to_string();
        let child_str = child.to_string_lossy().to_string();

        cleanup_stale_paths(&[parent_str], &[child_str]);

        // Parent dir still exists (not fully removed)
        assert!(parent.exists());
        // Child preserved
        assert!(child.join("skill.md").exists());
        // Stale file at parent level removed
        assert!(!parent.join("CLAUDE.md").exists());
    }

    #[test]
    fn cleanup_handles_nonexistent_path() {
        disable_system_log();
        // Should not panic
        cleanup_stale_paths(&["/nonexistent/path/12345".into()], &[]);
    }
}
