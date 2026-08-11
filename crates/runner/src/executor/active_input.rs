//! Fire-and-forget active-input forwarding from a runner source to guest control.

use std::time::Duration;

use sandbox::GuestProcessControlHandle;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::active_input::{ActiveInputBatch, ActiveInputPayload, ActiveInputSource};
use crate::ids::RunId;

const ACTIVE_INPUT_READ_RETRY_INTERVAL: Duration = Duration::from_millis(250);
const ACTIVE_INPUT_CONTROL_TIMEOUT: Duration = Duration::from_secs(1);
const ACTIVE_INPUT_FORWARDER_JOIN_TIMEOUT: Duration = Duration::from_secs(1);
const FIRST_ACTIVE_INPUT_SEQUENCE: u64 = 1;

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
            Ok(Err(error)) => warn!(error = %error, "active-input forwarder task failed"),
            Err(_) => {
                task.abort();
                let _ = task.await;
            }
        }
    }
}

async fn run_forwarder(
    run_id: RunId,
    mut source: ActiveInputSource,
    control: GuestProcessControlHandle,
    job_cancel: CancellationToken,
    stop: CancellationToken,
) {
    let mut next_local_sequence = FIRST_ACTIVE_INPUT_SEQUENCE;
    let mut delivery_sequence = 0_u64;
    loop {
        let batch = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            () = job_cancel.cancelled() => return,
            batch = source.read(next_local_sequence) => batch,
        };
        let (retry_after_read_error, recheck_immediately) = match batch {
            Ok(ActiveInputBatch::Local(entries)) => {
                for entry in entries {
                    if entry.sequence < next_local_sequence {
                        continue;
                    }
                    if entry.sequence > next_local_sequence {
                        break;
                    }
                    delivery_sequence = delivery_sequence.saturating_add(1);
                    forward_text(run_id, delivery_sequence, &entry.text, &control).await;
                    next_local_sequence = next_local_sequence.saturating_add(1);
                }
                (false, false)
            }
            Ok(ActiveInputBatch::Api { prompt, has_more }) => {
                let forwarded = if let Some(prompt) = prompt {
                    delivery_sequence = delivery_sequence.saturating_add(1);
                    forward_text(run_id, delivery_sequence, &prompt, &control).await
                } else {
                    false
                };
                (false, has_more && forwarded)
            }
            Err(error) => {
                warn!(run_id = %run_id, error = %error, "active-input source read failed");
                (true, false)
            }
        };

        tokio::select! {
            biased;
            () = stop.cancelled() => return,
            () = job_cancel.cancelled() => return,
            () = async {
                if recheck_immediately {
                    return;
                }
                if retry_after_read_error {
                    tokio::time::sleep(ACTIVE_INPUT_READ_RETRY_INTERVAL).await;
                } else {
                    source.wait_until_next_read().await;
                }
            } => {}
        }
    }
}

async fn forward_text(
    run_id: RunId,
    delivery_sequence: u64,
    text: &str,
    control: &GuestProcessControlHandle,
) -> bool {
    let payload = ActiveInputPayload::new(text);
    let bytes = match payload.to_vec() {
        Ok(bytes) => bytes,
        Err(error) => {
            warn!(run_id = %run_id, error = %error, "failed to serialize active input");
            return false;
        }
    };
    // Process control requires a request correlation key. It is deliberately
    // runner-internal and has no active-input identity or deduplication semantics.
    let correlation_id = format!("active-input:{run_id}:{delivery_sequence}");
    match control
        .control_owned(correlation_id, bytes, ACTIVE_INPUT_CONTROL_TIMEOUT)
        .await
    {
        Ok(_) => true,
        Err(error) => {
            warn!(run_id = %run_id, error = %error, "active-input forward failed; dropping input");
            false
        }
    }
}
