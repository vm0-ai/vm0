//! VAS artifact upload — SHA-256 hashing, tar.gz creation, S3 presigned upload.
//!
//! Flow (caller first walks the mount via [`walk_files`], then invokes
//! [`create_snapshot`] with the pre-walked file list):
//! 1. POST `/storages/prepare` with file list → get presigned URLs
//! 2. If deduplicated, POST `/storages/commit` to update HEAD
//! 3. Create tar.gz archive
//! 4. Create manifest.json
//! 5. PUT archive + manifest to S3
//! 6. POST `/storages/commit`

use crate::constants;
use crate::error::AgentError;
use crate::http;
use crate::urls;
use guest_common::telemetry::record_sandbox_op;
use guest_common::{log_error, log_info, log_warn};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

const LOG_TAG: &str = "sandbox:guest-agent";

#[derive(Serialize, Clone)]
pub(crate) struct FileEntry {
    pub(crate) path: String,
    pub(crate) hash: String,
    pub(crate) size: u64,
}

#[derive(Deserialize)]
struct PrepareResponse {
    #[serde(rename = "versionId")]
    version_id: Option<String>,
    existing: Option<bool>,
    uploads: Option<Uploads>,
}

#[derive(Deserialize)]
struct Uploads {
    archive: Option<UploadInfo>,
    manifest: Option<UploadInfo>,
}

#[derive(Deserialize)]
struct UploadInfo {
    #[serde(rename = "presignedUrl")]
    presigned_url: String,
}

#[derive(Deserialize)]
struct CommitResponse {
    success: Option<bool>,
}

pub(crate) struct SnapshotResult {
    pub(crate) version_id: String,
}

/// Walk `mount_path` in a blocking task and collect `FileEntry` records,
/// recording the hash-compute op and emitting a "Found N files" log. Exposed
/// so the checkpoint step can pre-walk once, decide whether to skip, and reuse
/// the result for `create_snapshot` without a second walk.
pub(crate) async fn walk_files(mount_path: &str) -> Result<Vec<FileEntry>, AgentError> {
    log_info!(LOG_TAG, "Computing file hashes...");
    let hash_start = std::time::Instant::now();
    let mount = mount_path.to_string();
    let files = tokio::task::spawn_blocking(move || collect_file_metadata(&mount))
        .await
        .map_err(|e| AgentError::Execution(format!("hash task panicked: {e}")))?;
    record_sandbox_op("artifact_hash_compute", hash_start.elapsed(), true, None);
    log_info!(LOG_TAG, "Found {} files", files.len());
    Ok(files)
}

