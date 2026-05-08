use flate2::Compression;
use flate2::write::GzEncoder;
use httpmock::prelude::*;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use tempfile::TempDir;

static RUN_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

enum TarEntry<'a> {
    File(&'a str, &'a [u8]),
    Symlink(&'a str, &'a str),
    Hardlink(&'a str, &'a str),
    /// Hand-crafted entry for malicious-input tests that `tar::Builder`
    /// rejects (absolute paths, `..` components, empty linkname). Always
    /// written after all non-Raw entries in the archive.
    Raw {
        path: &'a [u8],
        /// Typeflag byte: `b'0'` regular file, `b'2'` symlink.
        entry_type: u8,
        /// Octal mode string like `b"0000644\0"`.
        mode: &'a [u8; 8],
        /// Empty = no data block appended (size stays zero).
        content: &'a [u8],
    },
}

/// Create a tar.gz archive in memory containing the given files.
fn create_tar_gz(files: &[(&str, &[u8])]) -> std::io::Result<Vec<u8>> {
    let entries: Vec<TarEntry> = files.iter().map(|(p, c)| TarEntry::File(p, c)).collect();
    create_tar_gz_entries(&entries)
}

/// Create a tar.gz archive with mixed file and symlink entries.
fn create_tar_gz_entries(entries: &[TarEntry]) -> std::io::Result<Vec<u8>> {
    /// Strip builder-written EOF, splice hand-crafted tar headers onto the
    /// end, and re-add EOF. Scoped as an inner fn so the indexing-slicing
    /// allow (needed because `allow-indexing-slicing-in-tests` only matches
    /// `#[test]` fns, not helper fns) stays off the rest of the helper.
    #[allow(clippy::indexing_slicing)]
    fn append_raw_entries(tar_data: &mut Vec<u8>, entries: &[TarEntry]) {
        while tar_data.len() >= 512 && tar_data[tar_data.len() - 512..].iter().all(|&b| b == 0) {
            tar_data.truncate(tar_data.len() - 512);
        }
        for entry in entries {
            if let TarEntry::Raw {
                path,
                entry_type,
                mode,
                content,
            } = entry
            {
                let mut header_block = [0u8; 512];
                header_block[..path.len()].copy_from_slice(path);
                header_block[100..108].copy_from_slice(*mode);
                header_block[108..116].copy_from_slice(b"0000000\0"); // uid
                header_block[116..124].copy_from_slice(b"0000000\0"); // gid
                let size_str = format!("{:011o}\0", content.len());
                header_block[124..136].copy_from_slice(size_str.as_bytes());
                header_block[136..148].copy_from_slice(b"00000000000\0"); // mtime
                header_block[156] = *entry_type;
                header_block[257..263].copy_from_slice(b"ustar\0");
                header_block[263..265].copy_from_slice(b"00");
                // Checksum: field filled with spaces, sum all bytes, write result.
                header_block[148..156].copy_from_slice(b"        ");
                let cksum: u32 = header_block.iter().map(|&b| b as u32).sum();
                let cksum_str = format!("{:06o}\0 ", cksum);
                header_block[148..156].copy_from_slice(cksum_str.as_bytes());

                tar_data.extend_from_slice(&header_block);
                if !content.is_empty() {
                    let mut data_block = [0u8; 512];
                    data_block[..content.len()].copy_from_slice(content);
                    tar_data.extend_from_slice(&data_block);
                }
            }
        }
        tar_data.extend_from_slice(&[0u8; 1024]); // EOF
    }

    let mut tar_data = Vec::new();
    let has_raw = entries.iter().any(|e| matches!(e, TarEntry::Raw { .. }));
    {
        let mut builder = tar::Builder::new(&mut tar_data);
        for entry in entries {
            match entry {
                TarEntry::File(path, contents) => {
                    let mut header = tar::Header::new_gnu();
                    header.set_size(contents.len() as u64);
                    header.set_mode(0o644);
                    header.set_cksum();
                    builder.append_data(&mut header, path, *contents)?;
                }
                TarEntry::Symlink(path, target) => {
                    let mut header = tar::Header::new_gnu();
                    header.set_size(0);
                    header.set_mode(0o777);
                    header.set_entry_type(tar::EntryType::Symlink);
                    header.set_cksum();
                    builder.append_link(&mut header, path, target)?;
                }
                TarEntry::Hardlink(path, target) => {
                    let mut header = tar::Header::new_gnu();
                    header.set_size(0);
                    header.set_mode(0o644);
                    header.set_entry_type(tar::EntryType::Link);
                    header.set_cksum();
                    builder.append_link(&mut header, path, target)?;
                }
                TarEntry::Raw { .. } => {} // appended after builder finishes
            }
        }
        builder.finish()?;
    }

    if has_raw {
        append_raw_entries(&mut tar_data, entries);
    }

    let mut gz_data = Vec::new();
    let mut encoder = GzEncoder::new(&mut gz_data, Compression::fast());
    encoder.write_all(&tar_data)?;
    encoder.finish()?;
    Ok(gz_data)
}

