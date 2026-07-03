use super::super::super::*;
use super::super::support::{
    minimal_context, mock_run_config, mock_run_config_with_api_url, push_job, shutdown,
    test_profiles, wait_discover_entered, wait_usage_flush_requested,
};
use std::sync::Arc;

fn usage_pending_path(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join("mitm-addon").join("usage-pending")
}

fn usage_test_now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn write_usage_pending_state(
    base_dir: &std::path::Path,
    usage_state_id: &str,
    flows: u32,
    buffered: u32,
    reports: u32,
) {
    let addon_dir = base_dir.join("mitm-addon");
    std::fs::create_dir_all(&addon_dir).unwrap();
    std::fs::write(
        usage_pending_path(base_dir),
        serde_json::json!({
            "pid": std::process::id(),
            "usageStateId": usage_state_id,
            "updatedAtMs": usage_test_now_millis(),
            "flows": flows,
            "buffered": buffered,
            "reports": reports,
        })
        .to_string(),
    )
    .unwrap();
}

async fn install_usage_flush_child(config: &mut RunConfig) {
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::AsyncBufReadExt;

    std::fs::create_dir_all(config.paths.base_dir.join("mitm-addon")).unwrap();
    let script = config.paths.base_dir.join("usage-flush-child.sh");
    std::fs::write(
        &script,
        r#"#!/usr/bin/env bash
set -euo pipefail
fifo="$0.fifo"
base_dir="$(dirname "$0")"
request="$base_dir/mitm-addon/usage-flush-request"
pending="$base_dir/mitm-addon/usage-pending"
jsonl_request="$base_dir/mitm-addon/jsonl-flush-request"
jsonl_state="$base_dir/mitm-addon/jsonl-flush-state"
write_pending_snapshot() {
  [[ -f "$request" ]] || return 0
  flush_id="$(sed -n 's/.*"flushRequestId":"\([^"]*\)".*/\1/p' "$request")"
  state_id="$(sed -n 's/.*"usageStateId":"\([^"]*\)".*/\1/p' "$request")"
  [[ -n "$flush_id" && -n "$state_id" ]] || return 0
  now_ms="$(date +%s%3N)"
  printf '{"pid":%s,"usageStateId":"%s","updatedAtMs":%s,"flows":0,"buffered":0,"reports":0,"flushRequestId":"%s"}' "$$" "$state_id" "$now_ms" "$flush_id" > "$pending"
}
write_jsonl_flush_state() {
  [[ -f "$jsonl_request" ]] || return 0
  flush_id="$(sed -n 's/.*"flushRequestId":"\([^"]*\)".*/\1/p' "$jsonl_request")"
  state_id="$(sed -n 's/.*"usageStateId":"\([^"]*\)".*/\1/p' "$jsonl_request")"
  path="$(sed -n 's/.*"path":"\([^"]*\)".*/\1/p' "$jsonl_request")"
  [[ -n "$flush_id" && -n "$state_id" && -n "$path" ]] || return 0
  now_ms="$(date +%s%3N)"
  printf '{"pid":%s,"usageStateId":"%s","updatedAtMs":%s,"flushRequestId":"%s","path":"%s","pending":0}' "$$" "$state_id" "$now_ms" "$flush_id" "$path" > "$jsonl_state"
}
handle_flush_request() {
  write_pending_snapshot
  write_jsonl_flush_state
}
mkfifo "$fifo"
exec 3<>"$fifo"
trap handle_flush_request USR1
trap 'exit 0' TERM
echo ready
while true; do read -r _ <&3 || true; done
"#,
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut child = tokio::process::Command::new(&script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut ready_lines = tokio::io::BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(2), ready_lines.next_line())
        .await
        .expect("usage flush child did not print ready")
        .unwrap()
        .expect("usage flush child stdout closed before ready");
    assert_eq!(ready, "ready");
    config.proxy.mitm.set_child_for_test(child);
}

#[tokio::test]
async fn job_completion_requests_proxy_usage_flush_without_waiting() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    install_usage_flush_child(&mut config).await;
    let usage_state_id = config.proxy.mitm.usage_state_id_for_test().to_string();
    write_usage_pending_state(&config.paths.base_dir, &usage_state_id, 0, 0, 1);
    let base_dir = config.paths.base_dir.clone();
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(
        completion.is_some(),
        "job completion must not wait for proxy usage drain"
    );
    wait_usage_flush_requested(&env, Duration::from_secs(5)).await;

    write_usage_pending_state(&base_dir, &usage_state_id, 0, 0, 0);
    shutdown(&env, run_handle).await;
}

/// Regression guard: the post-complete deferred network-log upload (moved
/// out of `post_job_cleanup` by #9828) must still reach the telemetry
/// endpoint, AND the drain shutdown must actually block on it — catching a
/// `tokio::spawn` fire-and-forget refactor that would silently lose the
/// upload on runtime drop.
///
/// The mock responds with a 400 ms delay. Since the job completes almost
/// immediately under `MockSandboxRuntime`, `shutdown()` is invoked while
/// the deferred `tokio::join!(flush, upload)` is still in-flight, so a
/// well-behaved drain returns AFTER the mock delay elapses. A detached
/// upload would let shutdown return immediately — the elapsed-time
/// assertion below is what catches that.
#[tokio::test]
async fn deferred_network_log_upload_drains_on_graceful_shutdown() {
    use httpmock::prelude::*;

    const MOCK_DELAY: Duration = Duration::from_millis(400);

    let server = MockServer::start_async().await;
    let network_log_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_includes("pending.example");
            then.delay(MOCK_DELAY)
                .status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;

    let (mut config, env) =
        mock_run_config_with_api_url(test_profiles(), 8, 32768, 4, &server.base_url());
    install_usage_flush_child(&mut config).await;
    let addon_dir = config.paths.base_dir.join("mitm-addon");
    config.proxy.mitm.set_addon_dir_for_test(addon_dir.clone());
    let mitm_jsonl_flush = config
        .proxy
        .mitm
        .jsonl_flush_handle(config.usage_flush_tx.clone());
    let write_started = Arc::new(tokio::sync::Notify::new());
    let release_write = Arc::new(tokio::sync::Semaphore::new(0));
    let network_log_manager =
        NetworkLogManager::new_with_write_gate(write_started.clone(), release_write.clone());
    let exec_config = Arc::get_mut(&mut config.exec_config)
        .expect("test config should not share exec_config before run starts");
    exec_config.network_log_manager = network_log_manager.clone();
    exec_config.mitm_jsonl_flush = Some(mitm_jsonl_flush);

    // Seed a network log file so `upload_network_logs` has a payload to POST
    // (otherwise it early-returns on NotFound and the assertion below would
    // measure nothing).
    let run_id = RunId::new_v4();
    let network_log_path = config.exec_config.log_paths.network_log(run_id);
    std::fs::create_dir_all(network_log_path.parent().unwrap()).unwrap();
    std::fs::write(
            &network_log_path,
            concat!(
                r#"{"timestamp":"2026-01-01T00:00:00","action":"ALLOW","host":"example.com","method":"GET","url":"https://example.com/","status":200}"#,
                "\n",
            ),
        )
        .unwrap();
    let _network_log_session = network_log_manager
        .register_source_ip("10.200.0.200", network_log_path.clone())
        .await;
    assert!(
        network_log_manager
            .append_for_ip(
                "10.200.0.200",
                serde_json::json!({
                    "timestamp": "2026-01-01T00:00:01Z",
                    "type": "dns",
                    "host": "pending.example",
                    "port": 53,
                }),
            )
            .await
    );
    write_started.notified().await;

    let run_handle = tokio::spawn(run(config));
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // The finalizer now closes Rust-side network-log attribution before
    // completing the job, so release the accepted write before waiting for
    // completion. The upload itself is still deferred until after the
    // completion request below.
    release_write.add_permits(1);
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await;
    assert!(completion.is_some(), "job should complete");

    // Drain shutdown — must block on each `spawn_job` closure's deferred
    // `tokio::join!(flush, upload)` via the outer `jobs` JoinSet.
    let shutdown_start = tokio::time::Instant::now();
    shutdown(&env, run_handle).await;
    let shutdown_elapsed = shutdown_start.elapsed();

    network_log_mock.assert_calls_async(1).await;
    let jsonl_request: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(addon_dir.join("jsonl-flush-request")).unwrap(),
    )
    .unwrap();
    let jsonl_state: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(addon_dir.join("jsonl-flush-state")).unwrap(),
    )
    .unwrap();
    let network_log_path_string = network_log_path.to_string_lossy().to_string();
    assert_eq!(jsonl_request["path"], network_log_path_string);
    assert_eq!(
        jsonl_state["flushRequestId"],
        jsonl_request["flushRequestId"]
    );
    assert_eq!(jsonl_state["path"], network_log_path_string);
    assert_eq!(jsonl_state["pending"], 0);

    // Stronger invariant: drain must actually WAIT for the deferred work.
    // With a 400 ms mock delay, a well-behaved drain takes ≥ the delay;
    // a detached (fire-and-forget) upload would let shutdown return in
    // tens of ms, dropping the in-flight request on runtime teardown.
    assert!(
        shutdown_elapsed >= MOCK_DELAY - Duration::from_millis(50),
        "drain must block on deferred upload (≥{MOCK_DELAY:?}); took only {shutdown_elapsed:?}",
    );
}
