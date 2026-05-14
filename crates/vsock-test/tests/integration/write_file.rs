use crate::support::{Harness, shell_quote};

#[test]
fn shell_quote_escapes_single_quotes() {
    assert_eq!(shell_quote("chunked'quote.bin"), "'chunked'\\''quote.bin'");
}
// ── write_file ───────────────────────────────────────────────────────

#[tokio::test]
async fn test_write_file() {
    let h = Harness::new().await;

    let file_path = h.dir.join("testfile.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"hello from vsock-test";

    h.write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    // Verify by reading the file back via exec
    let result = h
        .exec(&format!("cat '{file_path_str}'"), 5000, &[], false)
        .await
        .expect("exec cat failed");

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, content);
    h.finish();
}

#[tokio::test]
async fn test_write_file_special_characters() {
    let h = Harness::new().await;

    let file_path = h.dir.join("special.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"Line1\nLine2\tTabbed\n\"Quoted\"";

    h.write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written, content);
    h.finish();
}

#[tokio::test]
async fn test_write_file_path_with_shell_metacharacters() {
    let h = Harness::new().await;

    let file_path = h.dir.join("dash - quote ' dollar $ semi ;.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"path should be passed as an argv value";

    h.write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written, content);
    h.finish();
}

#[tokio::test]
async fn test_write_file_creates_parent_dirs() {
    let h = Harness::new().await;

    let file_path = h.dir.join("a/b/c/nested.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    let content = b"nested content";

    h.write_file(&file_path_str, content, false)
        .await
        .expect("write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written, content);
    h.finish();
}

#[tokio::test]
async fn test_write_file_sudo_create_does_not_create_parent_dirs() {
    let h = Harness::new().await;

    let file_path = h.dir.join("sudo/missing/parent.txt");
    let file_path_str = file_path.to_string_lossy().to_string();

    h.write_file(&file_path_str, b"content", true)
        .await
        .expect_err("sudo write_file should fail when parent is missing");

    assert!(!file_path.exists());
    h.finish();
}

#[tokio::test]
async fn test_write_file_unwritable_path_fails() {
    let h = Harness::new().await;

    let path = format!("/proc/vm0-write-file-denied-{}", std::process::id());
    h.write_file(&path, b"content", false)
        .await
        .expect_err("write_file should fail under /proc");

    h.finish();
}
// ── write_file (large) ──────────────────────────────────────────────

#[tokio::test]
async fn test_write_file_large() {
    let h = Harness::new().await;

    let file_path = h.dir.join("large.txt");
    let file_path_str = file_path.to_string_lossy().to_string();
    // 100KB content
    let content = vec![b'x'; 100_000];

    h.write_file(&file_path_str, &content, false)
        .await
        .expect("write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written.len(), 100_000);
    assert_eq!(written, content);
    h.finish();
}

// ── write_file (chunked — exceeds single-message limit) ────────────

#[tokio::test]
async fn test_write_file_chunked() {
    let h = Harness::new().await;

    let file_path = h.dir.join("chunked'quote.bin");
    let file_path_str = file_path.to_string_lossy().to_string();
    // 16 MB content exceeds the 15 MB chunk limit, triggering the staging +
    // shell rename path. The quote in the file name covers shell escaping.
    let content = vec![0xABu8; 16 * 1024 * 1024];

    h.write_file(&file_path_str, &content, false)
        .await
        .expect("chunked write_file failed");

    let written = std::fs::read(&file_path).expect("failed to read written file");
    assert_eq!(written.len(), content.len());
    assert_eq!(written, content);

    // Temp file should not remain
    let temp_prefix = format!("{file_path_str}.vm0tmp-");
    let temp_remains = std::fs::read_dir(file_path.parent().unwrap())
        .expect("failed to read temp dir")
        .flatten()
        .any(|entry| entry.path().to_string_lossy().starts_with(&temp_prefix));
    assert!(!temp_remains, "temp file was not cleaned up");
    h.finish();
}

#[tokio::test]
#[ignore = "local performance comparison only; no stable timing assertion"]
async fn bench_write_file_many_small_files() {
    let h = Harness::new().await;

    let start = std::time::Instant::now();
    for i in 0..100 {
        let file_path = h.dir.join(format!("bench/{i}.txt"));
        let file_path_str = file_path.to_string_lossy().to_string();
        h.write_file(&file_path_str, b"small content", false)
            .await
            .expect("write_file failed");
    }
    eprintln!("100 small write_file calls took {:?}", start.elapsed());

    h.finish();
}