/// Write a manifest JSON to a temp file and return its path.
/// `storages`: list of (mount_path, archive_url) pairs.
/// `artifact`: optional (mount_path, archive_url) pair.
fn write_manifest(
    dir: &TempDir,
    storages: &[(&str, Option<&str>)],
    artifact: Option<(&str, Option<&str>)>,
) -> std::io::Result<PathBuf> {
    let storages_json: Vec<String> = storages
        .iter()
        .map(|(mount_path, archive_url)| match archive_url {
            Some(url) => format!(r#"{{"mountPath":"{}","archiveUrl":"{}"}}"#, mount_path, url),
            None => format!(r#"{{"mountPath":"{}"}}"#, mount_path),
        })
        .collect();

    let artifact_json = artifact.map(|(mount_path, archive_url)| match archive_url {
        Some(url) => format!(
            r#","artifacts":[{{"mountPath":"{}","archiveUrl":"{}"}}]"#,
            mount_path, url
        ),
        None => format!(r#","artifacts":[{{"mountPath":"{}"}}]"#, mount_path),
    });

    let json = format!(
        r#"{{"storages":[{}]{}}}"#,
        storages_json.join(","),
        artifact_json.unwrap_or_default(),
    );

    let manifest_path = dir.path().join("manifest.json");
    std::fs::write(&manifest_path, json)?;
    Ok(manifest_path)
}

fn run_guest_download(manifest_path: &str) -> bool {
    guest_common::log::clear_system_log_file();
    guest_download::run(manifest_path)
}

fn unique_run_id(test_name: &str) -> String {
    format!(
        "guest-download-{test_name}-{}-{}",
        std::process::id(),
        RUN_ID_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

struct RunFileCleanup {
    paths: Vec<String>,
}

impl RunFileCleanup {
    fn new(paths: Vec<String>) -> Self {
        for path in &paths {
            let _ = std::fs::remove_file(path);
        }
        Self { paths }
    }
}

impl Drop for RunFileCleanup {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[test]
fn binary_writes_system_log_to_guest_common_default_path() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();
    let run_id = unique_run_id("success");
    let system_log = format!("/tmp/vm0-system-{run_id}.log");
    let ops_log = format!("/tmp/vm0-sandbox-ops-{run_id}.jsonl");
    let _cleanup = RunFileCleanup::new(vec![system_log.clone(), ops_log.clone()]);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest_path)
        .env("VM0_RUN_ID", &run_id)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let content = std::fs::read_to_string(&system_log).unwrap();
    assert!(
        content.contains("[INFO] [sandbox:download] Download completed"),
        "unexpected system log: {content:?}"
    );
    assert_eq!(content.matches("Download completed").count(), 1);

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("[INFO] [sandbox:download] Download completed"));
    let ops_content = std::fs::read_to_string(&ops_log).unwrap();
    let totals: Vec<serde_json::Value> = ops_content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|entry: &serde_json::Value| entry["action_type"] == "download_total")
        .collect();
    assert_eq!(totals.len(), 1, "unexpected ops log: {ops_content}");
    assert_eq!(totals[0]["success"], true);
}

#[test]
fn binary_writes_system_log_on_manifest_read_failure() {
    let run_id = unique_run_id("missing-manifest");
    let system_log = format!("/tmp/vm0-system-{run_id}.log");
    let ops_log = format!("/tmp/vm0-sandbox-ops-{run_id}.jsonl");
    let _cleanup = RunFileCleanup::new(vec![system_log.clone(), ops_log.clone()]);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg("/tmp/nonexistent-guest-download-manifest.json")
        .env("VM0_RUN_ID", &run_id)
        .output()
        .unwrap();

    assert!(!output.status.success());

    let content = std::fs::read_to_string(&system_log).unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:download] Failed to read manifest"),
        "unexpected system log: {content:?}"
    );
    assert!(
        content.contains("[ERROR] [sandbox:download] Download failed"),
        "unexpected system log: {content:?}"
    );
    let ops_content = std::fs::read_to_string(&ops_log).unwrap();
    let totals: Vec<serde_json::Value> = ops_content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .filter(|entry: &serde_json::Value| entry["action_type"] == "download_total")
        .collect();
    assert_eq!(totals.len(), 1, "unexpected ops log: {ops_content}");
    assert_eq!(totals[0]["success"], false);
}

