use super::super::super::signals::{SignalController, SignalHandlerTask};
use super::super::super::*;
use super::super::support::{
    assert_run_exits_within, minimal_context, mock_run_config, mock_run_config_with_overrides,
    push_job, shutdown, test_profiles, wait_cancel_token, wait_discover_entered, wait_status_mode,
};
use std::sync::Arc;

// -----------------------------------------------------------------------
// Test 3: Shutdown completes without deadlock (regression #8898)
//
// Uses REAL time (not paused) because a Mutex deadlock blocks the
// tokio runtime — paused time can't advance past a non-timer await.
//
// Only sends Draining (does NOT cancel the token). This forces the
// worst-case race: mode_rx.changed() wins the select!, loop breaks
// at the top-of-loop check, and discover_fut is never polled again.
// The explicit `drop(discover_fut)` releases the Mutex so shutdown()
// can proceed. Without that drop, shutdown() deadlocks on the Mutex.
// -----------------------------------------------------------------------

#[tokio::test]
async fn shutdown_completes_without_deadlock() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let run_handle = tokio::spawn(run(config));

    // Let the main loop start and enter the discover select arm.
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    // Only send Draining — do NOT cancel. The Draining path sees
    // `jobs.is_empty()` immediately (no active jobs), breaks to
    // teardown, and `drop(discover_fut)` releases the Mutex before
    // `provider.shutdown()`. Without that drop → deadlock (regression #8898).
    env.drain();

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(2),
        "deadlock detected: run() did not finish within 2s (regression #8898)",
    )
    .await;
}

#[tokio::test]
async fn shutdown_drains_memory_prefetch_before_stopped() {
    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let status_path = env._temp_dir.path().join("status.json");
    let prefetch_cancel = tokio_util::sync::CancellationToken::new();
    let task_cancel = prefetch_cancel.clone();
    let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let handle = tokio::spawn(async move {
        task_cancel.cancelled().await;
        let _ = cancelled_tx.send(());
        let _ = release_rx.await;
    });
    config.shutdown.memory_prefetch =
        crate::prefetch::MemoryPrefetchTasks::from_test_handle(prefetch_cancel, handle);
    let run_handle = tokio::spawn(run(config));

    wait_discover_entered(&env, Duration::from_secs(2)).await;
    env.drain();
    env.cancel.cancel();
    tokio::time::timeout(Duration::from_secs(5), cancelled_rx)
        .await
        .expect("memory prefetch should be cancelled during teardown")
        .expect("memory prefetch task should report cancellation");

    assert!(
        !run_handle.is_finished(),
        "runner shutdown should wait for memory prefetch drain before returning",
    );
    let raw_status = tokio::fs::read_to_string(&status_path).await.unwrap();
    let status: serde_json::Value = serde_json::from_str(&raw_status).unwrap();
    assert_ne!(
        status.get("mode").and_then(serde_json::Value::as_str),
        Some("stopped"),
        "runner must not write stopped status before memory prefetch drain finishes",
    );

    release_tx
        .send(())
        .expect("runner should still be waiting for prefetch release");
    assert_run_exits_within(
        run_handle,
        Duration::from_secs(5),
        "run should finish after memory prefetch drains",
    )
    .await;
    wait_status_mode(&status_path, "stopped", Duration::from_secs(5)).await;
}

/// SIGTERM while a job is in flight: per-job cancellation fires, the
/// executor aborts, and run() exits within a couple of seconds rather
/// than blocking on the 2h JOB_TIMEOUT.
#[tokio::test]
async fn hard_shutdown_cancels_active_jobs() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        gate,
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));

    // Wait for the job to enter the gated wait — cancel token is now in the map.
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // SIGTERM equivalent: latch hard-shutdown, cancel all in-flight jobs.
    env.trigger_stopping().await;

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "hard shutdown should exit within 3s — got stuck",
    )
    .await;

    // The cancelled job reports the synthetic "cancelled by user" error.
    let comps = env.handle.completions.lock().unwrap();
    let c = comps
        .iter()
        .find(|c| c.run_id == run_id)
        .expect("cancelled job should still report completion");
    assert_eq!(c.error.as_deref(), Some("cancelled by user"));
}

