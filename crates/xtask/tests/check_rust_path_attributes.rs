use std::error::Error;
use std::fs;
use std::io;
use std::path::Path;
use std::process::{Command, Output};

use tempfile::TempDir;

#[test]
fn accepts_native_modules_and_ignored_text() -> Result<(), Box<dyn Error>> {
    let repository = repository_with_source(
        r####"
// #[path = "comment.rs"]
/* #[path = "block-comment.rs"] */
const EXAMPLE: &str = r###"#[path = "string.rs"]"###;
mod native;
"####,
    )?;

    let output = run_check(repository.path())?;

    assert!(
        output.status.success(),
        "check failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    Ok(())
}

#[test]
fn rejects_direct_and_conditional_path_attributes() -> Result<(), Box<dyn Error>> {
    let repository = repository_with_source(
        r#"#[path = "legacy.rs"]
mod legacy;
#[cfg_attr(unix, path = "conditional.rs")]
mod conditional;
#[r#path = "raw-identifier.rs"]
mod raw_identifier;
"#,
    )?;

    let output = run_check(repository.path())?;
    let stderr = String::from_utf8(output.stderr)?;

    assert!(!output.status.success());
    assert!(stderr.contains("Rust #[path] attributes are forbidden"));
    assert!(stderr.contains("src/lib.rs:1"));
    assert!(stderr.contains("src/lib.rs:3"));
    assert!(stderr.contains("src/lib.rs:5"));

    Ok(())
}

fn repository_with_source(source: &str) -> Result<TempDir, Box<dyn Error>> {
    let repository = tempfile::tempdir()?;
    let src = repository.path().join("src");
    fs::create_dir_all(&src)?;
    fs::write(src.join("lib.rs"), source)?;

    let status = Command::new("git")
        .args(["init", "--quiet"])
        .current_dir(repository.path())
        .status()?;
    assert!(status.success());

    Ok(repository)
}

fn run_check(repository: &Path) -> io::Result<Output> {
    Command::new(env!("CARGO_BIN_EXE_xtask"))
        .arg("check-rust-path-attributes")
        .current_dir(repository)
        .output()
}
