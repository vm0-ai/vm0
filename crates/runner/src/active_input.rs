use std::path::PathBuf;

use crate::ids::RunId;
use crate::local_queue::{ActiveInputEntry, LocalQueue};

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

    pub(crate) fn read_entries_sync(&self) -> Vec<ActiveInputEntry> {
        match self {
            Self::LocalQueue(source) => LocalQueue::new(source.group_dir.clone())
                .read_active_input_entries_sync(source.run_id),
        }
    }
}
