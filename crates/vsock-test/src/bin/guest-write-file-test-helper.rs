use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

const BLOCKING_PATH_SUFFIX: &str = ".vm0-vsock-test-block";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(path) = blocking_path(&args)
        && let Err(error) = wait_for_release(path)
    {
        eprintln!("failed to prepare blocking write helper: {error}");
        std::process::exit(1);
    }

    let code = guest_write_file::run_cli(args, io::stdin().lock(), io::stderr().lock());
    std::process::exit(code);
}

fn wait_for_release(path: &Path) -> io::Result<()> {
    std::fs::write(
        path_with_suffix(path, ".pid"),
        std::process::id().to_string(),
    )?;
    std::fs::write(path_with_suffix(path, ".started"), b"")?;
    let release = path_with_suffix(path, ".release");
    while !release.exists() {
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn blocking_path(args: &[String]) -> Option<&Path> {
    let path = Path::new(args.last()?);
    path.to_string_lossy()
        .ends_with(BLOCKING_PATH_SUFFIX)
        .then_some(path)
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}
