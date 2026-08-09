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
                signal = source.wait() => {
                    let Some(signal) = signal else {
                        return;
                    };
                    signal
                },
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