#[test]
fn binary_without_manifest_path_logs_usage() {
    let run_id = unique_run_id("missing-arg");
    let system_log = format!("/tmp/vm0-system-{run_id}.log");
    let ops_log = format!("/tmp/vm0-sandbox-ops-{run_id}.jsonl");
    let _cleanup = RunFileCleanup::new(vec![system_log.clone(), ops_log.clone()]);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .env("VM0_RUN_ID", &run_id)
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("[ERROR] [sandbox:download] Usage: guest-download <manifest_path>"),
        "unexpected stderr: {stderr}"
    );
    let content = std::fs::read_to_string(&system_log).unwrap();
    assert!(
        content.contains("[ERROR] [sandbox:download] Usage: guest-download <manifest_path>"),
        "unexpected system log: {content:?}"
    );
    assert!(
        !std::path::Path::new(&ops_log).exists(),
        "usage failure should not record download_total before a run starts"
    );
}

#[test]
fn binary_panics_without_run_id_for_default_system_log() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest_path)
        .env_remove("VM0_RUN_ID")
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("VM0_RUN_ID is required for guest system logging"),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn binary_panics_with_empty_run_id_for_default_system_log() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = write_manifest(&dir, &[], None).unwrap();

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_guest-download"))
        .arg(&manifest_path)
        .env("VM0_RUN_ID", "")
        .output()
        .unwrap();

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("VM0_RUN_ID is required for guest system logging"),
        "unexpected stderr: {stderr}"
    );
}

// ---------------------------------------------------------------------------
// Test 1: single storage download succeeds
// ---------------------------------------------------------------------------
#[test]
fn single_storage_download() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz(&[("hello.txt", b"hello world")]).unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("hello.txt")).unwrap(),
        "hello world"
    );
}

// ---------------------------------------------------------------------------
// Test 2: 6 storages downloaded in parallel (exercises chunking)
// ---------------------------------------------------------------------------
#[test]
fn six_storages_parallel() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();

    let mut storages = Vec::new();
    let mut mocks = Vec::new();

    for i in 0..6 {
        let filename = format!("file_{i}.txt");
        let content = format!("content_{i}");
        let tar_gz = create_tar_gz(&[(&filename, content.as_bytes())]).unwrap();
        let path = format!("/storage_{i}.tar.gz");

        let mock = server.mock(|when, then| {
            when.method(GET).path(path.clone());
            then.status(200)
                .header("content-type", "application/gzip")
                .body(&tar_gz);
        });
        mocks.push(mock);

        let mount = dir.path().join(format!("mount_{i}"));
        storages.push((
            mount.to_str().unwrap().to_string(),
            server.url(format!("/storage_{i}.tar.gz")),
        ));
    }

    let storage_refs: Vec<(&str, Option<&str>)> = storages
        .iter()
        .map(|(m, u)| (m.as_str(), Some(u.as_str())))
        .collect();

    let manifest = write_manifest(&dir, &storage_refs, None).unwrap();
    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);

    for (i, mock) in mocks.iter().enumerate() {
        mock.assert();
        let mount = dir.path().join(format!("mount_{i}"));
        let content = std::fs::read_to_string(mount.join(format!("file_{i}.txt"))).unwrap();
        assert_eq!(content, format!("content_{i}"));
    }
}

