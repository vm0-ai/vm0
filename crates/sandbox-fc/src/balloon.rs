use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;
use tracing::{debug, warn};

use crate::api::ApiClient;

/// Keep this much memory free in the guest (MiB).
const TARGET_FREE_MIB: i64 = 256;
/// Inflate only when free memory exceeds target by this much (MiB).
/// Larger than deflate hysteresis — we're less aggressive reclaiming memory
/// than returning it, because guest memory pressure is more urgent.
const INFLATE_HYSTERESIS_MIB: i64 = 128;
/// Deflate when free memory drops below target by this much (MiB).
/// Smaller than inflate hysteresis — respond faster to guest memory pressure.
const DEFLATE_HYSTERESIS_MIB: i64 = 64;
/// Minimum guaranteed guest memory — never inflate beyond `memory_mb - MIN_GUEST_MIB`.
const MIN_GUEST_MIB: u32 = 512;
/// Poll interval for balloon stats.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// Spawn the balloon controller loop. Returns a `JoinHandle` that can be aborted.
pub fn spawn(
    api_sock: PathBuf,
    memory_mb: u32,
    crash_notify: Arc<Notify>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(run_loop(api_sock, memory_mb, crash_notify))
}

async fn run_loop(api_sock: PathBuf, memory_mb: u32, crash_notify: Arc<Notify>) {
    let client = ApiClient::new(&api_sock);
    let max_inflate = memory_mb.saturating_sub(MIN_GUEST_MIB);
    if max_inflate == 0 {
        debug!(
            memory_mb,
            MIN_GUEST_MIB, "balloon controller disabled: memory_mb <= MIN_GUEST_MIB"
        );
        return;
    }
    let mut interval = tokio::time::interval(POLL_INTERVAL);

    loop {
        tokio::select! {
            _ = interval.tick() => {
                tick(&client, max_inflate).await;
            }
            _ = crash_notify.notified() => {
                debug!("balloon controller exiting: VM crashed");
                return;
            }
        }
    }
}