/// Create a VAS snapshot using direct S3 upload. Caller provides the
/// pre-walked file list (see [`walk_files`]) — this lets the checkpoint step
/// share one walk between its skip-check fingerprint and the snapshot upload.
pub(crate) async fn create_snapshot(
    mount_path: &str,
    files: Vec<FileEntry>,
    storage_name: &str,
    storage_type: &str,
    run_id: &str,
    message: &str,
    parent_version_id: &str,
) -> Result<SnapshotResult, AgentError> {
    log_info!(
        LOG_TAG,
        "Creating direct upload snapshot for '{storage_name}'"
    );

    // Step 1: Prepare
    log_info!(LOG_TAG, "Calling prepare endpoint...");
    let prep_start = std::time::Instant::now();
    let mut prep_payload = json!({
        "storageName": storage_name,
        "storageType": storage_type,
        "files": files,
        "runId": run_id,
    });
    if !parent_version_id.is_empty()
        && let Some(obj) = prep_payload.as_object_mut()
    {
        obj.insert("parentVersionId".to_string(), json!(parent_version_id));
    }

    let prep_result = http::post_json(
        urls::storage_prepare_url(),
        &prep_payload,
        constants::HTTP_MAX_RETRIES,
    )
    .await;
    let prep_resp = match prep_result {
        Ok(Some(v)) => v,
        Ok(None) => {
            record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), false, None);
            return Err(AgentError::Checkpoint("Empty prepare response".into()));
        }
        Err(e) => {
            record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), false, None);
            return Err(e);
        }
    };
    let prep: PrepareResponse =
        serde_json::from_value(prep_resp).map_err(|e| AgentError::Checkpoint(e.to_string()))?;

    let version_id = match prep.version_id {
        Some(id) => id,
        None => {
            record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), false, None);
            return Err(AgentError::Checkpoint(
                "No versionId in prepare response".into(),
            ));
        }
    };
    record_sandbox_op("artifact_prepare_api", prep_start.elapsed(), true, None);

    // Step 2: Deduplication check
    if prep.existing.unwrap_or(false) {
        log_info!(
            LOG_TAG,
            "Version already exists (deduplicated), updating HEAD"
        );
        let mut commit_payload = json!({
            "storageName": storage_name,
            "storageType": storage_type,
            "versionId": version_id,
            "files": files,
            "runId": run_id,
        });
        if !parent_version_id.is_empty()
            && let Some(obj) = commit_payload.as_object_mut()
        {
            obj.insert("parentVersionId".to_string(), json!(parent_version_id));
        }
        let resp = http::post_json(
            urls::storage_commit_url(),
            &commit_payload,
            constants::HTTP_MAX_RETRIES,
        )
        .await?;
        let commit: CommitResponse = resp
            .map(|v| {
                serde_json::from_value(v).unwrap_or_else(|e| {
                    log_warn!(LOG_TAG, "Failed to parse dedup commit response: {e}");
                    CommitResponse { success: None }
                })
            })
            .unwrap_or(CommitResponse { success: None });
        if commit.success != Some(true) {
            return Err(AgentError::Checkpoint("Failed to update HEAD".into()));
        }
        return Ok(SnapshotResult { version_id });
    }

    // Step 3: Get presigned URLs
    let uploads = prep
        .uploads
        .ok_or_else(|| AgentError::Checkpoint("No upload URLs in prepare response".into()))?;
    let archive_url = uploads
        .archive
        .ok_or_else(|| AgentError::Checkpoint("No archive upload info".into()))?
        .presigned_url;
    let manifest_url = uploads
        .manifest
        .ok_or_else(|| AgentError::Checkpoint("No manifest upload info".into()))?
        .presigned_url;

    // Step 4: Create archive + manifest in temp dir
    let temp_dir = tempfile::tempdir().map_err(AgentError::Io)?;
    let archive_path = temp_dir.path().join("archive.tar.gz");
    let manifest_path = temp_dir.path().join("manifest.json");

    // Create archive (blocking)
    log_info!(LOG_TAG, "Creating archive...");
    let arc_start = std::time::Instant::now();
    let mp = mount_path.to_string();
    let ap = archive_path.clone();
    let file_paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();
    let archive_ok = tokio::task::spawn_blocking(move || create_archive(&mp, &ap, &file_paths))
        .await
        .map_err(|e| AgentError::Execution(format!("archive task panicked: {e}")))?;
    if !archive_ok {
        record_sandbox_op("artifact_archive_create", arc_start.elapsed(), false, None);
        return Err(AgentError::Checkpoint("Failed to create archive".into()));
    }
    record_sandbox_op("artifact_archive_create", arc_start.elapsed(), true, None);

    // Create manifest
    let manifest = json!({
        "version": 1,
        "files": files,
        "createdAt": guest_common::log::timestamp(),
    });
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| AgentError::Checkpoint(e.to_string()))?,
    )
    .map_err(|e| AgentError::Checkpoint(format!("Failed to write manifest: {e}")))?;

    // Step 5: Upload to S3
    log_info!(LOG_TAG, "Uploading archive to S3...");
    let s3_start = std::time::Instant::now();
    if let Err(e) = http::put_presigned_file(&archive_url, &archive_path, "application/gzip").await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(e);
    }

    log_info!(LOG_TAG, "Uploading manifest to S3...");
    let manifest_data = tokio::fs::read(&manifest_path).await?;
    if let Err(e) =
        http::put_presigned(&manifest_url, manifest_data.into(), "application/json").await
    {
        record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), false, None);
        return Err(e);
    }
    record_sandbox_op("artifact_s3_upload", s3_start.elapsed(), true, None);

    // Step 6: Commit
    log_info!(LOG_TAG, "Calling commit endpoint...");
    let commit_start = std::time::Instant::now();
    let mut commit_payload = json!({
        "storageName": storage_name,
        "storageType": storage_type,
        "versionId": version_id,
        "files": files,
        "runId": run_id,
        "message": message,
    });
    if !parent_version_id.is_empty()
        && let Some(obj) = commit_payload.as_object_mut()
    {
        obj.insert("parentVersionId".to_string(), json!(parent_version_id));
    }
    let resp = match http::post_json(
        urls::storage_commit_url(),
        &commit_payload,
        constants::HTTP_MAX_RETRIES,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            record_sandbox_op("artifact_commit_api", commit_start.elapsed(), false, None);
            return Err(e);
        }
    };
    let commit: CommitResponse = resp
        .map(|v| {
            serde_json::from_value(v).unwrap_or_else(|e| {
                log_warn!(LOG_TAG, "Failed to parse commit response: {e}");
                CommitResponse { success: None }
            })
        })
        .unwrap_or(CommitResponse { success: None });

    if commit.success != Some(true) {
        record_sandbox_op("artifact_commit_api", commit_start.elapsed(), false, None);
        return Err(AgentError::Checkpoint("Commit failed".into()));
    }

    record_sandbox_op("artifact_commit_api", commit_start.elapsed(), true, None);
    let short_id = version_id.get(..8).unwrap_or(&version_id);
    log_info!(LOG_TAG, "Direct upload snapshot created: {short_id}");

    Ok(SnapshotResult { version_id })
}

