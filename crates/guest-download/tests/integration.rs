use flate2::Compression;
use flate2::write::GzEncoder;
use httpmock::prelude::*;
use std::io::Write;
use std::path::PathBuf;
use tempfile::TempDir;

/// Create a tar.gz archive in memory containing the given files.
fn create_tar_gz(files: &[(&str, &[u8])]) -> std::io::Result<Vec<u8>> {
    let mut tar_data = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_data);
        for (path, contents) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, path, *contents)?;
        }
        builder.finish()?;
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
            r#","artifact":{{"mountPath":"{}","archiveUrl":"{}"}}"#,
            mount_path, url
        ),
        None => format!(r#","artifact":{{"mountPath":"{}"}}"#, mount_path),
    });

    let json = format!(
        r#"{{"storages":[{}]{}}}"#,
        storages_json.join(","),
        artifact_json.unwrap_or_default()
    );

    let manifest_path = dir.path().join("manifest.json");
    std::fs::write(&manifest_path, json)?;
    Ok(manifest_path)
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

    let result = guest_download::run(manifest.to_str().unwrap());

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
    let result = guest_download::run(manifest.to_str().unwrap());

    assert!(result);

    for (i, mock) in mocks.iter().enumerate() {
        mock.assert();
        let mount = dir.path().join(format!("mount_{i}"));
        let content = std::fs::read_to_string(mount.join(format!("file_{i}.txt"))).unwrap();
        assert_eq!(content, format!("content_{i}"));
    }
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

    let result = guest_download::run(manifest.to_str().unwrap());

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

    let result = guest_download::run(manifest.to_str().unwrap());
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

    let result = guest_download::run(manifest.to_str().unwrap());
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

    let result = guest_download::run(manifest.to_str().unwrap());

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

    let result = guest_download::run(manifest.to_str().unwrap());

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

    let result = guest_download::run(manifest.to_str().unwrap());

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

    let result = guest_download::run(manifest.to_str().unwrap());
    assert!(result);
}

// ---------------------------------------------------------------------------
// Test 10: manifest file not found
// ---------------------------------------------------------------------------
#[test]
fn manifest_file_not_found() {
    let result = guest_download::run("/tmp/nonexistent-manifest-path.json");
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

    let result = guest_download::run(manifest_path.to_str().unwrap());
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

    let result = guest_download::run(manifest.to_str().unwrap());

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
    let handle = std::thread::spawn(move || guest_download::run(&manifest_str));

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

    let result = guest_download::run(manifest.to_str().unwrap());

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
    let result = guest_download::run(manifest.to_str().unwrap());
    assert!(result);

    // archiveUrl is absent entirely
    let manifest = write_manifest(&dir, &[], Some((mount.to_str().unwrap(), None))).unwrap();
    let result = guest_download::run(manifest.to_str().unwrap());
    assert!(result);
}