#[tokio::test]
async fn signal_handler_exit_cancels_active_jobs() {
    let handler_exit = Arc::new(tokio::sync::Notify::new());
    let handler_task = {
        let handler_exit = Arc::clone(&handler_exit);
        tokio::spawn(async move {
            handler_exit.notified().await;
        })
    };

    assert_signal_handler_task_end_cancels_active_jobs(handler_task, || {
        handler_exit.notify_one();
    })
    .await;
}

#[tokio::test]
async fn signal_handler_panic_cancels_active_jobs() {
    let handler_panic = Arc::new(tokio::sync::Notify::new());
    let handler_task = {
        let handler_panic = Arc::clone(&handler_panic);
        tokio::spawn(async move {
            handler_panic.notified().await;
            panic!("signal handler task panic");
        })
    };

    assert_signal_handler_task_end_cancels_active_jobs(handler_task, || {
        handler_panic.notify_one();
    })
    .await;
}

#[tokio::test]
async fn graceful_shutdown_aborts_signal_handler_task() {
    struct ReleaseOnDrop(Arc<tokio::sync::Semaphore>);

    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            self.0.add_permits(1);
        }
    }

    let started = Arc::new(tokio::sync::Notify::new());
    let dropped = Arc::new(tokio::sync::Semaphore::new(0));
    let handler_task = {
        let started = Arc::clone(&started);
        let dropped = Arc::clone(&dropped);
        tokio::spawn(async move {
            let _guard = ReleaseOnDrop(dropped);
            started.notify_one();
            std::future::pending::<()>().await;
        })
    };
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .expect("signal handler test task should start");

    let (mut config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    config.signals.signal_source = SignalSource::Override(SignalController {
        mode_rx: env.mode_tx.subscribe(),
        lifecycle: env.lifecycle.clone(),
        handler_task: Some(SignalHandlerTask::new(handler_task)),
    });
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    shutdown(&env, run_handle).await;

    let _permit = dropped
        .try_acquire()
        .expect("graceful shutdown should await signal handler task abort");
}

async fn assert_signal_handler_task_end_cancels_active_jobs(
    handler_task: tokio::task::JoinHandle<()>,
    trigger_handler_task_end: impl FnOnce(),
) {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        gate,
    ));
    let (mut config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    config.signals.signal_source = SignalSource::Override(SignalController {
        mode_rx: env.mode_tx.subscribe(),
        lifecycle: env.lifecycle.clone(),
        handler_task: Some(SignalHandlerTask::new(handler_task)),
    });
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    trigger_handler_task_end();

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "signal handler exit should cancel active jobs and stop promptly",
    )
    .await;

    let comps = env.handle.completions.lock().unwrap();
    let c = comps
        .iter()
        .find(|c| c.run_id == run_id)
        .expect("cancelled job should still report completion");
    assert_eq!(c.error.as_deref(), Some("cancelled by user"));
}

/// SIGUSR1 → SIGTERM upgrade. Starts Draining, then hard-shutdown fires
/// mid-drain and the run exits promptly with the active job cancelled.
#[tokio::test]
async fn drain_then_hard_shutdown_upgrades() {
    let gate = Arc::new(tokio::sync::Notify::new());
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::with_wait_process_gate(
        gate,
    ));
    let (config, env) = mock_run_config_with_overrides(test_profiles(), 8, 32768, 4, overrides);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio::spawn(run(config));

    let run_id = RunId::new_v4();
    push_job(&env, run_id, "vm0/default", Some(minimal_context(run_id)));
    let _token = wait_cancel_token(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;

    // Draining. Without hard shutdown, this would wait up to JOB_TIMEOUT = 2h.
    env.drain();
    wait_status_mode(&status_path, "draining", Duration::from_secs(5)).await;

    // Upgrade to hard shutdown.
    env.trigger_stopping().await;

    assert_run_exits_within(
        run_handle,
        Duration::from_secs(3),
        "Draining → hard shutdown should exit within 3s",
    )
    .await;
}