// ---------------------------------------------------------------------------
// Test 2b: parent-child mount paths in same concurrent chunk
// Regression test: storages with overlapping paths (e.g. /home/user/.claude and
// /home/user/.claude/skills/foo) must not race on directory creation.
// ---------------------------------------------------------------------------
#[test]
fn parent_child_mount_paths_parallel() {
    let server = MockServer::start();
    let dir = tempfile::tempdir().unwrap();

    let parent_tar = create_tar_gz(&[("config.json", b"parent config")]).unwrap();
    let child_a_tar = create_tar_gz(&[("skill.json", b"skill a")]).unwrap();
    let child_b_tar = create_tar_gz(&[("skill.json", b"skill b")]).unwrap();
    let child_c_tar = create_tar_gz(&[("skill.json", b"skill c")]).unwrap();

    let m_parent = server.mock(|when, then| {
        when.method(GET).path("/parent.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&parent_tar);
    });
    let m_child_a = server.mock(|when, then| {
        when.method(GET).path("/child_a.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&child_a_tar);
    });
    let m_child_b = server.mock(|when, then| {
        when.method(GET).path("/child_b.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&child_b_tar);
    });
    let m_child_c = server.mock(|when, then| {
        when.method(GET).path("/child_c.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&child_c_tar);
    });

    // 4 tasks fill one concurrent chunk (MAX_CONCURRENT=4), ensuring parent
    // and children are truly downloaded in parallel.
    let parent_mount = dir.path().join("claude");
    let child_a_mount = dir.path().join("claude/skills/alpha");
    let child_b_mount = dir.path().join("claude/skills/beta");
    let child_c_mount = dir.path().join("claude/skills/gamma");

    let url_parent = server.url("/parent.tar.gz");
    let url_child_a = server.url("/child_a.tar.gz");
    let url_child_b = server.url("/child_b.tar.gz");
    let url_child_c = server.url("/child_c.tar.gz");

    let storages: Vec<(&str, Option<&str>)> = vec![
        (parent_mount.to_str().unwrap(), Some(&url_parent)),
        (child_a_mount.to_str().unwrap(), Some(&url_child_a)),
        (child_b_mount.to_str().unwrap(), Some(&url_child_b)),
        (child_c_mount.to_str().unwrap(), Some(&url_child_c)),
    ];

    let manifest = write_manifest(&dir, &storages, None).unwrap();
    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    m_parent.assert();
    m_child_a.assert();
    m_child_b.assert();
    m_child_c.assert();

    assert_eq!(
        std::fs::read_to_string(parent_mount.join("config.json")).unwrap(),
        "parent config"
    );
    assert_eq!(
        std::fs::read_to_string(child_a_mount.join("skill.json")).unwrap(),
        "skill a"
    );
    assert_eq!(
        std::fs::read_to_string(child_b_mount.join("skill.json")).unwrap(),
        "skill b"
    );
    assert_eq!(
        std::fs::read_to_string(child_c_mount.join("skill.json")).unwrap(),
        "skill c"
    );
}

// ---------------------------------------------------------------------------
// Test 3: artifact download succeeds
// ---------------------------------------------------------------------------
#[test]
fn artifact_download_success() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz(&[("artifact.txt", b"artifact data")]).unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/artifact.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("artifact_mount");
    let url = server.url("/artifact.tar.gz");
    let manifest = write_manifest(&dir, &[], Some((mount.to_str().unwrap(), Some(&url)))).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("artifact.txt")).unwrap(),
        "artifact data"
    );
}

// ---------------------------------------------------------------------------
// Test 4: artifact 404 is non-fatal
// ---------------------------------------------------------------------------
#[test]
fn artifact_404_non_fatal() {
    let server = MockServer::start();

    server.mock(|when, then| {
        when.method(GET).path("/artifact.tar.gz");
        then.status(404);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("artifact_mount");
    let url = server.url("/artifact.tar.gz");
    let manifest = write_manifest(&dir, &[], Some((mount.to_str().unwrap(), Some(&url)))).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());
    assert!(result);
}

// ---------------------------------------------------------------------------
// Test 5: storage 404 is fatal
// ---------------------------------------------------------------------------
#[test]
fn storage_404_fatal() {
    let server = MockServer::start();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(404);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());
    assert!(!result);
}

// ---------------------------------------------------------------------------
// Test 6: 5xx exhausts all retries
// ---------------------------------------------------------------------------
#[test]
fn server_error_exhausts_retries() {
    let server = MockServer::start();

    let mock = server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(500);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(!result);
    mock.assert_calls(3);
}

// ---------------------------------------------------------------------------
// Test 7: 429 exhausts all retries
// ---------------------------------------------------------------------------
#[test]
fn rate_limit_exhausts_retries() {
    let server = MockServer::start();

    let mock = server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(429);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(!result);
    mock.assert_calls(3);
}

// ---------------------------------------------------------------------------
// Test 8: invalid tar.gz data is non-retriable
// ---------------------------------------------------------------------------
#[test]
fn invalid_tar_gz_non_retriable() {
    let server = MockServer::start();

    let mock = server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body("this is not a valid tar.gz");
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(!result);
    mock.assert_calls(1);
}

// ---------------------------------------------------------------------------
// Test 9: null/missing URLs result in no downloads (success)
// ---------------------------------------------------------------------------
#[test]
fn null_and_missing_urls_skip_download() {
    let dir = tempfile::tempdir().unwrap();
    let mount1 = dir.path().join("mount1");
    let mount2 = dir.path().join("mount2");

    let manifest = write_manifest(
        &dir,
        &[
            (mount1.to_str().unwrap(), None),
            (mount2.to_str().unwrap(), Some("null")),
        ],
        None,
    )
    .unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());
    assert!(result);
}

