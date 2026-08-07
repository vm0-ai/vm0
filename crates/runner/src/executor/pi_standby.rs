//! One-shot Pi standby wake/release forwarding to guest process control.

use std::time::Duration;

use sandbox::GuestProcessControlHandle;
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::ids::RunId;
use crate::pi_standby::{PiStandbySignal, PiStandbySubscription};

const PI_STANDBY_CONTROL_TIMEOUT: Duration = Duration::from_secs(1);
const PI_STANDBY_FORWARDER_JOIN_TIMEOUT: Duration = Duration::from_secs(1);

pub(super) struct PiStandbyForwarder {
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl PiStandbyForwarder {
    pub(super) fn start(
        run_id: RunId,
        source: Option<PiStandbySubscription>,
        control: Option<GuestProcessControlHandle>,
        job_cancel: CancellationToken,
    ) -> Option<Self> {
        let (Some(source), Some(control)) = (source, control) else {
            return None;
        };
        let stop = CancellationToken::new();
        let task_stop = stop.clone();
        let task = tokio::spawn(async move {
            let signal = tokio::select! {
                biased;
                () = task_stop.cancelled() => return,
                () = job_cancel.cancelled() => return,
                signal = source.wait() => signal,
            };
            let Some(signal) = signal else {
                return;
            };
            let payload = match signal {
                PiStandbySignal::Handoff => br#"{"type":"pi-handoff"}"#.as_slice(),
                PiStandbySignal::Release => br#"{"type":"pi-standby-release"}"#.as_slice(),
            };
            let correlation_id = format!("pi-standby:{run_id}");
            match control
                .control(&correlation_id, payload, PI_STANDBY_CONTROL_TIMEOUT)
                .await
            {
                Ok(_) => debug!(run_id = %run_id, ?signal, "forwarded Pi standby control"),
                Err(error) => {
                    warn!(run_id = %run_id, ?signal, error = %error, "Pi standby control forward failed")
                }
            }
        });
        Some(Self { stop, task })
    }

    pub(super) async fn stop(self) {
        self.stop.cancel();
        let mut task = self.task;
        match tokio::time::timeout(PI_STANDBY_FORWARDER_JOIN_TIMEOUT, &mut task).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => warn!(error = %error, "Pi standby forwarder task failed"),
            Err(_) => {
                task.abort();
                let _ = task.await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use sandbox::ProcessControlAck;

    use super::*;
    use crate::pi_standby::PiStandbyNotifications;

    #[tokio::test]
    async fn superseded_source_does_not_send_guest_control() {
        let notifications = PiStandbyNotifications::new();
        let run_id = RunId::new_v4();
        let source = notifications.subscribe(run_id);
        let _replacement = notifications.subscribe(run_id);
        let control_called = Arc::new(AtomicBool::new(false));
        let task_control_called = Arc::clone(&control_called);
        let control = GuestProcessControlHandle::new(move |message_id, _, _| {
            task_control_called.store(true, Ordering::SeqCst);
            Box::pin(async move { Ok(ProcessControlAck { message_id }) })
        });
        let forwarder = PiStandbyForwarder::start(
            run_id,
            Some(source),
            Some(control),
            CancellationToken::new(),
        )
        .expect("complete Pi standby controls should start a forwarder");
        let PiStandbyForwarder { task, .. } = forwarder;

        task.await
            .expect("Pi standby forwarder should exit cleanly");

        assert!(!control_called.load(Ordering::SeqCst));
    }
}
