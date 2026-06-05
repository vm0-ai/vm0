use crate::support::{
    TarEntry, create_tar_gz, create_tar_gz_entries, run_guest_download, write_manifest,
};
use httpmock::prelude::*;

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

#[test]
fn http_storage_malicious_entries_are_skipped_while_safe_entries_extract() {
    let server = MockServer::start();
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

    let mock = server.mock(|when, then| {
        when.method(GET).path("/storage.tar.gz");
        then.status(200)
            .header("content-type", "application/gzip")
            .body(&tar_gz);
    });

    let dir = tempfile::tempdir().unwrap();
    let outside_file = dir.path().join("outside.txt");
    std::fs::write(&outside_file, "outside").unwrap();

    let mount = dir.path().join("mount");
    let url = server.url("/storage.tar.gz");
    let manifest = write_manifest(&dir, &[(mount.to_str().unwrap(), Some(&url))], None).unwrap();

    let result = run_guest_download(manifest.to_str().unwrap());

    assert!(result);
    mock.assert_calls(1);
    assert_eq!(
        std::fs::read_to_string(mount.join("safe.txt")).unwrap(),
        "safe"
    );
    assert_eq!(std::fs::read_to_string(&outside_file).unwrap(), "outside");
    assert!(!dir.path().join("path_escape.txt").exists());
    assert!(mount.join("evil_symlink").symlink_metadata().is_err());
    assert!(!mount.join("evil_hardlink").exists());
}

// ---------------------------------------------------------------------------
// Test 2: 6 storages downloaded with bounded parallelism
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
// Test 2b: parent-child mount paths download successfully
// Regression test: storages with overlapping paths (e.g. /home/user/.claude and
// /home/user/.claude/skills/foo) must remain valid when scheduled safely.
// ---------------------------------------------------------------------------
#[test]
fn parent_child_mount_paths_download_successfully() {
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
