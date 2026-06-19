use std::collections::HashSet;
use std::time::Duration;

use sandbox::GuestProcessControlHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::active_input::{ActiveInputPayload, ActiveInputSource};
use crate::ids::RunId;
use crate::local_queue::ActiveInputEntry;

const ACTIVE_INPUT_POLL_INTERVAL: Duration = Duration::from_millis(50);
const ACTIVE_INPUT_CONTROL_TIMEOUT: Duration = Duration::from_secs(1);
const ACTIVE_INPUT_FORWARDER_JOIN_TIMEOUT: Duration = Duration::from_secs(1);
const FIRST_ACTIVE_INPUT_SEQUENCE: u64 = 1;

struct ForwardState {
    seen_message_ids: HashSet<String>,
    next_sequence: u64,
}

impl Default for ForwardState {
    fn default() -> Self {
        Self {
            seen_message_ids: HashSet::new(),
            next_sequence: FIRST_ACTIVE_INPUT_SEQUENCE,
        }
    }
}

impl ForwardState {
    fn consume_sequence(&mut self) {
        self.next_sequence = self.next_sequence.saturating_add(1);
    }
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
    let mut state = ForwardState::default();
    loop {
        let next_sequence = state.next_sequence;
        tokio::select! {
            biased;
            () = stop.cancelled() => return,
            () = job_cancel.cancelled() => return,
            entries = read_entries(run_id, source.clone(), next_sequence) => {
                forward_entries(run_id, &control, entries, &mut state).await;
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

async fn read_entries(
    run_id: RunId,
    source: ActiveInputSource,
    min_sequence: u64,
) -> Vec<ActiveInputEntry> {
    match tokio::task::spawn_blocking(move || source.read_entries_from_sequence_sync(min_sequence))
        .await
    {
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
    state: &mut ForwardState,
) {
    for entry in entries {
        if entry.sequence < state.next_sequence {
            continue;
        }
        if entry.sequence > state.next_sequence {
            break;
        }
        if state.seen_message_ids.contains(&entry.message_id) {
            state.consume_sequence();
            continue;
        }
        let payload = ActiveInputPayload::new(&entry.text);
        let bytes = match payload.to_vec() {
            Ok(bytes) => bytes,
            Err(error) => {
                warn!(
                    run_id = %run_id,
                    sequence = entry.sequence,
                    message_id = %entry.message_id,
                    error = %error,
                    "failed to serialize active-input payload"
                );
                state.consume_sequence();
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
                state.seen_message_ids.insert(entry.message_id);
                state.consume_sequence();
            }
            Err(error) => {
                let retry = should_retry_control_error(&error);
                if retry {
                    debug!(
                        run_id = %run_id,
                        sequence = entry.sequence,
                        message_id = %entry.message_id,
                        error = %error,
                        "active-input forward failed; will retry"
                    );
                    break;
                } else {
                    warn!(
                        run_id = %run_id,
                        sequence = entry.sequence,
                        message_id = %entry.message_id,
                        error = %error,
                        "active-input forward failed; dropping input"
                    );
                    state.seen_message_ids.insert(entry.message_id);
                    state.consume_sequence();
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

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use sandbox::ProcessControlAck;

    use super::*;

    fn recording_control(calls: Arc<Mutex<Vec<String>>>) -> GuestProcessControlHandle {
        GuestProcessControlHandle::new(move |message_id, _payload, _timeout| {
            let calls = Arc::clone(&calls);
            Box::pin(async move {
                calls.lock().unwrap().push(message_id.clone());
                Ok(ProcessControlAck { message_id })
            })
        })
    }

    fn recording_control_with_errors(
        calls: Arc<Mutex<Vec<String>>>,
        errors: Arc<Mutex<VecDeque<std::io::ErrorKind>>>,
    ) -> GuestProcessControlHandle {
        GuestProcessControlHandle::new(move |message_id, _payload, _timeout| {
            let calls = Arc::clone(&calls);
            let errors = Arc::clone(&errors);
            Box::pin(async move {
                calls.lock().unwrap().push(message_id.clone());
                if let Some(kind) = errors.lock().unwrap().pop_front() {
                    return Err(std::io::Error::new(kind, "injected control error"));
                }
                Ok(ProcessControlAck { message_id })
            })
        })
    }

    fn entry(sequence: u64, message_id: &str, text: &str) -> ActiveInputEntry {
        ActiveInputEntry {
            run_id: RunId::nil(),
            sequence,
            message_id: message_id.to_string(),
            text: text.to_string(),
        }
    }

    #[tokio::test]
    async fn forward_entries_waits_for_missing_earlier_sequence() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let control = recording_control(Arc::clone(&calls));
        let mut state = ForwardState::default();

        forward_entries(
            RunId::nil(),
            &control,
            vec![entry(2, "msg-2", "second")],
            &mut state,
        )
        .await;
        assert!(calls.lock().unwrap().is_empty());

        forward_entries(
            RunId::nil(),
            &control,
            vec![entry(1, "msg-1", "first"), entry(2, "msg-2", "second")],
            &mut state,
        )
        .await;
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            ["msg-1".to_string(), "msg-2".to_string()]
        );
    }

    #[tokio::test]
    async fn forward_entries_consumes_duplicate_message_id_sequences() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let control = recording_control(Arc::clone(&calls));
        let mut state = ForwardState::default();

        forward_entries(
            RunId::nil(),
            &control,
            vec![
                entry(1, "msg-dup", "first"),
                entry(2, "msg-dup", "duplicate"),
                entry(3, "msg-3", "third"),
            ],
            &mut state,
        )
        .await;

        assert_eq!(
            calls.lock().unwrap().as_slice(),
            ["msg-dup".to_string(), "msg-3".to_string()]
        );
    }

    #[tokio::test]
    async fn forward_entries_retries_sequence_before_forwarding_later_inputs() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let errors = Arc::new(Mutex::new(VecDeque::from([std::io::ErrorKind::TimedOut])));
        let control = recording_control_with_errors(Arc::clone(&calls), errors);
        let mut state = ForwardState::default();

        let entries = vec![entry(1, "msg-1", "first"), entry(2, "msg-2", "second")];
        forward_entries(RunId::nil(), &control, entries.clone(), &mut state).await;
        assert_eq!(calls.lock().unwrap().as_slice(), ["msg-1".to_string()]);

        forward_entries(RunId::nil(), &control, entries, &mut state).await;
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            [
                "msg-1".to_string(),
                "msg-1".to_string(),
                "msg-2".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn forward_entries_retries_queue_full_before_forwarding_later_inputs() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let errors = Arc::new(Mutex::new(VecDeque::from([std::io::ErrorKind::WouldBlock])));
        let control = recording_control_with_errors(Arc::clone(&calls), errors);
        let mut state = ForwardState::default();

        let entries = vec![entry(1, "msg-1", "first"), entry(2, "msg-2", "second")];
        forward_entries(RunId::nil(), &control, entries.clone(), &mut state).await;
        assert_eq!(calls.lock().unwrap().as_slice(), ["msg-1".to_string()]);

        forward_entries(RunId::nil(), &control, entries, &mut state).await;
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            [
                "msg-1".to_string(),
                "msg-1".to_string(),
                "msg-2".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn forward_entries_consumes_non_retryable_failure_and_continues() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let errors = Arc::new(Mutex::new(VecDeque::from([
            std::io::ErrorKind::PermissionDenied,
        ])));
        let control = recording_control_with_errors(Arc::clone(&calls), errors);
        let mut state = ForwardState::default();

        forward_entries(
            RunId::nil(),
            &control,
            vec![entry(1, "msg-1", "first"), entry(2, "msg-2", "second")],
            &mut state,
        )
        .await;

        assert_eq!(
            calls.lock().unwrap().as_slice(),
            ["msg-1".to_string(), "msg-2".to_string()]
        );
    }
}
