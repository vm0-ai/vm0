//! Guest Download Script - Downloads and extracts storage archives.
//!
//! Features:
//! - Parallel downloads using std::thread (max 4 concurrent)
//! - Streaming extraction (no temp files)
//! - Retry logic with 3 attempts

use guest_common::{log_error, log_info, log_warn, telemetry::record_sandbox_op};
use serde::Deserialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant};

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

const LOG_TAG: &str = "sandbox:download";

/// Storage manifest format (matches TypeScript StorageManifest).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    #[serde(default)]
    storages: Vec<Storage>,
    #[serde(default)]
    artifacts: Vec<Artifact>,
    /// Paths to clean before downloading (stale file cleanup on VM reuse).
    #[serde(default)]
    cleanup_paths: Vec<String>,
}

/// Check if archive URL is valid (not None and not string "null").
fn is_valid_url(url: &Option<String>) -> bool {
    matches!(url, Some(u) if u != "null")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Storage {
    mount_path: String,
    archive_url: Option<String>,
    #[serde(default)]
    cached: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    mount_path: String,
    archive_url: Option<String>,
    #[serde(default)]
    cached: bool,
}

const MAX_RETRIES: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(1);
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CONCURRENT: usize = 4;

/// Global HTTP agent with timeout and system certificate verification.
/// Uses platform verifier to trust system CA certificates (including proxy CA).
static HTTP_AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    use ureq::tls::{RootCerts, TlsConfig};

    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .new_agent()
});

/// Run the download process for the given manifest file.
/// Returns `true` if all downloads succeeded, `false` otherwise.
pub fn run(manifest_path: &str) -> bool {
    // Read and parse manifest
    let manifest_json = match fs::read_to_string(manifest_path) {
        Ok(json) => json,
        Err(e) => {
            log_error!(LOG_TAG, "Failed to read manifest: {e}");
            return false;
        }
    };

    let manifest: Manifest = match serde_json::from_str(&manifest_json) {
        Ok(m) => m,
        Err(e) => {
            log_error!(LOG_TAG, "Failed to parse manifest: {e}");
            return false;
        }
    };

    // Clean stale files from changed/removed storages before downloading.
    // This must run before parallel downloads to avoid race conditions with
    // parent-child mount path overlaps.
    if !manifest.cleanup_paths.is_empty() {
        // Collect all mount paths that should be preserved (unchanged storages
        // and artifacts). Memory rides in artifacts[] post-#10602 so the memory
        // slot no longer needs its own preservation branch.
        let mut preserved: Vec<&str> = manifest
            .storages
            .iter()
            .filter(|s| s.cached)
            .map(|s| s.mount_path.as_str())
            .collect();
        for a in manifest.artifacts.iter().filter(|a| a.cached) {
            preserved.push(a.mount_path.as_str());
        }

        cleanup_stale_paths(&manifest.cleanup_paths, &preserved);
    }

    // Build unified task list: storages + artifact + memory, all downloaded in parallel.
    let mut tasks: Vec<DownloadTask> = Vec::new();

    // Storages: 404 is fatal
    for (i, s) in manifest.storages.iter().enumerate() {
        if is_valid_url(&s.archive_url)
            && let Some(url) = s.archive_url.clone()
        {
            tasks.push(DownloadTask {
                label: format!("storage {}", i + 1),
                op_name: "storage_download",
                url,
                mount_path: s.mount_path.clone(),
                allow_404: false,
            });
        }
    }

    // Artifacts: 404 is non-fatal (may not exist on first run)
    for (idx, artifact) in manifest.artifacts.iter().enumerate() {
        if is_valid_url(&artifact.archive_url)
            && let Some(url) = artifact.archive_url.clone()
        {
            tasks.push(DownloadTask {
                label: format!("artifact {}", idx + 1),
                op_name: "artifact_download",
                url,
                mount_path: artifact.mount_path.clone(),
                allow_404: true,
            });
        }
    }

    // Pre-create all target directories before parallel downloads.
    // This avoids races between parent-child mount paths (e.g. /home/user/.claude
    // and /home/user/.claude/skills/foo) when they land in the same concurrent chunk.
    for task in &tasks {
        if let Err(e) = fs::create_dir_all(&task.mount_path) {
            log_error!(
                LOG_TAG,
                "Failed to create directory {}: {e}",
                task.mount_path
            );
            return false;
        }
    }

    download_all_parallel(tasks)
}

/// Remove stale files from cleanup paths, preserving directories that belong
/// to unchanged storages.
///
/// For each path in `cleanup_paths`:
/// - If no `preserved` path is a child of it: `remove_dir_all` (clean slate).
/// - If a preserved path is a child: remove only top-level entries that don't
///   overlap with any preserved child path.
fn cleanup_stale_paths(cleanup_paths: &[String], preserved: &[&str]) {
    // Sort cleanup paths shortest-first so parents are cleaned before children.
    let mut sorted: Vec<&str> = cleanup_paths.iter().map(|s| s.as_str()).collect();
    sorted.sort_by_key(|p| p.len());

    for path in sorted {
        let path_with_slash = format!("{path}/");

        // Find preserved paths that are children of this cleanup path.
        let has_preserved_children = preserved.iter().any(|p| p.starts_with(&path_with_slash));

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
                    .any(|p| *p == entry_str.as_ref() || p.starts_with(&entry_prefix));

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
                    .filter(|p| p.starts_with(&path_with_slash))
                    .count()
            );
        }
    }
}

