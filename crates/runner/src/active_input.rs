use std::path::PathBuf;

use crate::ids::RunId;
use crate::local_queue::{ActiveInputEntry, LocalQueue};

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

pub(crate) fn active_input_payload_len(text: &str) -> Result<usize, serde_json::Error> {
    ActiveInputPayload::new(text)
        .to_vec()
        .map(|payload| payload.len())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ActiveInputSource {
    LocalQueue(LocalQueueActiveInputSource),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LocalQueueActiveInputSource {
    pub(crate) group_dir: PathBuf,
    pub(crate) run_id: RunId,
}

impl ActiveInputSource {
    pub(crate) fn local_queue(group_dir: PathBuf, run_id: RunId) -> Self {
        Self::LocalQueue(LocalQueueActiveInputSource { group_dir, run_id })
    }

    pub(crate) fn read_entries_from_sequence_sync(
        &self,
        min_sequence: u64,
    ) -> Vec<ActiveInputEntry> {
        match self {
            Self::LocalQueue(source) => LocalQueue::new(source.group_dir.clone())
                .read_active_input_entries_from_sequence_sync(source.run_id, min_sequence),
        }
    }
}
