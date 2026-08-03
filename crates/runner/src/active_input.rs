use std::io::{self, Write};
use std::time::Duration;

use crate::error::{RunnerError, RunnerResult};
use crate::ids::RunId;
use crate::local_queue::{ActiveInputEntry, LocalQueue};
use crate::provider::ApiClient;

/// Exec-control payloads are bounded by the guest-side process-control IPC
/// frame limit.
pub(crate) const ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES: usize = 1024 * 1024;

#[derive(serde::Serialize)]
pub(crate) struct ActiveInputPayload<'a> {
    #[serde(rename = "type")]
    payload_type: &'static str,
    text: &'a str,
}

impl<'a> ActiveInputPayload<'a> {
    pub(crate) fn new(text: &'a str) -> Self {
        Self {
            payload_type: "active-input",
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

pub(crate) fn active_input_payload_len(text: &str) -> Result<usize, serde_json::Error> {
    let mut counter = CountingWriter::default();
    serde_json::to_writer(&mut counter, &ActiveInputPayload::new(text))?;
    Ok(counter.len())
}

#[derive(Clone)]
pub(crate) enum ActiveInputSource {
    LocalQueue(LocalQueueActiveInputSource),
    Api(ApiActiveInputSource),
}

#[derive(Clone)]
pub(crate) struct LocalQueueActiveInputSource {
    pub(crate) queue: LocalQueue,
    pub(crate) run_id: RunId,
}

#[derive(Clone)]
pub(crate) struct ApiActiveInputSource {
    api: ApiClient,
    run_id: RunId,
    sandbox_token: String,
}

impl ActiveInputSource {
    pub(crate) fn local_queue(queue: LocalQueue, run_id: RunId) -> Self {
        Self::LocalQueue(LocalQueueActiveInputSource { queue, run_id })
    }

    pub(crate) fn api(api: ApiClient, run_id: RunId, sandbox_token: String) -> Self {
        Self::Api(ApiActiveInputSource {
            api,
            run_id,
            sandbox_token,
        })
    }

    pub(crate) fn idle_max_interval(&self) -> Duration {
        match self {
            Self::LocalQueue(_) => Duration::from_millis(250),
            Self::Api(_) => Duration::from_secs(1),
        }
    }

    pub(crate) async fn read_entries_from_sequence(
        &self,
        min_sequence: u64,
    ) -> RunnerResult<Vec<ActiveInputEntry>> {
        match self {
            Self::LocalQueue(source) => {
                let source = source.clone();
                tokio::task::spawn_blocking(move || {
                    source
                        .queue
                        .read_active_input_entries_from_sequence_sync(source.run_id, min_sequence)
                })
                .await
                .map_err(|error| RunnerError::Internal(error.to_string()))
            }
            Self::Api(source) => {
                source
                    .api
                    .active_inputs(&source.sandbox_token, source.run_id, min_sequence)
                    .await
            }
        }
    }
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

        for text in texts {
            let counted = active_input_payload_len(&text).unwrap();
            let serialized = ActiveInputPayload::new(&text).to_vec().unwrap();
            assert_eq!(counted, serialized.len(), "text len={}", text.len());
        }
    }
}
