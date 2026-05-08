use guest_common::{log_error, log_info, telemetry::record_sandbox_op};
use std::time::Instant;

const LOG_TAG: &str = "sandbox:download";

fn main() {
    guest_common::log::enable_system_log_file();

    let Some(manifest_path) = std::env::args().nth(1) else {
        log_error!(LOG_TAG, "Usage: guest-download <manifest_path>");
        std::process::exit(1);
    };

    let start = Instant::now();
    let success = guest_download::run(&manifest_path);
    let elapsed = start.elapsed();

    record_sandbox_op("download_total", elapsed, success, None);
    if success {
        log_info!(LOG_TAG, "Download completed in {}ms", elapsed.as_millis());
    } else {
        log_error!(LOG_TAG, "Download failed");
        std::process::exit(1);
    }
}