struct DownloadTask {
    label: String,
    op_name: &'static str,
    url: String,
    mount_path: String,
    /// When true, HTTP 404 is treated as success (artifact/memory may not exist on first run).
    allow_404: bool,
}

/// Download all tasks in parallel using std::thread.
/// Limits concurrency to MAX_CONCURRENT to avoid spawning too many threads.
/// Returns true if all downloads succeeded, false if any failed.
fn download_all_parallel(tasks: Vec<DownloadTask>) -> bool {
    if tasks.is_empty() {
        return true;
    }

    log_info!(
        LOG_TAG,
        "Downloading {} items (max {} concurrent)",
        tasks.len(),
        MAX_CONCURRENT
    );

    let mut all_success = true;
    let mut tasks = tasks;

    // Process in chunks to limit concurrency
    while !tasks.is_empty() {
        let chunk: Vec<_> = tasks.drain(..tasks.len().min(MAX_CONCURRENT)).collect();

        let handles: Vec<_> = chunk
            .into_iter()
            .map(|task| {
                thread::spawn(move || {
                    let start = Instant::now();
                    log_info!(
                        LOG_TAG,
                        "Downloading {} from {} to {}",
                        task.label,
                        task.url,
                        task.mount_path
                    );

                    match download_with_retry(&task.url, &task.mount_path) {
                        Ok(()) => {
                            let elapsed = start.elapsed();
                            record_sandbox_op(task.op_name, elapsed, true, None);
                            log_info!(
                                LOG_TAG,
                                "{} downloaded in {}ms",
                                task.label,
                                elapsed.as_millis()
                            );
                            true
                        }
                        Err(e) if e.status_code == Some(404) && task.allow_404 => {
                            record_sandbox_op(task.op_name, start.elapsed(), true, None);
                            log_info!(LOG_TAG, "{} not found, skipping (first run)", task.label);
                            true
                        }
                        Err(e) => {
                            record_sandbox_op(
                                task.op_name,
                                start.elapsed(),
                                false,
                                Some(&e.message),
                            );
                            log_error!(LOG_TAG, "{} download failed: {}", task.label, e);
                            false
                        }
                    }
                })
            })
            .collect();

        // Wait for this chunk to complete before starting next
        for handle in handles {
            match handle.join() {
                Ok(success) => {
                    if !success {
                        all_success = false;
                    }
                }
                Err(e) => {
                    let msg = e
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| e.downcast_ref::<&str>().copied())
                        .unwrap_or("unknown");
                    log_error!(LOG_TAG, "Thread panicked: {msg}");
                    all_success = false;
                }
            }
        }
    }

    all_success
}