/// Walk directory and compute SHA-256 for each file, skipping `.git` and `.vm0`.
pub(crate) fn collect_file_metadata(dir_path: &str) -> Vec<FileEntry> {
    let mut files = Vec::new();
    walk_dir(dir_path, "", &mut files);
    files
}

/// Deterministic 32-byte fingerprint of a pre-walked file set: SHA-256 over
/// the path-sorted sequence of `(path, hash, size)` triples. Cheap — the
/// per-file content hashing was already done by [`collect_file_metadata`].
pub(crate) fn fingerprint_from_files(files: &[FileEntry]) -> [u8; 32] {
    let mut sorted: Vec<&FileEntry> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let mut hasher = Sha256::new();
    for f in &sorted {
        hasher.update(f.path.as_bytes());
        hasher.update(b"\0");
        hasher.update(f.hash.as_bytes());
        hasher.update(b"\0");
        hasher.update(f.size.to_le_bytes());
        hasher.update(b"\0");
    }
    hasher.finalize().into()
}

/// Convenience: walk `dir_path` and compute its fingerprint. Equivalent to
/// `fingerprint_from_files(&collect_file_metadata(dir_path))`, used at boot
/// time where there's no snapshot upload to share the walk with.
pub(crate) fn compute_directory_fingerprint(dir_path: &str) -> [u8; 32] {
    fingerprint_from_files(&collect_file_metadata(dir_path))
}

fn walk_dir(current: &str, relative: &str, out: &mut Vec<FileEntry>) {
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == ".git" || name_str == ".vm0" {
            continue;
        }

        // Use file_type() which does NOT follow symlinks (uses d_type from getdents64
        // on Linux, no extra syscall). This avoids the manifest/archive mismatch where
        // is_file()/is_dir() follow symlinks but tar stores them as symlink entries.
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue; // Skip symlinks — v1 manifest cannot represent them
        }

        let full = entry.path();
        let rel = if relative.is_empty() {
            name_str.to_string()
        } else {
            format!("{relative}/{name_str}")
        };

        if ft.is_dir() {
            if let Some(s) = full.to_str() {
                walk_dir(s, &rel, out);
            }
        } else if ft.is_file() {
            match compute_file_hash(&full) {
                Ok((hash, size)) => out.push(FileEntry {
                    path: rel,
                    hash,
                    size,
                }),
                Err(e) => {
                    log_warn!(LOG_TAG, "Could not process file {rel}: {e}");
                }
            }
        }
    }
}

