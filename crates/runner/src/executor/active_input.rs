use std::collections::HashSet;
use std::time::Duration;

use sandbox::GuestProcessControlHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::active_input::ActiveInputSource;
use crate::ids::RunId;
use crate::local_queue::ActiveInputEntry;

const ACTIVE_INPUT_POLL_INTERVAL: Duration = Duration::from_millis(50);
const ACTIVE_INPUT_CONTROL_TIMEOUT: Duration = Duration::from_secs(1);
const ACTIVE_INPUT_FORWARDER_JOIN_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(serde::Serialize)]
struct ActiveInputPayload<'a> {
    #[serde(rename = "type")]
    payload_type: &'static str,
    text: &'a str,
}

pub(super) struct ActiveInputForwarder {
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl ActiveInputForwarder {
    pub(super) fn start(
        run_id: RunId,
        source: Option<ActiveInputSource>,
        control: Option<GuestProcessControlHandle>,
        job_cancel: CancellationToken,
    ) -> Option<Self> {
        let (Some(source), Some(control)) = (source, control) else {
            return None;
        };
        let stop = CancellationToken::new();
        let stop_for_task = stop.clone();
        let task = tokio::spawn(async move {
            run_forwarder(run_id, source, control, job_cancel, stop_for_task).await;
        });
        Some(Self { stop, task })
    }

    pub(super) async fn stop(self) {
        self.stop.cancel();
        let mut task = self.task;
        match tokio::time::timeout(ACTIVE_INPUT_FORWARDER_JOIN_TIMEOUT, &mut task).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                warn!(error = %error, "active-input forwarder task failed");
            }
            Err(_) => {
                task.abort();
                let _ = task.await;
            }
        }
    }
}

async fn run_forwarder(
    run_id: RunId,
    source: ActiveInputSource,
    control: GuestProcessControlHandle,
    job_cancel: CancellationToken,
    stop: CancellationToken,
) {
    let mut seen = HashSet::new();
    loop {
        tokio::select! {
            biased;
            () = stop.cancelled() => return,
            () = job_cancel.cancelled() => return,
            entries = read_entries(run_id, source.clone()) => {
                forward_entries(run_id, &control, entries, &mut seen).await;
            }
        }

        tokio::select! {
            biased;
            () = stop.cancelled() => return,
            () = job_cancel.cancelled() => return,
            () = tokio::time::sleep(ACTIVE_INPUT_POLL_INTERVAL) => {}
        }
    }
}

async fn read_entries(run_id: RunId, source: ActiveInputSource) -> Vec<ActiveInputEntry> {
    match tokio::task::spawn_blocking(move || source.read_entries_sync()).await {
        Ok(entries) => entries,
        Err(error) => {
            warn!(run_id = %run_id, error = %error, "active-input reader task failed");
            Vec::new()
        }
    }
}

async fn forward_entries(
    run_id: RunId,
    control: &GuestProcessControlHandle,
    entries: Vec<ActiveInputEntry>,
    seen: &mut HashSet<String>,
) {
    for entry in entries {
        if seen.contains(&entry.message_id) {
            continue;
        }
        let payload = ActiveInputPayload {
            payload_type: "active-input",
            text: &entry.text,
        };
        let bytes = match serde_json::to_vec(&payload) {
            Ok(bytes) => bytes,
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    sequence = entry.sequence,
                    message_id = %entry.message_id,
                    error = %error,
                    "failed to serialize active-input payload"
                );
                continue;
            }
        };
        match control
            .control(&entry.message_id, &bytes, ACTIVE_INPUT_CONTROL_TIMEOUT)
            .await
        {
            Ok(_) => {
                debug!(
                    run_id = %run_id,
                    sequence = entry.sequence,
                    message_id = %entry.message_id,
                    "forwarded active input"
                );
                seen.insert(entry.message_id);
            }
            Err(error) => {
                let retry = should_retry_control_error(&error);
                warn!(
                    run_id = %run_id,
                    sequence = entry.sequence,
                    message_id = %entry.message_id,
                    error = %error,
                    retry,
                    "failed to forward active input"
                );
                if !retry {
                    seen.insert(entry.message_id);
                } else {
                    break;
                }
            }
        }
    }
}

fn should_retry_control_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::NotConnected
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::WouldBlock
    )
}
