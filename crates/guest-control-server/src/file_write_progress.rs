use std::sync::{Arc, Mutex};

use guest_control_proto::{FileWriteStage, FileWriteStatus};

#[derive(Clone)]
pub(crate) struct FileWriteProgress(Arc<Mutex<FileWriteStatus>>);

pub(crate) struct FileWriteRequestProgress {
    latest: FileWriteProgress,
    sequence: u32,
}

impl Default for FileWriteProgress {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(FileWriteStatus {
            sequence: 0,
            stage: FileWriteStage::Idle,
        })))
    }
}

impl FileWriteProgress {
    pub(crate) fn start(&self, sequence: u32) -> FileWriteRequestProgress {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = FileWriteStatus {
            sequence,
            stage: FileWriteStage::Queued,
        };
        FileWriteRequestProgress {
            latest: self.clone(),
            sequence,
        }
    }

    pub(crate) fn snapshot(&self) -> FileWriteStatus {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl FileWriteRequestProgress {
    pub(crate) fn mark(&self, stage: FileWriteStage) {
        let mut latest = self.latest.0.lock().unwrap_or_else(|e| e.into_inner());
        // Admission is released before the terminal frame is sent. A newer
        // request may already own the snapshot when the older send returns.
        if latest.sequence == self.sequence {
            latest.stage = stage;
        }
    }
}