fn compute_file_hash(path: &Path) -> Result<(String, u64), std::io::Error> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        let Some(chunk) = buf.get(..n) else { break };
        hasher.update(chunk);
        total += n as u64;
    }
    let hash = hex::encode(hasher.finalize());
    Ok((hash, total))
}

/// Create a tar.gz archive containing only the files listed in `file_paths`.
///
/// This ensures the archive matches the manifest exactly — no symlinks or other
/// entries that `walk_dir` skipped will be included.
fn create_archive(dir_path: &str, tar_path: &Path, file_paths: &[String]) -> bool {
    if file_paths.is_empty() {
        // Create empty archive for empty artifacts
        let output = std::process::Command::new("tar")
            .args(["-czf", &tar_path.to_string_lossy(), "-T", "/dev/null"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .status();
        return matches!(output, Ok(status) if status.success());
    }

    // Write NUL-separated file list for tar -T --null (handles filenames with newlines)
    let list_path = tar_path.with_extension("filelist");
    let mut list_content = file_paths.join("\0");
    list_content.push('\0'); // trailing NUL for strict NUL-termination
    if let Err(e) = std::fs::write(&list_path, &list_content) {
        log_error!(LOG_TAG, "Failed to write file list: {e}");
        return false;
    }

    let output = std::process::Command::new("tar")
        .args([
            "--hard-dereference",
            "--null",
            "-czf",
            &tar_path.to_string_lossy(),
            "-C",
            dir_path,
            "-T",
            &list_path.to_string_lossy(),
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .status();

    // Clean up file list
    let _ = std::fs::remove_file(&list_path);

    match output {
        Ok(status) if status.success() => true,
        Ok(status) => {
            log_error!(
                LOG_TAG,
                "tar failed with exit code {}",
                status.code().unwrap_or(-1)
            );
            false
        }
        Err(e) => {
            log_error!(LOG_TAG, "Failed to create archive: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs as unix_fs;

    #[test]
    fn walk_dir_skips_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Regular file
        std::fs::write(root.join("real.txt"), "hello").unwrap();

        // Symlink to file
        unix_fs::symlink(root.join("real.txt"), root.join("link.txt")).unwrap();

        // Symlink to directory outside
        std::fs::create_dir(root.join("subdir")).unwrap();
        std::fs::write(root.join("subdir/inner.txt"), "inner").unwrap();
        unix_fs::symlink(root.join("subdir"), root.join("link_dir")).unwrap();

        // Dangling symlink
        unix_fs::symlink("/nonexistent", root.join("dangling")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        // Regular files should be included
        assert!(paths.contains(&"real.txt"));
        assert!(paths.contains(&"subdir/inner.txt"));

        // Symlinks should NOT be included
        assert!(!paths.contains(&"link.txt"));
        assert!(!paths.contains(&"link_dir"));
        assert!(!paths.contains(&"dangling"));

        // link_dir contents should NOT appear (symlink dir skipped, not followed)
        assert!(!paths.iter().any(|p| p.starts_with("link_dir/")));
    }

    #[test]
    fn walk_dir_handles_hardlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        std::fs::write(root.join("original.txt"), "content").unwrap();
        std::fs::hard_link(root.join("original.txt"), root.join("hardlink.txt")).unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        // Both original and hardlink should be recorded as independent files
        assert!(paths.contains(&"original.txt"));
        assert!(paths.contains(&"hardlink.txt"));

        // Both should have the same hash
        let original = files.iter().find(|f| f.path == "original.txt").unwrap();
        let hardlink = files.iter().find(|f| f.path == "hardlink.txt").unwrap();
        assert_eq!(original.hash, hardlink.hash);
        assert_eq!(original.size, hardlink.size);
    }

    #[test]
    fn archive_excludes_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Regular files
        std::fs::write(root.join("real.txt"), "hello").unwrap();
        std::fs::create_dir(root.join("subdir")).unwrap();
        std::fs::write(root.join("subdir/inner.txt"), "inner").unwrap();

        // Symlinks (should NOT end up in the archive)
        unix_fs::symlink(root.join("real.txt"), root.join("link.txt")).unwrap();
        unix_fs::symlink("/nonexistent", root.join("dangling")).unwrap();

        // Collect metadata (skips symlinks)
        let files = collect_file_metadata(root.to_str().unwrap());
        let file_paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();

        // Create archive using only manifest file list
        let tar_path = dir.path().join("archive.tar.gz");
        assert!(create_archive(
            root.to_str().unwrap(),
            &tar_path,
            &file_paths
        ));

        // Extract and verify archive contents match manifest exactly
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir(&extract_dir).unwrap();
        let status = std::process::Command::new("tar")
            .args([
                "-xzf",
                tar_path.to_str().unwrap(),
                "-C",
                extract_dir.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(status.success());

        // Manifest files should exist
        assert!(extract_dir.join("real.txt").exists());
        assert!(extract_dir.join("subdir/inner.txt").exists());

        // Symlinks should NOT exist in the archive
        assert!(!extract_dir.join("link.txt").exists());
        assert!(!extract_dir.join("dangling").exists());
    }

    #[test]
    fn archive_handles_special_filenames() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Files with spaces and special characters
        std::fs::write(root.join("file with spaces.txt"), "spaces").unwrap();
        std::fs::create_dir(root.join("dir with spaces")).unwrap();
        std::fs::write(root.join("dir with spaces/inner.txt"), "inner").unwrap();
        std::fs::write(root.join("file-with-dashes.txt"), "dashes").unwrap();
        // File with newline in name
        std::fs::write(root.join("line1\nline2.txt"), "newline").unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());
        let file_paths: Vec<String> = files.iter().map(|f| f.path.clone()).collect();

        let tar_path = dir.path().join("archive.tar.gz");
        assert!(create_archive(
            root.to_str().unwrap(),
            &tar_path,
            &file_paths
        ));

        // Extract and verify
        let extract_dir = dir.path().join("extracted");
        std::fs::create_dir(&extract_dir).unwrap();
        let status = std::process::Command::new("tar")
            .args([
                "-xzf",
                tar_path.to_str().unwrap(),
                "-C",
                extract_dir.to_str().unwrap(),
            ])
            .status()
            .unwrap();
        assert!(status.success());

        assert!(extract_dir.join("file with spaces.txt").exists());
        assert!(extract_dir.join("dir with spaces/inner.txt").exists());
        assert!(extract_dir.join("file-with-dashes.txt").exists());
        assert!(extract_dir.join("line1\nline2.txt").exists());
    }

    #[test]
    fn archive_empty_files() {
        let dir = tempfile::tempdir().unwrap();
        let tar_path = dir.path().join("empty.tar.gz");
        assert!(create_archive("/tmp", &tar_path, &[]));
        assert!(tar_path.exists());
    }

    #[test]
    fn collect_file_metadata_excludes_git_and_vm0() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // Regular file
        std::fs::write(root.join("main.rs"), "fn main() {}").unwrap();

        // .git directory (should be excluded)
        std::fs::create_dir(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/main").unwrap();
        std::fs::create_dir(root.join(".git/objects")).unwrap();
        std::fs::write(root.join(".git/objects/pack"), "data").unwrap();

        // .vm0 directory (should be excluded)
        std::fs::create_dir(root.join(".vm0")).unwrap();
        std::fs::write(root.join(".vm0/config.json"), "{}").unwrap();

        // Nested directory with a .git-like name (should NOT be excluded)
        std::fs::create_dir(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "pub fn hello() {}").unwrap();

        let files = collect_file_metadata(root.to_str().unwrap());
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert!(paths.contains(&"main.rs"));
        assert!(paths.contains(&"src/lib.rs"));

        // .git and .vm0 contents must NOT be present
        assert!(!paths.iter().any(|p| p.starts_with(".git")));
        assert!(!paths.iter().any(|p| p.starts_with(".vm0")));
    }

    #[test]
    fn compute_file_hash_known_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, "hello world").unwrap();

        let (hash, size) = compute_file_hash(&path).unwrap();
        assert_eq!(size, 11);
        // SHA-256 of "hello world"
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn compute_file_hash_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty.txt");
        std::fs::write(&path, "").unwrap();

        let (hash, size) = compute_file_hash(&path).unwrap();
        assert_eq!(size, 0);
        // SHA-256 of empty string
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn collect_file_metadata_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let files = collect_file_metadata(dir.path().to_str().unwrap());
        assert!(files.is_empty());
    }

    #[test]
    fn collect_file_metadata_nonexistent_dir() {
        let files = collect_file_metadata("/nonexistent/path/that/does/not/exist");
        assert!(files.is_empty());
    }

    #[test]
    fn fingerprint_stable_for_identical_content() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("m.md"), "hello").unwrap();
        std::fs::write(b.path().join("m.md"), "hello").unwrap();
        let fa = compute_directory_fingerprint(a.path().to_str().unwrap());
        let fb = compute_directory_fingerprint(b.path().to_str().unwrap());
        assert_eq!(fa, fb);
    }

    #[test]
    fn fingerprint_changes_on_content_edit() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("m.md"), "v1").unwrap();
        let f1 = compute_directory_fingerprint(dir.path().to_str().unwrap());
        std::fs::write(dir.path().join("m.md"), "v2-edited").unwrap();
        let f2 = compute_directory_fingerprint(dir.path().to_str().unwrap());
        assert_ne!(f1, f2);
    }

    #[test]
    fn fingerprint_changes_on_file_added() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("m.md"), "same").unwrap();
        let f1 = compute_directory_fingerprint(dir.path().to_str().unwrap());
        std::fs::write(dir.path().join("extra.md"), "new").unwrap();
        let f2 = compute_directory_fingerprint(dir.path().to_str().unwrap());
        assert_ne!(f1, f2);
    }

    #[test]
    fn fingerprint_changes_on_file_removed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        std::fs::write(dir.path().join("b.md"), "y").unwrap();
        let f1 = compute_directory_fingerprint(dir.path().to_str().unwrap());
        std::fs::remove_file(dir.path().join("b.md")).unwrap();
        let f2 = compute_directory_fingerprint(dir.path().to_str().unwrap());
        assert_ne!(f1, f2);
    }

    #[test]
    fn fingerprint_ignores_git_and_vm0() {
        let with_extras = tempfile::tempdir().unwrap();
        let without = tempfile::tempdir().unwrap();
        std::fs::write(with_extras.path().join("m.md"), "same").unwrap();
        std::fs::create_dir(with_extras.path().join(".git")).unwrap();
        std::fs::write(with_extras.path().join(".git/HEAD"), "x").unwrap();
        std::fs::create_dir(with_extras.path().join(".vm0")).unwrap();
        std::fs::write(with_extras.path().join(".vm0/cfg"), "y").unwrap();
        std::fs::write(without.path().join("m.md"), "same").unwrap();
        assert_eq!(
            compute_directory_fingerprint(with_extras.path().to_str().unwrap()),
            compute_directory_fingerprint(without.path().to_str().unwrap()),
        );
    }

    #[test]
    fn fingerprint_empty_dir_matches_nonexistent() {
        let dir = tempfile::tempdir().unwrap();
        let fp_empty = compute_directory_fingerprint(dir.path().to_str().unwrap());
        let fp_missing = compute_directory_fingerprint("/nonexistent/for/fingerprint");
        assert_eq!(fp_empty, fp_missing);
    }

    #[test]
    fn fingerprint_order_independent() {
        // `walk_dir` uses filesystem order, which isn't guaranteed. The
        // fingerprint sorts by path before hashing — verify that matters by
        // checking two sets with the same content produce the same hash even
        // if created in different orders.
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("z.md"), "last").unwrap();
        std::fs::write(a.path().join("a.md"), "first").unwrap();
        std::fs::write(b.path().join("a.md"), "first").unwrap();
        std::fs::write(b.path().join("z.md"), "last").unwrap();
        assert_eq!(
            compute_directory_fingerprint(a.path().to_str().unwrap()),
            compute_directory_fingerprint(b.path().to_str().unwrap()),
        );
    }
}