/// Single tick of the balloon controller.
///
/// Reads guest memory stats and inflates or deflates the balloon:
/// - Inflate (reclaim memory) when `available_memory > TARGET_FREE + INFLATE_HYSTERESIS`
/// - Deflate (return memory) when `available_memory < TARGET_FREE - DEFLATE_HYSTERESIS`
/// - No action in the hysteresis band to prevent oscillation
async fn tick(client: &ApiClient<'_>, max_inflate: u32) {
    let stats = match client.get_balloon_statistics().await {
        Ok(s) => s,
        Err(e) => {
            warn!(error = %e, "balloon stats fetch failed");
            return;
        }
    };

    let Some(available_bytes) = stats.available_memory else {
        return;
    };

    let available_mib = available_bytes / (1024 * 1024);
    let current = stats.actual_mib;

    if available_mib > TARGET_FREE_MIB + INFLATE_HYSTERESIS_MIB {
        let reclaim = (available_mib - TARGET_FREE_MIB) as u32;
        let new_target = current.saturating_add(reclaim).min(max_inflate);
        if new_target > current {
            debug!(current, new_target, available_mib, "balloon inflate");
            if let Err(e) = client.patch_balloon(new_target).await {
                warn!(error = %e, "balloon inflate failed");
            }
        }
    } else if available_mib < TARGET_FREE_MIB - DEFLATE_HYSTERESIS_MIB {
        let deficit = (TARGET_FREE_MIB - available_mib) as u32;
        let new_target = current.saturating_sub(deficit);
        if new_target < current {
            debug!(current, new_target, available_mib, "balloon deflate");
            if let Err(e) = client.patch_balloon(new_target).await {
                warn!(error = %e, "balloon deflate failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixListener;

    /// Helper: spawn a mock server that handles one GET (stats) and optionally one PATCH.
    /// Returns the PATCH request body if one was received.
    async fn run_tick_with_mock(stats_json: &str, max_inflate: u32) -> Option<String> {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("balloon-test.sock");

        let listener = UnixListener::bind(&sock_path).unwrap_or_else(|e| {
            panic!("bind {}: {e}", sock_path.display());
        });

        let stats_body = stats_json.to_owned();
        let server = tokio::spawn(async move {
            let mut patch_body = None;

            // First request: GET /balloon/statistics
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf).await;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{stats_body}",
                stats_body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            drop(stream);

            // Second request (optional): PATCH /balloon
            if let Ok(result) =
                tokio::time::timeout(Duration::from_millis(100), listener.accept()).await
            {
                let (mut stream, _) = result.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();

                // Extract body from HTTP request.
                if let Some(pos) = req.find("\r\n\r\n") {
                    patch_body = Some(req[pos + 4..].to_string());
                }

                let response = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.write_all(response.as_bytes()).await;
            }

            patch_body
        });

        let client = ApiClient::new(&sock_path);
        tick(&client, max_inflate).await;

        server.await.unwrap()
    }

    #[tokio::test]
    async fn tick_inflates_on_high_free_memory() {
        // 1 GiB available, well above threshold (256 + 128 = 384 MiB)
        let stats = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0,"available_memory":1073741824}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(patch.is_some(), "expected PATCH call for inflate");
        let body = patch.unwrap();
        assert!(body.contains("amount_mib"), "body: {body}");
    }

    #[tokio::test]
    async fn tick_deflates_on_low_free_memory() {
        // 128 MiB available, below threshold (256 - 64 = 192 MiB)
        let stats = r#"{"target_mib":512,"actual_mib":512,"target_pages":131072,"actual_pages":131072,"available_memory":134217728}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(patch.is_some(), "expected PATCH call for deflate");
        let body = patch.unwrap();
        assert!(body.contains("amount_mib"), "body: {body}");
    }

    #[tokio::test]
    async fn tick_no_action_in_hysteresis_band() {
        // 300 MiB available, within hysteresis band (192..384)
        let stats = r#"{"target_mib":100,"actual_mib":100,"target_pages":25600,"actual_pages":25600,"available_memory":314572800}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(patch.is_none(), "expected no PATCH call in hysteresis band");
    }

    #[tokio::test]
    async fn tick_respects_max_inflate() {
        // 2 GiB available, but max_inflate is 512 (memory_mb=1024, MIN_GUEST=512)
        let stats = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0,"available_memory":2147483648}"#;
        let patch = run_tick_with_mock(stats, 512).await;
        assert!(patch.is_some(), "expected PATCH call");
        let body = patch.unwrap();
        // Should not exceed max_inflate of 512
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        let amount = parsed["amount_mib"].as_u64().unwrap();
        assert!(amount <= 512, "amount_mib {amount} exceeds max_inflate 512");
    }

    #[tokio::test]
    async fn tick_no_action_when_max_inflate_zero() {
        // memory_mb <= MIN_GUEST_MIB → max_inflate = 0 → controller effectively disabled
        let stats = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0,"available_memory":1073741824}"#;
        let patch = run_tick_with_mock(stats, 0).await;
        assert!(patch.is_none(), "expected no PATCH when max_inflate is 0");
    }

    #[tokio::test]
    async fn tick_handles_missing_available_memory() {
        // Stats without available_memory field — should skip
        let stats = r#"{"target_mib":0,"actual_mib":0,"target_pages":0,"actual_pages":0}"#;
        let patch = run_tick_with_mock(stats, 1536).await;
        assert!(
            patch.is_none(),
            "expected no PATCH when available_memory missing"
        );
    }

    #[tokio::test]
    async fn tick_handles_api_error() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("tempdir: {e}"));
        let sock_path = dir.path().join("balloon-err.sock");

        let listener = UnixListener::bind(&sock_path).unwrap_or_else(|e| {
            panic!("bind {}: {e}", sock_path.display());
        });

        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = stream.read(&mut buf).await;
            let body = r#"{"fault_message":"stats not enabled"}"#;
            let response = format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        });

        let client = ApiClient::new(&sock_path);
        // Should not panic — just logs warning and returns.
        tick(&client, 1536).await;
    }
}
