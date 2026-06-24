use guest_common::{log_error, log_info, telemetry::record_sandbox_op};
use std::io::Read as _;
use std::time::Instant;

const LOG_TAG: &str = "sandbox:download";
const MANIFEST_STDIN_ARG: &str = "--manifest-stdin";
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
    if args.next().is_some() {
        return None;
    }
    if arg == MANIFEST_STDIN_ARG {
        Some(ManifestInput::Stdin)
    } else {
        Some(ManifestInput::Path(arg))
    }
}

fn run(input: ManifestInput) -> bool {
    match input {
        ManifestInput::Path(manifest_path) => guest_download::run(&manifest_path),
        ManifestInput::Stdin => {
            let mut manifest_json = Vec::new();
            if let Err(e) = std::io::stdin().read_to_end(&mut manifest_json) {
                log_error!(LOG_TAG, "Failed to read manifest from stdin: {e}");
                return false;
            }
            guest_download::run_manifest_bytes(&manifest_json)
        }
    }
}
