use crate::storage_fingerprints::StorageFingerprints;

pub(super) fn filter_storage_fingerprints_for_working_dir(
    fingerprints: &StorageFingerprints,
    working_dir: &str,
) -> StorageFingerprints {
    let keep_path = |mount_path: &str| is_workspace_scoped_path(mount_path, working_dir);
    StorageFingerprints {
        storages: fingerprints
            .storages
            .iter()
            .filter(|(path, _)| keep_path(path))
            .map(|(path, value)| (path.clone(), value.clone()))
            .collect(),
        artifacts: fingerprints
            .artifacts
            .iter()
            .filter(|(path, _)| keep_path(path))
            .map(|(path, value)| (path.clone(), value.clone()))
            .collect(),
    }
}

pub(super) fn is_safe_guest_working_dir(path: &str) -> bool {
    normalize_safe_guest_working_dir(path).is_some()
}

pub(super) fn normalize_safe_guest_working_dir(path: &str) -> Option<String> {
    if !path.starts_with('/') || path.as_bytes().contains(&0) {
        return None;
    }

    let mut components = Vec::new();
    for component in path.split('/') {
        match component {
            "" => {}
            "." | ".." => return None,
            _ => components.push(component),
        }
    }

    if components.is_empty() {
        return None;
    }

    Some(format!("/{}", components.join("/")))
}

pub(super) fn is_workspace_scoped_path(mount_path: &str, working_dir: &str) -> bool {
    let Some(mount_path) = normalize_safe_guest_working_dir(mount_path) else {
        return false;
    };
    let Some(working_dir) = normalize_safe_guest_working_dir(working_dir) else {
        return false;
    };
    if mount_path == working_dir {
        return true;
    }
    let Some(suffix) = mount_path.strip_prefix(&working_dir) else {
        return false;
    };
    suffix.starts_with('/')
}
