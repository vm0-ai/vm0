use guest_common::{log_error, log_info, telemetry::record_sandbox_op};
use std::io::{ErrorKind, Read as _};
use std::time::Instant;

const LOG_TAG: &str = "sandbox:download";
const MANIFEST_STDIN_ARG: &str = "--manifest-stdin";
const LEGACY_MANIFEST_PATH: &str = "/tmp/storage-manifest.json";
const USAGE: &str = "Usage: guest-download <manifest_path> | --manifest-stdin";

enum ManifestInput {
    Path(String),
    Stdin,
}

fn main() {
    guest_common::log::enable_system_log_file();

    let Some(input) = manifest_input_from_args() else {
        log_error!(LOG_TAG, "{USAGE}");
        std::process::exit(1);
    };

    let start = Instant::now();
    let success = run(input);
    let elapsed = start.elapsed();

    record_sandbox_op("download_total", elapsed, success, None);
    if success {
        log_info!(LOG_TAG, "Download completed in {}ms", elapsed.as_millis());
    } else {
        log_error!(LOG_TAG, "Download failed");
        std::process::exit(1);
    }
}

fn manifest_input_from_args() -> Option<ManifestInput> {
    let mut args = std::env::args().skip(1);
    let arg = args.next()?;
    if arg == MANIFEST_STDIN_ARG {
        if args.next().is_some() {
            return None;
        }
        Some(ManifestInput::Stdin)
    } else {
        Some(ManifestInput::Path(arg))
    }
}

fn run(input: ManifestInput) -> bool {
    match input {
        ManifestInput::Path(manifest_path) => guest_download::run(&manifest_path),
        ManifestInput::Stdin => {
            if !remove_legacy_manifest_file(LEGACY_MANIFEST_PATH) {
                return false;
            }

            let mut manifest_json = Vec::new();
            if let Err(e) = std::io::stdin().read_to_end(&mut manifest_json) {
                log_error!(LOG_TAG, "Failed to read manifest from stdin: {e}");
                return false;
            }
            guest_download::run_manifest_bytes(&manifest_json)
        }
    }
}

fn remove_legacy_manifest_file(path: &str) -> bool {
    match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(e) if e.kind() == ErrorKind::NotFound => true,
        Err(e) => {
            log_error!(LOG_TAG, "Failed to remove stale manifest {path}: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::remove_legacy_manifest_file;

    #[test]
    fn remove_legacy_manifest_file_removes_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("storage-manifest.json");
        std::fs::write(&path, br#"{"secret":"old"}"#).unwrap();

        assert!(remove_legacy_manifest_file(path.to_str().unwrap()));

        assert!(!path.exists());
    }

    #[test]
    fn remove_legacy_manifest_file_allows_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing-storage-manifest.json");

        assert!(remove_legacy_manifest_file(path.to_str().unwrap()));

        assert!(!path.exists());
    }

    #[test]
    fn remove_legacy_manifest_file_fails_for_non_removable_path() {
        let dir = tempfile::tempdir().unwrap();

        assert!(!remove_legacy_manifest_file(dir.path().to_str().unwrap()));
    }
}