// ---------------------------------------------------------------------------
// Test 10: manifest file not found
// ---------------------------------------------------------------------------
#[test]
fn manifest_file_not_found() {
    let result = run_guest_download("/tmp/nonexistent-manifest-path.json");
    assert!(!result);
}

// ---------------------------------------------------------------------------
// Test 11: manifest JSON invalid
// ---------------------------------------------------------------------------
#[test]
fn manifest_json_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let manifest_path = dir.path().join("manifest.json");
    std::fs::write(&manifest_path, "{{not valid json").unwrap();

    let result = run_guest_download(manifest_path.to_str().unwrap());
    assert!(!result);
}

// ---------------------------------------------------------------------------
// Test 12: artifact non-404 error (500) is fatal
// ---------------------------------------------------------------------------
#[test]
fn artifact_500_fatal() {
    let server = MockServer::start();

    let mock = server.mock(|when, then| {
        when.method(GET).path("/artifact.tar.gz");
        then.status(500);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("artifact_mount");
    let url = server.url("/artifact.tar.gz");
    let manifest = write_manifest(&dir, &[], Some((mount.to_str().unwrap(), Some(&url)))).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(!result);
    mock.assert_calls(3); // exhausts all retries
}

// ---------------------------------------------------------------------------
// Test 13: retry then succeed (5xx on first attempt, 200 on second)
// ---------------------------------------------------------------------------
#[test]
fn retry_then_succeed() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz(&[("recovered.txt", b"recovered")]).unwrap();

    // Start with a 500 mock
    let mut fail_mock = server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(500);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();
    let manifest_str = manifest.to_str().unwrap().to_string();

    // Run in background thread so we can swap the mock during RETRY_DELAY
    let handle = std::thread::spawn(move || run_guest_download(&manifest_str));

    // Poll until the first request has been made, then swap mock before retry fires (RETRY_DELAY = 1s).
    // Timeout after 5s to avoid infinite loop if the spawned thread panics before making a request.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while fail_mock.calls() < 1 {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for first mock hit"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    fail_mock.delete();
    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let result = handle.join().unwrap();
    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("recovered.txt")).unwrap(),
        "recovered"
    );
}

