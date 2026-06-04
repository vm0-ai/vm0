//! Filesystem status helpers for guest diagnostics.

use std::fs;
use std::io;
use std::path::Path;

const DIRECTORY_ENTRY_COUNT_LIMIT: usize = 100;

/// Describe a path without reading file contents or logging directory names.
///
/// The output is intentionally compact and stable for system-log diagnostics.
/// Missing paths include parent status so callers can distinguish a missing
/// mount root from a missing parent tree.
pub fn describe_path(path: impl AsRef<Path>) -> String {
    let path = path.as_ref();
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            format!(
                "path={} status={} len={}",
                path.display(),
                file_type_label(&file_type),
                metadata.len()
            )
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            format!(
                "path={} status=missing {}",
                path.display(),
                describe_parent(path)
            )
        }
        Err(error) => {
            format!(
                "path={} status=error errorKind={:?} error={}",
                path.display(),
                error.kind(),
                error
            )
        }
    }
}

fn file_type_label(file_type: &fs::FileType) -> &'static str {
    if file_type.is_dir() {
        "dir"
    } else if file_type.is_file() {
        "file"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "other"
    }
}

fn describe_parent(path: &Path) -> String {
    let Some(parent) = path.parent() else {
        return "parentPath=<none> parentStatus=none".to_string();
    };

    match fs::symlink_metadata(parent) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            let status = file_type_label(&file_type);
            if file_type.is_dir() {
                format!(
                    "parentPath={} parentStatus={} parentEntryCount={}",
                    parent.display(),
                    status,
                    directory_entry_count(parent)
                )
            } else {
                format!("parentPath={} parentStatus={}", parent.display(), status)
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            format!("parentPath={} parentStatus=missing", parent.display())
        }
        Err(error) => {
            format!(
                "parentPath={} parentStatus=error parentErrorKind={:?} parentError={}",
                parent.display(),
                error.kind(),
                error
            )
        }
    }
}

fn directory_entry_count(path: &Path) -> String {
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => return format!("error({:?})", error.kind()),
    };

    let mut count = 0usize;
    for entry in entries {
        if entry.is_ok() {
            count += 1;
        }
        if count >= DIRECTORY_ENTRY_COUNT_LIMIT {
            return format!(">={DIRECTORY_ENTRY_COUNT_LIMIT}");
        }
    }
    count.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_path_reports_existing_directory() {
        let dir = tempfile::tempdir().unwrap();

        let description = describe_path(dir.path());

        assert!(description.contains("status=dir"));
        assert!(description.contains("len="));
    }

    #[test]
    fn describe_path_reports_missing_path_with_parent_status() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("sibling.txt"), "content").unwrap();
        let missing = dir.path().join("missing");

        let description = describe_path(&missing);

        assert!(description.contains("status=missing"));
        assert!(description.contains("parentStatus=dir"));
        assert!(description.contains("parentEntryCount=1"));
    }
}
