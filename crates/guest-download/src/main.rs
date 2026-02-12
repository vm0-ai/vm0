use guest_common::{log_error, log_info, telemetry::record_sandbox_op};
use std::time::Instant;

const LOG_TAG: &str = "sandbox:download";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let manifest_path = match args.get(1) {
        Some(p) => p,
        None => {
            log_error!(LOG_TAG, "Usage: guest-download <manifest_path>");
            std::process::exit(1);
        }
    };

    let start = Instant::now();
    let success = guest_download::run(manifest_path);
    let elapsed = start.elapsed();

    if success {
        record_sandbox_op("download_total", elapsed, true, None);
        log_info!(LOG_TAG, "Download completed in {}ms", elapsed.as_millis());
    } else {
        record_sandbox_op("download_total", elapsed, false, None);
        log_error!(LOG_TAG, "Download failed");
        std::process::exit(1);
    }
}