// ---------------------------------------------------------------------------
// Test 14: storages partial failure (one succeeds, one fails)
// ---------------------------------------------------------------------------
#[test]
fn storages_partial_failure() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz(&[("ok.txt", b"ok")]).unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/good.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    server.mock(|when, then| {
        when.method(GET).path("/bad.tar.gz");
        then.status(404);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount_good = dir.path().join("good");
    let mount_bad = dir.path().join("bad");
    let url_good = server.url("/good.tar.gz");
    let url_bad = server.url("/bad.tar.gz");

    let manifest = write_manifest(
        &dir,
        &[
            (mount_good.to_str().unwrap(), Some(&url_good)),
            (mount_bad.to_str().unwrap(), Some(&url_bad)),
        ],
        None,
    )
    .unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(!result);
    // The successful storage should still have extracted its file
    assert_eq!(
        std::fs::read_to_string(mount_good.join("ok.txt")).unwrap(),
        "ok"
    );
}

// ---------------------------------------------------------------------------
// Test 15: artifact with null/missing URL is skipped (no download)
// ---------------------------------------------------------------------------
#[test]
fn artifact_null_url_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("artifact_mount");

    // archiveUrl is the string "null" — should be treated as missing
    let manifest =
        write_manifest(&dir, &[], Some((mount.to_str().unwrap(), Some("null")))).unwrap();
    let result = run_guest_download(manifest.to_str().unwrap());
    assert!(result);

    // archiveUrl is absent entirely
    let manifest = write_manifest(&dir, &[], Some((mount.to_str().unwrap(), None))).unwrap();
    let result = run_guest_download(manifest.to_str().unwrap());
    assert!(result);
}

// Tests 16–19 (memory download success/404/500/null-url) removed in #10602.
// Memory no longer has a dedicated manifest slot — it rides in `artifacts[]`
// and is covered by the artifact tests above. The top-level `memory` field
// on the manifest is retained for wire compat and is deserialized-and-ignored;
// that parse path has no dedicated test (#10603 removes the field entirely).

// ---------------------------------------------------------------------------
// Test 20: symlink escaping target directory is skipped
// ---------------------------------------------------------------------------
#[test]
fn symlink_path_traversal_blocked() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("legit.txt", b"safe content"),
        TarEntry::Symlink("evil_link", "../../etc/passwd"),
    ])
    .unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    // Legitimate file should be extracted
    assert_eq!(
        std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
        "safe content"
    );
    // Symlink escaping the target should NOT be created (use symlink_metadata to
    // detect the symlink itself, since exists() follows symlinks and returns false for dangling)
    assert!(mount.join("evil_link").symlink_metadata().is_err());
}

// ---------------------------------------------------------------------------
// Test 21: symlink within target directory is allowed
// ---------------------------------------------------------------------------
#[test]
fn symlink_within_target_allowed() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("real.txt", b"real content"),
        TarEntry::Symlink("link.txt", "real.txt"),
    ])
    .unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("real.txt")).unwrap(),
        "real content"
    );
    // Symlink within target should be created
    assert!(
        mount
            .join("link.txt")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

// ---------------------------------------------------------------------------
// Test 22: entry path with .. components escaping target is skipped
// ---------------------------------------------------------------------------
#[test]
fn path_traversal_via_dotdot_blocked() {
    let server = MockServer::start();

    // tar::Builder rejects `..` paths, so hand-craft the entry via TarEntry::Raw.
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("legit.txt", b"safe"),
        TarEntry::Raw {
            path: b"../outside.txt",
            entry_type: b'0',
            mode: b"0000644\0",
            content: b"escaped",
        },
    ])
    .unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    // Legit file should be extracted
    assert_eq!(
        std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
        "safe"
    );
    // File should NOT be extracted outside the mount directory
    assert!(!dir.path().join("outside.txt").exists());
}

// ---------------------------------------------------------------------------
// Test 23: two-step symlink attack (symlink dir + file through it) is blocked
// ---------------------------------------------------------------------------
#[test]
fn two_step_symlink_attack_blocked() {
    let server = MockServer::start();

    // Attack: create a symlink "subdir" pointing to /tmp/evil-target, then
    // write a file "subdir/payload.txt" which would resolve through the symlink.
    let evil_target = tempfile::tempdir().unwrap();
    let evil_target_path = evil_target.path().to_str().unwrap();

    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("safe.txt", b"safe"),
        TarEntry::Symlink("subdir", evil_target_path),
        TarEntry::File("subdir/payload.txt", b"malicious"),
    ])
    .unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    // Safe file should be extracted
    assert_eq!(
        std::fs::read_to_string(mount.join("safe.txt")).unwrap(),
        "safe"
    );
    // Payload should NOT be written to the evil target directory
    assert!(!evil_target.path().join("payload.txt").exists());
}

