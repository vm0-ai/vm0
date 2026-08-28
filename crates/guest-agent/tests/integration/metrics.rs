use serde_json::Value;
use std::error::Error;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Command;
use std::time::Duration;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

const METRICS_INTERVAL: Duration = Duration::from_secs(5);
#[cfg(unix)]
const WRITE_FAILURE_CHILD_ENV: &str = "VM0_TEST_METRICS_WRITE_FAILURE_CHILD";
#[cfg(unix)]
const WRITE_FAILURE_CHILD_TEST: &str = "metrics::metrics_loop_reopens_after_cached_write_failure";

type TestResult<T = ()> = Result<T, Box<dyn Error>>;

async fn wait_for_line_count(path: &Path, expected: usize) -> TestResult {
    for _ in 0..1_000 {
        let count = std::fs::read_to_string(path)
            .map(|content| content.lines().count())
            .unwrap_or(0);
        if count == expected {
            return Ok(());
        }
        tokio::task::yield_now().await;
    }

    let observed = std::fs::read_to_string(path)
        .map(|content| content.lines().count())
        .unwrap_or(0);
    Err(std::io::Error::other(format!(
        "expected {expected} metrics records in {}, observed {observed}",
        path.display()
    ))
    .into())
}

async fn settle_runnable_tasks() {
    for _ in 0..1_000 {
        tokio::task::yield_now().await;
    }
}

fn metrics_entries(path: &Path) -> TestResult<Vec<Value>> {
    let content = std::fs::read_to_string(path)?;
    let entries = content
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(entries)
}

fn assert_valid_metrics_entries(path: &Path, expected: usize) -> TestResult {
    let entries = metrics_entries(path)?;
    assert_eq!(entries.len(), expected);
    for entry in entries {
        assert!(entry.get("ts").is_some_and(Value::is_string));
        assert!(entry.get("cpu").is_some_and(Value::is_f64));
        assert!(entry.get("mem_used").is_some_and(Value::is_u64));
        assert!(entry.get("mem_total").is_some_and(Value::is_u64));
        assert!(entry.get("disk_used").is_some_and(Value::is_u64));
        assert!(entry.get("disk_total").is_some_and(Value::is_u64));
    }
    Ok(())
}

fn spawn_metrics_loop(path: PathBuf) -> (CancellationToken, JoinHandle<()>) {
    let shutdown = CancellationToken::new();
    let task_shutdown = shutdown.clone();
    let handle = tokio::spawn(async move {
        guest_agent::metrics::metrics_loop_for_path(
            task_shutdown,
            path.to_string_lossy().into_owned(),
        )
        .await;
    });
    (shutdown, handle)
}

async fn stop_metrics_loop(shutdown: CancellationToken, handle: JoinHandle<()>) -> TestResult {
    shutdown.cancel();
    handle.await?;
    Ok(())
}

fn keep_paused_clock_stable() -> JoinHandle<()> {
    tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    })
}

#[tokio::test(start_paused = true)]
async fn metrics_loop_reuses_retained_handle_across_ticks() -> TestResult {
    let clock_guard = keep_paused_clock_stable();
    let temp = tempfile::tempdir()?;
    let metrics_path = temp.path().join("runtime").join("metrics.jsonl");
    let moved_path = temp.path().join("runtime").join("moved-metrics.jsonl");
    let (shutdown, handle) = spawn_metrics_loop(metrics_path.clone());

    wait_for_line_count(&metrics_path, 1).await?;
    std::fs::rename(&metrics_path, &moved_path)?;

    tokio::time::advance(METRICS_INTERVAL).await;
    wait_for_line_count(&moved_path, 2).await?;

    assert!(!metrics_path.exists());
    assert_valid_metrics_entries(&moved_path, 2)?;

    stop_metrics_loop(shutdown, handle).await?;
    clock_guard.abort();
    let _ = clock_guard.await;
    Ok(())
}

