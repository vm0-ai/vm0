use std::io::{self, Write};
use std::time::Duration;

use tokio::sync::broadcast;
use uuid::Uuid;

use api_contracts::generated::{
    constants::runners::ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES as ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES_U64,
    types::runners::runs::active_inputs::{
        receipt::Response as ActiveInputReceiptResponse,
        reserve::Response as ActiveInputReserveResponse,
    },
};

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::local_queue::{ActiveInputEntry, LocalQueue};
use crate::provider::{ApiClient, ReserveActiveInputResult};

/// Exec-control payloads are bounded by the guest-side process-control IPC frame limit.
pub(crate) const ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES: usize =
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES_U64 as usize;
const _: () = assert!(
    ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES == process_control_ipc::MAX_CONTROL_PAYLOAD_BYTES
);

#[derive(serde::Serialize)]
pub(crate) struct ActiveInputPayload<'a> {
    #[serde(rename = "type")]
    payload_type: &'static str,
    #[serde(rename = "deliveryId", skip_serializing_if = "Option::is_none")]
    delivery_id: Option<&'a str>,
    text: &'a str,
}

impl<'a> ActiveInputPayload<'a> {
    pub(crate) fn new(delivery_id: Option<&'a str>, text: &'a str) -> Self {
        Self {
            payload_type: "active-input",
            delivery_id,
            text,
        }
    }

    pub(crate) fn to_vec(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(self)
    }
}

#[derive(Default)]
struct CountingWriter {
    len: usize,
}

impl CountingWriter {
    fn len(&self) -> usize {
        self.len
    }
}

impl Write for CountingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.len = self
            .len
            .checked_add(buf.len())
            .ok_or_else(|| io::Error::other("serialized active-input payload length overflow"))?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn active_input_payload_len(
    delivery_id: Option<&str>,
    text: &str,
) -> Result<usize, serde_json::Error> {
    let mut counter = CountingWriter::default();
    serde_json::to_writer(&mut counter, &ActiveInputPayload::new(delivery_id, text))?;
    Ok(counter.len())
}

pub(crate) fn identified_active_input_payload_len(text: &str) -> Result<usize, serde_json::Error> {
    let delivery_id = Uuid::nil().hyphenated().to_string();
    active_input_payload_len(Some(&delivery_id), text)
}

pub(crate) fn local_active_input_delivery_id(run_id: RunId, sequence: u64) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("vm0:local-active-input:{run_id}:{sequence}").as_bytes(),
    )
    .hyphenated()
    .to_string()
}

pub(crate) enum ActiveInputSource {
    LocalQueue(LocalQueueActiveInputSource),
    Api(ApiActiveInputSource),
}

#[derive(Clone)]
pub(crate) struct LocalQueueActiveInputSource {
    pub(crate) queue: LocalQueue,
    pub(crate) run_id: RunId,
}

pub(crate) struct ApiActiveInputSource {
    api: ApiClient,
    run_id: RunId,
    sandbox_token: String,
    notifications: ActiveInputSubscription,
    mode: ApiActiveInputMode,
}

#[derive(Clone)]
pub(crate) struct ApiActiveInputRecovery {
    api: ApiClient,
    run_id: RunId,
    sandbox_token: String,
}

#[derive(Clone, Copy)]
enum ApiActiveInputMode {
    Probe,
    Reserve,
    Legacy,
}

pub(crate) enum ActiveInputBatch {
    Local(Vec<ActiveInputEntry>),
    ApiReserve(ActiveInputReserveResponse),
    ApiLegacy {
        prompt: Option<String>,
        has_more: bool,
    },
}

const LOCAL_ACTIVE_INPUT_POLL_INTERVAL: Duration = Duration::from_millis(250);
pub(crate) const API_ACTIVE_INPUT_RECHECK_INTERVAL: Duration = Duration::from_secs(30);
const ACTIVE_INPUT_NOTIFICATION_CAPACITY: usize = 256;

#[derive(Clone)]
pub(crate) struct ActiveInputNotifications {
    sender: broadcast::Sender<RunId>,
}

pub(crate) struct ActiveInputSubscription {
    run_id: RunId,
    receiver: broadcast::Receiver<RunId>,
}

impl ActiveInputNotifications {
    pub(crate) fn new() -> Self {
        let (sender, receiver) = broadcast::channel(ACTIVE_INPUT_NOTIFICATION_CAPACITY);
        drop(receiver);
        Self { sender }
    }

    pub(crate) fn subscribe(&self, run_id: RunId) -> ActiveInputSubscription {
        ActiveInputSubscription {
            run_id,
            receiver: self.sender.subscribe(),
        }
    }

    pub(crate) fn notify(&self, run_id: RunId) {
        let _ = self.sender.send(run_id);
    }
}