struct DownloadError {
    message: String,
    retriable: bool,
    status_code: Option<u16>,
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

fn download_with_retry(url: &str, target_path: &str) -> Result<(), DownloadError> {
    let mut last_error = None;

    for attempt in 1..=MAX_RETRIES {
        match download_and_extract(url, target_path) {
            Ok(()) => return Ok(()),
            Err(e) => {
                log_warn!(LOG_TAG, "Attempt {attempt}/{MAX_RETRIES} failed: {e}");
                let should_break = !e.retriable;
                last_error = Some(e);
                if should_break {
                    break;
                }
                if attempt < MAX_RETRIES {
                    thread::sleep(RETRY_DELAY);
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| DownloadError {
        message: "download failed with no error".into(),
        retriable: false,
        status_code: None,
    }))
}

fn download_and_extract(url: &str, target_path: &str) -> Result<(), DownloadError> {
    fs::create_dir_all(target_path).map_err(|e| DownloadError {
        message: format!("Failed to create directory {target_path}: {e}"),
        retriable: false,
        status_code: None,
    })?;

    // Make HTTP request using global agent
    let response = HTTP_AGENT.get(url).call().map_err(|e| {
        let (retriable, status_code) = match &e {
            // Retry on server errors (5xx) and rate limiting (429)
            ureq::Error::StatusCode(code) => (*code >= 500 || *code == 429, Some(*code)),
            _ => (true, None), // network/timeout errors are retriable
        };
        DownloadError {
            message: format!("HTTP {e} url={url}"),
            retriable,
            status_code,
        }
    })?;

    // Stream: HTTP response -> GzDecoder -> tar::Archive
    let reader = response.into_body().into_reader();
    let decoder = flate2::read::GzDecoder::new(reader);
    let mut archive = tar::Archive::new(decoder);

    // Extract entries one by one, validating paths to prevent symlink path traversal.
    let target = Path::new(target_path)
        .canonicalize()
        .map_err(|e| DownloadError {
            message: format!("Failed to canonicalize target path {target_path}: {e}"),
            retriable: false,
            status_code: None,
        })?;

    for entry in archive.entries().map_err(|e| DownloadError {
        message: format!("Failed to read archive entries: {e}"),
        retriable: false,
        status_code: None,
    })? {
        let mut entry = entry.map_err(|e| DownloadError {
            message: format!("Failed to read archive entry: {e}"),
            retriable: false,
            status_code: None,
        })?;

        let entry_path = entry
            .path()
            .map_err(|e| DownloadError {
                message: format!("Failed to read entry path: {e}"),
                retriable: false,
                status_code: None,
            })?
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
        entry.unpack_in(&target).map_err(|e| DownloadError {
            message: format!("Failed to extract entry {}: {e}", entry_path.display()),
            retriable: false,
            status_code: None,
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- normalize_path tests --

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

    // -- is_within tests --

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

    // -- ancestors_within_target tests --

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

    // -- is_valid_url tests --

    #[test]
    fn is_valid_url_none() {
        assert!(!is_valid_url(&None));
    }

    #[test]
    fn is_valid_url_null_string() {
        assert!(!is_valid_url(&Some("null".to_string())));
    }

    #[test]
    fn is_valid_url_valid() {
        assert!(is_valid_url(&Some(
            "https://example.com/archive.tar.gz".to_string()
        )));
    }

    // -- cleanup_stale_paths tests --

    #[test]
    fn cleanup_removes_path_without_preserved_children() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mount");
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("stale.txt"), "old").unwrap();

        cleanup_stale_paths(&[path.to_string_lossy().into()], &[]);
        assert!(!path.exists());
    }

    #[test]
    fn cleanup_preserves_unchanged_children() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("claude");
        let child = parent.join("skills").join("foo");
        fs::create_dir_all(&child).unwrap();
        fs::write(parent.join("CLAUDE.md"), "old instructions").unwrap();
        fs::write(child.join("skill.md"), "keep me").unwrap();

        let parent_str = parent.to_string_lossy().to_string();
        let child_str = child.to_string_lossy().to_string();

        cleanup_stale_paths(&[parent_str], &[&child_str]);

        // Parent dir still exists (not fully removed)
        assert!(parent.exists());
        // Child preserved
        assert!(child.join("skill.md").exists());
        // Stale file at parent level removed
        assert!(!parent.join("CLAUDE.md").exists());
    }

    #[test]
    fn cleanup_handles_nonexistent_path() {
        // Should not panic
        cleanup_stale_paths(&["/nonexistent/path/12345".into()], &[]);
    }

    #[test]
    fn manifest_deserializes_camel_case_cleanup_paths() {
        let json = r#"{
            "storages": [],
            "cleanupPaths": ["/home/user/.claude", "/home/user/.claude/skills/old"]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.cleanup_paths.len(), 2);
        assert_eq!(manifest.cleanup_paths[0], "/home/user/.claude");
    }

    #[test]
    fn manifest_defaults_cleanup_paths_when_absent() {
        let json = r#"{"storages": []}"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert!(manifest.cleanup_paths.is_empty());
    }

    #[test]
    fn manifest_deserializes_cached_field() {
        let json = r#"{
            "storages": [
                {"mountPath": "/data", "archiveUrl": null, "cached": true},
                {"mountPath": "/other", "archiveUrl": "https://s3/v1", "cached": false}
            ],
            "artifacts": [{"mountPath": "/workspace", "archiveUrl": null, "cached": true}]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert!(manifest.storages[0].cached);
        assert!(!manifest.storages[1].cached);
        assert!(manifest.artifacts[0].cached);
    }

    #[test]
    fn manifest_defaults_cached_to_false() {
        let json = r#"{"storages": [{"mountPath": "/data"}]}"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert!(!manifest.storages[0].cached);
    }

    #[test]
    fn manifest_multi_artifacts_yield_two_tasks() {
        let json = r#"{
            "storages": [],
            "artifacts": [
                {"mountPath": "/workspace/a", "archiveUrl": "https://s3/a.tar.gz"},
                {"mountPath": "/workspace/b", "archiveUrl": "https://s3/b.tar.gz"}
            ]
        }"#;
        let manifest: Manifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.artifacts.len(), 2);

        let tasks: Vec<DownloadTask> = manifest
            .artifacts
            .iter()
            .enumerate()
            .filter_map(|(idx, a)| {
                if is_valid_url(&a.archive_url)
                    && let Some(url) = a.archive_url.clone()
                {
                    Some(DownloadTask {
                        label: format!("artifact {}", idx + 1),
                        op_name: "artifact_download",
                        url,
                        mount_path: a.mount_path.clone(),
                        allow_404: true,
                    })
                } else {
                    None
                }
            })
            .collect();

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].label, "artifact 1");
        assert_eq!(tasks[0].mount_path, "/workspace/a");
        assert_eq!(tasks[1].label, "artifact 2");
        assert_eq!(tasks[1].mount_path, "/workspace/b");
    }
}