// ---------------------------------------------------------------------------
// Test 24: hardlink escaping target directory is blocked
// ---------------------------------------------------------------------------
#[test]
fn hardlink_escaping_target_blocked() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("legit.txt", b"safe"),
        TarEntry::Hardlink("evil_hardlink", "/etc/passwd"),
    ])
    .unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
        "safe"
    );
    // Hardlink should NOT be created
    assert!(!mount.join("evil_hardlink").exists());
}

// ---------------------------------------------------------------------------
// Test 25: symlink with relative .. target escaping is blocked
// ---------------------------------------------------------------------------
#[test]
fn symlink_relative_dotdot_escape_blocked() {
    let server = MockServer::start();

    // Create a file outside mount to verify the symlink can't reach it
    let dir = tempfile::tempdir().unwrap();
    let outside_file = dir.path().join("secret.txt");
    std::fs::write(&outside_file, "secret data").unwrap();

    // Symlink target uses .. to escape mount and reach the parent dir
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("legit.txt", b"safe"),
        TarEntry::Symlink("escape", "../secret.txt"),
    ])
    .unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
        "safe"
    );
    // Symlink should NOT be created (symlink_metadata detects even dangling symlinks)
    assert!(mount.join("escape").symlink_metadata().is_err());
}

// ---------------------------------------------------------------------------
// Test 26: two-step attack via deeper nested path is blocked
// ---------------------------------------------------------------------------
#[test]
fn two_step_attack_deep_nested_blocked() {
    let server = MockServer::start();

    // Attack: symlink "a" points outside, then file "a/b/c.txt" tries to
    // write through it. The immediate parent "a/b" doesn't exist, but
    // ancestor "a" is the escaping symlink.
    let evil_target = tempfile::tempdir().unwrap();
    let evil_target_path = evil_target.path().to_str().unwrap();

    let tar_gz = create_tar_gz_entries(&[
        TarEntry::Symlink("a", evil_target_path),
        TarEntry::File("a/b/c.txt", b"payload"),
    ])
    .unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    // Payload should NOT be written to the evil target
    assert!(!evil_target.path().join("b").exists());
    assert!(!evil_target.path().join("b/c.txt").exists());
}

// ---------------------------------------------------------------------------
// Test 27: hardlink with relative .. escaping is blocked
// ---------------------------------------------------------------------------
#[test]
fn hardlink_relative_dotdot_escape_blocked() {
    let server = MockServer::start();
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("legit.txt", b"safe"),
        TarEntry::Hardlink("evil_hardlink", "../../../etc/passwd"),
    ])
    .unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
        "safe"
    );
    assert!(!mount.join("evil_hardlink").exists());
}

// ---------------------------------------------------------------------------
// Test 28: absolute path entry is blocked
// ---------------------------------------------------------------------------
#[test]
fn absolute_path_entry_blocked() {
    let server = MockServer::start();

    // tar::Builder rejects absolute paths, so hand-craft the entry.
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("legit.txt", b"safe"),
        TarEntry::Raw {
            path: b"/etc/passwd",
            entry_type: b'0',
            mode: b"0000644\0",
            content: b"malicious",
        },
    ])
    .unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
        "safe"
    );
    // Absolute path entry should NOT be extracted
    assert!(!mount.join("etc/passwd").exists());
}

// ---------------------------------------------------------------------------
// Test 29: symlink with missing link target is skipped
// ---------------------------------------------------------------------------
#[test]
fn symlink_missing_link_target_skipped() {
    let server = MockServer::start();

    // Symlink entry with empty linkname (bytes 157..257 stay zeroed). tar::Builder
    // requires a non-empty target, so hand-craft the entry.
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("legit.txt", b"safe"),
        TarEntry::Raw {
            path: b"bad_symlink",
            entry_type: b'2',
            mode: b"0000777\0",
            content: b"",
        },
    ])
    .unwrap();

    server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("legit.txt")).unwrap(),
        "safe"
    );
    // Malformed symlink should NOT be created
    assert!(mount.join("bad_symlink").symlink_metadata().is_err());
}