impl ActiveInputSubscription {
    async fn wait(&mut self) {
        loop {
            match self.receiver.recv().await {
                Ok(run_id) if run_id == self.run_id => return,
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => return,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    }
}

impl ActiveInputSource {
    pub(crate) fn local_queue(queue: LocalQueue, run_id: RunId) -> Self {
        Self::LocalQueue(LocalQueueActiveInputSource { queue, run_id })
    }

    pub(crate) fn api(
        api: ApiClient,
        run_id: RunId,
        sandbox_token: String,
        notifications: ActiveInputSubscription,
    ) -> Self {
        Self::Api(ApiActiveInputSource {
            api,
            run_id,
            sandbox_token,
            notifications,
            mode: ApiActiveInputMode::Probe,
        })
    }

    pub(crate) fn api_recovery(&self) -> Option<ApiActiveInputRecovery> {
        match self {
            Self::LocalQueue(_) => None,
            Self::Api(source) => Some(ApiActiveInputRecovery {
                api: source.api.clone(),
                run_id: source.run_id,
                sandbox_token: source.sandbox_token.clone(),
            }),
        }
    }

    pub(crate) async fn read(&mut self, min_sequence: u64) -> RunnerResult<ActiveInputBatch> {
        match self {
            Self::LocalQueue(source) => {
                let source = source.clone();
                let entries = tokio::task::spawn_blocking(move || {
                    source
                        .queue
                        .read_active_input_entries_from_sequence_sync(source.run_id, min_sequence)
                })
                .await
                .map_err(|error| {
                    crate::error::RunnerError::Internal(format!(
                        "active-input reader task failed: {error}"
                    ))
                })?;
                Ok(ActiveInputBatch::Local(entries))
            }
            Self::Api(source) => read_api_active_input(source).await,
        }
    }

    pub(crate) async fn wait_until_next_read(&mut self) {
        match self {
            Self::LocalQueue(_) => tokio::time::sleep(LOCAL_ACTIVE_INPUT_POLL_INTERVAL).await,
            Self::Api(source) => {
                tokio::select! {
                    () = source.notifications.wait() => {}
                    () = tokio::time::sleep(API_ACTIVE_INPUT_RECHECK_INTERVAL) => {}
                }
            }
        }
    }
}

impl ApiActiveInputRecovery {
    pub(crate) async fn record_delivery(
        &self,
        delivery_id: &str,
    ) -> RunnerResult<ActiveInputReceiptResponse> {
        self.api
            .record_active_input_delivery(self.run_id, &self.sandbox_token, delivery_id)
            .await
    }
}

async fn read_api_active_input(
    source: &mut ApiActiveInputSource,
) -> RunnerResult<ActiveInputBatch> {
    match source.mode {
        ApiActiveInputMode::Legacy => read_legacy_api_active_input(source).await,
        ApiActiveInputMode::Probe => {
            let result = source
                .api
                .reserve_active_inputs(source.run_id, &source.sandbox_token)
                .await;
            match result {
                Ok(ReserveActiveInputResult::RouteUnavailable) => {
                    // A newly deployed Runner can reach an API version from before the
                    // reserve route during the Runner/API rollout and rollback window
                    // (up to two hours). Remove this legacy selection after that window
                    // closes and production drain evidence satisfies #26061.
                    source.mode = ApiActiveInputMode::Legacy;
                    read_legacy_api_active_input(source).await
                }
                Ok(ReserveActiveInputResult::Response(response)) => {
                    source.mode = ApiActiveInputMode::Reserve;
                    Ok(ActiveInputBatch::ApiReserve(response))
                }
                Err(error) => {
                    source.mode = ApiActiveInputMode::Reserve;
                    Err(error)
                }
            }
        }
        ApiActiveInputMode::Reserve => match source
            .api
            .reserve_active_inputs(source.run_id, &source.sandbox_token)
            .await?
        {
            ReserveActiveInputResult::Response(response) => {
                Ok(ActiveInputBatch::ApiReserve(response))
            }
            ReserveActiveInputResult::RouteUnavailable => Err(RunnerError::Api(
                "reserve active inputs returned 404 after reserve support was selected".to_string(),
            )),
        },
    }
}

async fn read_legacy_api_active_input(
    source: &ApiActiveInputSource,
) -> RunnerResult<ActiveInputBatch> {
    let event_ids = source
        .api
        .list_active_input_event_ids(source.run_id, &source.sandbox_token)
        .await?;
    let Some(event_id) = event_ids.first() else {
        return Ok(ActiveInputBatch::ApiLegacy {
            prompt: None,
            has_more: false,
        });
    };
    let prompt = source
        .api
        .claim_active_inputs(
            source.run_id,
            &source.sandbox_token,
            std::slice::from_ref(event_id),
        )
        .await?;
    Ok(ActiveInputBatch::ApiLegacy {
        prompt: Some(prompt),
        has_more: event_ids.len() > 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_input_payload_len_matches_serialized_payload_len() {
        let texts = [
            "plain ascii".to_string(),
            "quotes \" backslash \\ newline \n tab \t carriage \r".to_string(),
            "unicode café 你好 🚀".to_string(),
            "x".repeat(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES - 128),
        ];
        let delivery_id = Uuid::new_v4().hyphenated().to_string();

        for text in texts {
            for candidate_delivery_id in [None, Some(delivery_id.as_str())] {
                let counted = active_input_payload_len(candidate_delivery_id, &text).unwrap();
                let serialized = ActiveInputPayload::new(candidate_delivery_id, &text)
                    .to_vec()
                    .unwrap();
                assert_eq!(counted, serialized.len(), "text len={}", text.len());
            }
        }
    }
}