#[cfg(unix)]
#[tokio::test(start_paused = true)]
async fn metrics_loop_reopens_after_cached_write_failure() -> TestResult {
    if std::env::var_os(WRITE_FAILURE_CHILD_ENV).as_deref() == Some(std::ffi::OsStr::new("1")) {
        return run_cached_write_failure_scenario().await;
    }

    let output = Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            WRITE_FAILURE_CHILD_TEST,
            "--nocapture",
            "--test-threads=1",
        ])
        .env(WRITE_FAILURE_CHILD_ENV, "1")
        .output()?;

    if !output.status.success() {
        return Err(std::io::Error::other(format!(
            "isolated metrics write-failure test failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        ))
        .into());
    }
    Ok(())
}

#[cfg(unix)]
async fn run_cached_write_failure_scenario() -> TestResult {
    let clock_guard = keep_paused_clock_stable();
    let temp = tempfile::tempdir()?;
    let metrics_path = temp.path().join("runtime").join("metrics.jsonl");
    let moved_path = temp.path().join("runtime").join("moved-metrics.jsonl");
    let (shutdown, handle) = spawn_metrics_loop(metrics_path.clone());

    wait_for_line_count(&metrics_path, 1).await?;
    std::fs::rename(&metrics_path, &moved_path)?;
    let first_record_bytes = std::fs::metadata(&moved_path)?.len();

    let mut original_limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    // SAFETY: `original_limit` points to writable storage for one `rlimit`.
    let get_limit_result =
        unsafe { libc::getrlimit(libc::RLIMIT_FSIZE, original_limit.as_mut_ptr()) };
    if get_limit_result != 0 {
        return Err(operation_error("getrlimit").into());
    }
    // SAFETY: successful `getrlimit` initialized the full value.
    let original_limit = unsafe { original_limit.assume_init() };
    // SAFETY: installing `SIG_IGN` for SIGXFSZ is process-global, and this test
    // runs alone in a dedicated child process.
    let original_handler = unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_IGN) };
    if original_handler == libc::SIG_ERR {
        return Err(operation_error("install SIGXFSZ handler").into());
    }

    let constrained_limit = libc::rlimit {
        rlim_cur: first_record_bytes,
        rlim_max: original_limit.rlim_max,
    };
    // SAFETY: the hard limit is unchanged and the process is isolated from all
    // other tests while the soft limit is constrained.
    let set_limit_result = unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &constrained_limit) };
    if set_limit_result != 0 {
        return Err(operation_error("set RLIMIT_FSIZE").into());
    }

    tokio::time::advance(METRICS_INTERVAL).await;
    settle_runnable_tasks().await;
    assert_eq!(std::fs::metadata(&moved_path)?.len(), first_record_bytes);
    assert!(!metrics_path.exists());

    // SAFETY: restore the exact resource limit captured before the test.
    let restore_limit_result = unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &original_limit) };
    if restore_limit_result != 0 {
        return Err(operation_error("restore RLIMIT_FSIZE").into());
    }
    // SAFETY: restore the exact signal disposition captured before the test.
    let restore_handler_result = unsafe { libc::signal(libc::SIGXFSZ, original_handler) };
    if restore_handler_result == libc::SIG_ERR {
        return Err(operation_error("restore SIGXFSZ handler").into());
    }

    tokio::time::advance(METRICS_INTERVAL).await;
    wait_for_line_count(&metrics_path, 1).await?;

    assert_valid_metrics_entries(&moved_path, 1)?;
    assert_valid_metrics_entries(&metrics_path, 1)?;

    stop_metrics_loop(shutdown, handle).await?;
    clock_guard.abort();
    let _ = clock_guard.await;
    Ok(())
}

#[cfg(unix)]
fn operation_error(operation: &str) -> std::io::Error {
    let error = std::io::Error::last_os_error();
    std::io::Error::new(error.kind(), format!("{operation}: {error}"))
}