// ---------------------------------------------------------------------------
// file:// scheme — host-staged tarballs (epic #10800)
// ---------------------------------------------------------------------------

// Successful file:// extraction: the local tarball is read and its contents are
// extracted into the mount path. The staged tarball is intentionally left in
// place — /tmp is wiped on VM teardown, and deleting it early breaks runs where
// two manifest entries share the same staged path.
#[test]
fn file_scheme_extraction_success() {
    let tar_gz = create_tar_gz(&[("hello.txt", b"hello from file")]).unwrap();

    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("staged.tar.gz");
    std::fs::write(&staged, &tar_gz).unwrap();

    let mount = dir.path().join("mount");
    let url = format!("file://{}", staged.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("hello.txt")).unwrap(),
        "hello from file"
    );
    // Staged tarball is preserved — runner cleans /tmp on VM teardown.
    assert!(staged.exists());
}

// Security regression: file:// archives use the same extraction path as HTTP,
// but this is the production path for runner-staged storage cache tarballs.
#[test]
fn file_scheme_malicious_entries_are_skipped_while_safe_entries_extract() {
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("safe.txt", b"safe"),
        TarEntry::Symlink("evil_symlink", "../outside.txt"),
        TarEntry::Hardlink("evil_hardlink", "../outside.txt"),
        TarEntry::Raw {
            path: b"../path_escape.txt",
            entry_type: b'0',
            mode: b"0000644\0",
            content: b"escaped",
        },
    ])
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let outside_file = dir.path().join("outside.txt");
    std::fs::write(&outside_file, "outside").unwrap();

    let staged = dir.path().join("staged.tar.gz");
    std::fs::write(&staged, &tar_gz).unwrap();

    let mount = dir.path().join("mount");
    let url = format!("file://{}", staged.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("safe.txt")).unwrap(),
        "safe"
    );
    assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "outside");
    assert!(!dir.path().join("path_escape.txt").exists());
    assert!(mount.join("evil_symlink").symlink_metadata().is_err());
    assert!(!mount.join("evil_hardlink").exists());
}

// Security regression: this exercises the ancestor symlink guard directly. The
// archive does not create the symlink; it is already present in the target.
#[test]
fn file_scheme_preexisting_symlink_ancestor_blocks_nested_entry() {
    let tar_gz = create_tar_gz_entries(&[
        TarEntry::File("safe.txt", b"safe"),
        TarEntry::File("escape/payload.txt", b"malicious"),
    ])
    .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let staged = dir.path().join("staged.tar.gz");
    std::fs::write(&staged, &tar_gz).unwrap();

    let mount = dir.path().join("mount");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&mount).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, mount.join("escape")).unwrap();

    let url = format!("file://{}", staged.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    assert_eq!(
        std::fs::read_to_string(mount.join("safe.txt")).unwrap(),
        "safe"
    );
    assert!(!outside.join("payload.txt").exists());
    assert!(
        mount
            .join("escape")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

// Storage with a missing file:// target fails the run. The runner only rewrites
// archive_url to file:// after vsock-staging succeeds, so a missing file means a
// broken runner contract — fatal, no retry (status_code is None, retriable false).
#[test]
fn file_scheme_missing_storage_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("never-existed.tar.gz");
    assert!(!missing.exists());

    let mount = dir.path().join("mount");
    let url = format!("file://{}", missing.display());
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());
    assert!(!result);
}

// Artifacts treat HTTP 404 as non-fatal ("may not exist on first run"), but the
// file:// path has no status_code, so a missing local file is fatal for artifacts
// too. Same reasoning as storages: the runner only stages + rewrites after the
// file lands, so a missing file signals a broken contract, not an absent artifact.
#[test]
fn file_scheme_missing_artifact_fatal() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("never-existed.tar.gz");
    assert!(!missing.exists());

    let mount = dir.path().join("artifact_mount");
    let url = format!("file://{}", missing.display());
    let manifest = write_manifest(&dir, &[], Some((mount.to_str().unwrap(), Some(&url)))).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());
    assert!(!result);
}
