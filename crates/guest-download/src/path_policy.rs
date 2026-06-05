use crate::manifest::{Manifest, ManifestEntry};

const CANONICAL_WORKING_DIR: &str = "/home/user/workspace";
const CLAUDE_HOME_DIR: &str = "/home/user/.claude";
const CODEX_HOME_DIR: &str = "/home/user/.codex";
const CLAUDE_SKILLS_DIR: &str = "/home/user/.claude/skills";
const CODEX_SKILLS_DIR: &str = "/home/user/.codex/skills";
const CLAUDE_MEMORY_PATH: &str = "/home/user/.claude/projects/-home-user-workspace/memory";
const CODEX_MEMORY_PATH: &str = "/home/user/.codex/memories";

pub(crate) fn validate_manifest_paths(manifest: &Manifest) -> Result<(), String> {
    for path in &manifest.cleanup_paths {
        validate_cleanup_path(path)?;
    }
    for entry in &manifest.storages {
        validate_mount_entry(entry)?;
    }
    for entry in &manifest.artifacts {
        validate_mount_entry(entry)?;
    }
    Ok(())
}

fn validate_mount_entry(entry: &ManifestEntry) -> Result<(), String> {
    if is_allowed_mount_path(&entry.mount_path) {
        return Ok(());
    }
    Err(format!("unsafe mount path: {}", entry.mount_path))
}

fn validate_cleanup_path(path: &str) -> Result<(), String> {
    if is_allowed_cleanup_path(path) {
        return Ok(());
    }
    Err(format!("unsafe cleanup path: {path}"))
}

fn is_allowed_cleanup_path(path: &str) -> bool {
    if is_debug_allowed_test_path(path) {
        return true;
    }
    is_workspace_path(path)
        || is_mnt_path(path)
        || is_framework_skill_path(path)
        || is_memory_path(path)
}

fn is_allowed_mount_path(path: &str) -> bool {
    if is_debug_allowed_test_path(path) {
        return true;
    }
    is_allowed_cleanup_path(path) || path == CLAUDE_HOME_DIR || path == CODEX_HOME_DIR
}

fn is_workspace_path(path: &str) -> bool {
    (path == CANONICAL_WORKING_DIR || path.starts_with(&format!("{CANONICAL_WORKING_DIR}/")))
        && is_strict_absolute_path(path)
}

fn is_mnt_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/mnt/") else {
        return false;
    };
    first_segment_is_safe(rest) && is_strict_absolute_path(path)
}

fn is_framework_skill_path(path: &str) -> bool {
    [CLAUDE_SKILLS_DIR, CODEX_SKILLS_DIR].iter().any(|root| {
        path.strip_prefix(&format!("{root}/"))
            .is_some_and(|rest| first_segment_is_safe(rest) && is_strict_absolute_path(path))
    })
}

fn is_memory_path(path: &str) -> bool {
    (path == CLAUDE_MEMORY_PATH || path == CODEX_MEMORY_PATH) && is_strict_absolute_path(path)
}

fn first_segment_is_safe(rest: &str) -> bool {
    let Some(first) = rest.split('/').next() else {
        return false;
    };
    !first.is_empty() && first != "." && first != ".."
}

fn is_strict_absolute_path(path: &str) -> bool {
    if !path.starts_with('/') || path.contains('\0') {
        return false;
    }
    path.split('/')
        .skip(1)
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

#[cfg(debug_assertions)]
fn is_debug_allowed_test_path(path: &str) -> bool {
    if std::env::var("VM0_GUEST_DOWNLOAD_ALLOW_TEST_PATHS").as_deref() != Ok("1") {
        return false;
    }
    let Ok(root) = std::env::var("VM0_GUEST_DOWNLOAD_TEST_ROOT") else {
        return false;
    };
    if root == "/" || root.is_empty() || !is_strict_absolute_path(&root) {
        return false;
    }
    path.starts_with(&format!("{root}/")) && is_strict_absolute_path(path)
}

#[cfg(not(debug_assertions))]
fn is_debug_allowed_test_path(_path: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_with_mount(path: &str) -> Manifest {
        Manifest {
            storages: vec![ManifestEntry {
                mount_path: path.to_string(),
                archive_url: Some("file:///tmp/archive.tar.gz".to_string()),
                instructions_target_filename: None,
                cached: false,
                vas_storage_name: None,
                vas_version_id: None,
                missing_root_policy: None,
            }],
            artifacts: vec![],
            cleanup_paths: vec![],
        }
    }

    #[test]
    fn accepts_safe_mount_targets() {
        for path in [
            "/home/user/workspace",
            "/home/user/workspace/reports",
            "/mnt/docs",
            "/mnt/docs/reports",
            "/home/user/.claude",
            "/home/user/.codex",
            "/home/user/.claude/skills/slack",
            "/home/user/.codex/skills/research-kit",
            CLAUDE_MEMORY_PATH,
            CODEX_MEMORY_PATH,
        ] {
            assert!(validate_manifest_paths(&manifest_with_mount(path)).is_ok());
        }
    }

    #[test]
    fn rejects_dangerous_mount_targets() {
        for path in [
            "/",
            "/home",
            "/home/user",
            "/mnt",
            "/tmp",
            "/run",
            "/etc",
            "/usr/local/bin",
            "/home/user/.ssh",
            "/home/user/workspace/../.ssh",
            "/mnt/docs/../other",
        ] {
            assert!(
                validate_manifest_paths(&manifest_with_mount(path)).is_err(),
                "{path} should be rejected",
            );
        }
    }

    #[test]
    fn rejects_broad_cleanup_targets() {
        let manifest = Manifest {
            storages: vec![],
            artifacts: vec![],
            cleanup_paths: vec!["/home/user/.claude".to_string()],
        };

        let error = validate_manifest_paths(&manifest).unwrap_err();

        assert!(error.contains("unsafe cleanup path"));
    }
}
