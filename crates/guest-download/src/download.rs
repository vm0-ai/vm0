use crate::LOG_TAG;
use crate::archive;
use crate::error::DownloadError;
use crate::source;
use guest_common::{log_error, log_info, log_warn, telemetry::record_sandbox_op};
use std::any::Any;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const MAX_RETRIES: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_secs(1);
const MAX_CONCURRENT: usize = 4;
type TaskRunner = fn(DownloadTask) -> bool;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct DownloadTask {
    label: String,
    archive_kind: ArchiveKind,
    url: String,
    mount_path: String,
    kind: DownloadTaskKind,
}

impl DownloadTask {
    #[cfg(test)]
    pub(crate) fn new(
        label: String,
        archive_kind: ArchiveKind,
        url: String,
        mount_path: String,
    ) -> Self {
        Self::new_with_kind(
            label,
            archive_kind,
            url,
            mount_path,
            DownloadTaskKind::Other,
        )
    }

    pub(crate) fn new_with_kind(
        label: String,
        archive_kind: ArchiveKind,
        url: String,
        mount_path: String,
        kind: DownloadTaskKind,
    ) -> Self {
        Self {
            label,
            archive_kind,
            url,
            mount_path,
            kind,
        }
    }

    pub(crate) fn mount_path(&self) -> &str {
        &self.mount_path
    }

    #[cfg(test)]
    pub(crate) fn kind(&self) -> DownloadTaskKind {
        self.kind
    }

    fn is_remote_url(&self) -> bool {
        self.url.starts_with("http://") || self.url.starts_with("https://")
    }

    fn is_file_url(&self) -> bool {
        self.url.starts_with("file://")
    }

    fn failure_detail(&self, error: &DownloadError) -> String {
        format!("{} download failed: {}", self.label, error)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArchiveKind {
    Storage,
    Artifact,
}

impl ArchiveKind {
    fn total_action(self) -> &'static str {
        match self {
            Self::Storage => "storage_download",
            Self::Artifact => "artifact_download",
        }
    }

    fn request_to_response_headers_action(self) -> &'static str {
        match self {
            Self::Storage => "storage_download_remote_request_to_response_headers",
            Self::Artifact => "artifact_download_remote_request_to_response_headers",
        }
    }

    fn body_read_action(self) -> &'static str {
        match self {
            Self::Storage => "storage_download_remote_body_read",
            Self::Artifact => "artifact_download_remote_body_read",
        }
    }

    fn extract_outside_body_read_action(self) -> &'static str {
        match self {
            Self::Storage => "storage_download_remote_extract_outside_body_read",
            Self::Artifact => "artifact_download_remote_extract_outside_body_read",
        }
    }

    fn compressed_bytes_consumed_action(self, bytes: u64) -> &'static str {
        match (self, CompressedBytesBucket::from_bytes(bytes)) {
            (Self::Storage, CompressedBytesBucket::Zero) => {
                "storage_download_remote_compressed_bytes_consumed_zero"
            }
            (Self::Storage, CompressedBytesBucket::Under64Kib) => {
                "storage_download_remote_compressed_bytes_consumed_lt_64_kib"
            }
            (Self::Storage, CompressedBytesBucket::Kib64To256) => {
                "storage_download_remote_compressed_bytes_consumed_64_kib_to_256_kib"
            }
            (Self::Storage, CompressedBytesBucket::Kib256To1Mib) => {
                "storage_download_remote_compressed_bytes_consumed_256_kib_to_1_mib"
            }
            (Self::Storage, CompressedBytesBucket::Mib1To4) => {
                "storage_download_remote_compressed_bytes_consumed_1_mib_to_4_mib"
            }
            (Self::Storage, CompressedBytesBucket::Mib4To16) => {
                "storage_download_remote_compressed_bytes_consumed_4_mib_to_16_mib"
            }
            (Self::Storage, CompressedBytesBucket::Mib16To64) => {
                "storage_download_remote_compressed_bytes_consumed_16_mib_to_64_mib"
            }
            (Self::Storage, CompressedBytesBucket::Mib64Plus) => {
                "storage_download_remote_compressed_bytes_consumed_64_mib_plus"
            }
            (Self::Artifact, CompressedBytesBucket::Zero) => {
                "artifact_download_remote_compressed_bytes_consumed_zero"
            }
            (Self::Artifact, CompressedBytesBucket::Under64Kib) => {
                "artifact_download_remote_compressed_bytes_consumed_lt_64_kib"
            }
            (Self::Artifact, CompressedBytesBucket::Kib64To256) => {
                "artifact_download_remote_compressed_bytes_consumed_64_kib_to_256_kib"
            }
            (Self::Artifact, CompressedBytesBucket::Kib256To1Mib) => {
                "artifact_download_remote_compressed_bytes_consumed_256_kib_to_1_mib"
            }
            (Self::Artifact, CompressedBytesBucket::Mib1To4) => {
                "artifact_download_remote_compressed_bytes_consumed_1_mib_to_4_mib"
            }
            (Self::Artifact, CompressedBytesBucket::Mib4To16) => {
                "artifact_download_remote_compressed_bytes_consumed_4_mib_to_16_mib"
            }
            (Self::Artifact, CompressedBytesBucket::Mib16To64) => {
                "artifact_download_remote_compressed_bytes_consumed_16_mib_to_64_mib"
            }
            (Self::Artifact, CompressedBytesBucket::Mib64Plus) => {
                "artifact_download_remote_compressed_bytes_consumed_64_mib_plus"
            }
        }
    }

    fn attempt_count_action(self, attempts: u32) -> &'static str {
        match (self, attempts) {
            (Self::Storage, 1) => "storage_download_remote_attempt_count_1",
            (Self::Storage, 2) => "storage_download_remote_attempt_count_2",
            (Self::Storage, _) => "storage_download_remote_attempt_count_3",
            (Self::Artifact, 1) => "artifact_download_remote_attempt_count_1",
            (Self::Artifact, 2) => "artifact_download_remote_attempt_count_2",
            (Self::Artifact, _) => "artifact_download_remote_attempt_count_3",
        }
    }
}

#[derive(Clone, Copy)]
enum CompressedBytesBucket {
    Zero,
    Under64Kib,
    Kib64To256,
    Kib256To1Mib,
    Mib1To4,
    Mib4To16,
    Mib16To64,
    Mib64Plus,
}

impl CompressedBytesBucket {
    fn from_bytes(bytes: u64) -> Self {
        match bytes {
            0 => Self::Zero,
            1..65_536 => Self::Under64Kib,
            65_536..262_144 => Self::Kib64To256,
            262_144..1_048_576 => Self::Kib256To1Mib,
            1_048_576..4_194_304 => Self::Mib1To4,
            4_194_304..16_777_216 => Self::Mib4To16,
            16_777_216..67_108_864 => Self::Mib16To64,
            _ => Self::Mib64Plus,
        }
    }
}

#[derive(Default)]
struct RemoteArchiveTaskMetrics {
    request_to_response_headers: Duration,
    body_read: Duration,
    extract_outside_body_read: Duration,
    compressed_bytes_consumed: u64,
    attempts: u32,
}

impl RemoteArchiveTaskMetrics {
    fn begin_attempt(&mut self) {
        self.attempts = self.attempts.saturating_add(1);
    }

    fn record_attempt(
        &mut self,
        metrics: source::RemoteArchiveAttemptSnapshot,
        extract_wall: Duration,
    ) {
        self.request_to_response_headers = self
            .request_to_response_headers
            .saturating_add(metrics.request_to_response_headers);
        self.body_read = self.body_read.saturating_add(metrics.body_read);
        self.extract_outside_body_read = self
            .extract_outside_body_read
            .saturating_add(extract_wall.saturating_sub(metrics.body_read));
        self.compressed_bytes_consumed = self
            .compressed_bytes_consumed
            .saturating_add(metrics.compressed_bytes_consumed);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DownloadTaskKind {
    FrameworkHomeInstructions,
    FrameworkSkillChild,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DownloadConflictKind {
    InstructionsSkill,
    ExactPath,
    OtherParentChild,
}

struct ActiveDownload {
    id: usize,
    mount_path: PathBuf,
    kind: DownloadTaskKind,
}

struct DownloadCompletion {
    id: usize,
    outcome: DownloadOutcome,
}

#[derive(Default)]
struct DownloadScheduleStats {
    conflict_deferrals: DownloadConflictDeferralStats,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct DownloadConflictDeferralStats {
    total: usize,
    instructions_skill: usize,
    exact_path: usize,
    other_parent_child: usize,
}

impl DownloadConflictDeferralStats {
    fn record(&mut self, kind: DownloadConflictKind) {
        self.total += 1;
        match kind {
            DownloadConflictKind::InstructionsSkill => self.instructions_skill += 1,
            DownloadConflictKind::ExactPath => self.exact_path += 1,
            DownloadConflictKind::OtherParentChild => self.other_parent_child += 1,
        }
    }

    fn merge(&mut self, other: Self) {
        self.total += other.total;
        self.instructions_skill += other.instructions_skill;
        self.exact_path += other.exact_path;
        self.other_parent_child += other.other_parent_child;
    }
}

struct StartableDownload {
    selected: Option<(usize, PathBuf, DownloadTaskKind)>,
    conflict_deferrals: DownloadConflictDeferralStats,
}

enum DownloadOutcome {
    Finished(bool),
    Panicked(String),
}

/// Download all tasks in parallel using std::thread.
/// Limits concurrency to MAX_CONCURRENT and serializes overlapping mount paths.
/// Returns true if all downloads succeeded, false if any failed.
pub(crate) fn download_all_parallel(tasks: Vec<DownloadTask>) -> bool {
    download_all_parallel_with_runner(tasks, run_download_task)
}

fn record_download_attribution(tasks: &[DownloadTask]) {
    record_sandbox_op(
        guest_download_task_count_action(tasks.len()),
        Duration::ZERO,
        true,
        None,
    );
    let remote_urls = tasks.iter().filter(|task| task.is_remote_url()).count();
    record_sandbox_op(
        guest_download_remote_url_count_action(remote_urls),
        Duration::ZERO,
        true,
        None,
    );
    let file_urls = tasks.iter().filter(|task| task.is_file_url()).count();
    record_sandbox_op(
        guest_download_file_url_count_action(file_urls),
        Duration::ZERO,
        true,
        None,
    );
    let skill_child_tasks = tasks
        .iter()
        .filter(|task| task.kind == DownloadTaskKind::FrameworkSkillChild)
        .count();
    record_sandbox_op(
        guest_download_skill_child_task_count_action(skill_child_tasks),
        Duration::ZERO,
        true,
        None,
    );
    let instructions_present = tasks
        .iter()
        .any(|task| task.kind == DownloadTaskKind::FrameworkHomeInstructions);
    record_sandbox_op(
        guest_download_framework_home_instructions_task_action(instructions_present),
        Duration::ZERO,
        true,
        None,
    );
    record_sandbox_op(
        guest_download_potential_parent_child_overlap_count_action(
            potential_parent_child_overlap_count(tasks),
        ),
        Duration::ZERO,
        true,
        None,
    );
}

fn download_all_parallel_with_runner(tasks: Vec<DownloadTask>, task_runner: TaskRunner) -> bool {
    record_download_attribution(&tasks);
    if tasks.is_empty() {
        record_sandbox_op(
            guest_download_mount_conflict_deferral_count_action(0),
            Duration::ZERO,
            true,
            None,
        );
        record_conflict_deferral_attribution(DownloadConflictDeferralStats::default());
        return true;
    }

    log_info!(
        LOG_TAG,
        "Downloading {} items (max {} concurrent)",
        tasks.len(),
        MAX_CONCURRENT
    );

    let mut stats = DownloadScheduleStats::default();
    let success = thread::scope(|scope| {
        let (completion_tx, completion_rx) = mpsc::channel();
        let mut pending = VecDeque::from(tasks);
        let mut active = Vec::new();
        let mut next_id = 0;
        let mut all_success = true;

        start_ready_downloads(
            scope,
            &mut pending,
            &mut active,
            &completion_tx,
            &mut next_id,
            task_runner,
            &mut stats,
        );

        while !active.is_empty() {
            let completion = match completion_rx.recv() {
                Ok(completion) => completion,
                Err(e) => {
                    log_error!(LOG_TAG, "Download scheduler failed: {e}");
                    return false;
                }
            };

            active.retain(|download| download.id != completion.id);

            match completion.outcome {
                DownloadOutcome::Finished(success) => {
                    if !success {
                        all_success = false;
                    }
                }
                DownloadOutcome::Panicked(msg) => {
                    log_error!(LOG_TAG, "Thread panicked: {msg}");
                    all_success = false;
                }
            }

            start_ready_downloads(
                scope,
                &mut pending,
                &mut active,
                &completion_tx,
                &mut next_id,
                task_runner,
                &mut stats,
            );
        }

        all_success && pending.is_empty()
    });
    record_sandbox_op(
        guest_download_mount_conflict_deferral_count_action(stats.conflict_deferrals.total),
        Duration::ZERO,
        true,
        None,
    );
    record_conflict_deferral_attribution(stats.conflict_deferrals);
    success
}

fn record_conflict_deferral_attribution(stats: DownloadConflictDeferralStats) {
    record_sandbox_op(
        guest_download_instructions_skill_conflict_deferral_count_action(stats.instructions_skill),
        Duration::ZERO,
        true,
        None,
    );
    record_sandbox_op(
        guest_download_exact_path_conflict_deferral_count_action(stats.exact_path),
        Duration::ZERO,
        true,
        None,
    );
    record_sandbox_op(
        guest_download_other_parent_child_conflict_deferral_count_action(stats.other_parent_child),
        Duration::ZERO,
        true,
        None,
    );
}

fn guest_download_task_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_task_count_0",
        CountBucket::One => "guest_download_task_count_1",
        CountBucket::Two => "guest_download_task_count_2",
        CountBucket::ThreeToFour => "guest_download_task_count_3_4",
        CountBucket::FiveToEight => "guest_download_task_count_5_8",
        CountBucket::NineToSixteen => "guest_download_task_count_9_16",
        CountBucket::SeventeenPlus => "guest_download_task_count_17_plus",
    }
}

fn guest_download_remote_url_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_remote_url_count_0",
        CountBucket::One => "guest_download_remote_url_count_1",
        CountBucket::Two => "guest_download_remote_url_count_2",
        CountBucket::ThreeToFour => "guest_download_remote_url_count_3_4",
        CountBucket::FiveToEight => "guest_download_remote_url_count_5_8",
        CountBucket::NineToSixteen => "guest_download_remote_url_count_9_16",
        CountBucket::SeventeenPlus => "guest_download_remote_url_count_17_plus",
    }
}

fn guest_download_file_url_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_file_url_count_0",
        CountBucket::One => "guest_download_file_url_count_1",
        CountBucket::Two => "guest_download_file_url_count_2",
        CountBucket::ThreeToFour => "guest_download_file_url_count_3_4",
        CountBucket::FiveToEight => "guest_download_file_url_count_5_8",
        CountBucket::NineToSixteen => "guest_download_file_url_count_9_16",
        CountBucket::SeventeenPlus => "guest_download_file_url_count_17_plus",
    }
}

fn guest_download_skill_child_task_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_skill_child_task_count_0",
        CountBucket::One => "guest_download_skill_child_task_count_1",
        CountBucket::Two => "guest_download_skill_child_task_count_2",
        CountBucket::ThreeToFour => "guest_download_skill_child_task_count_3_4",
        CountBucket::FiveToEight => "guest_download_skill_child_task_count_5_8",
        CountBucket::NineToSixteen => "guest_download_skill_child_task_count_9_16",
        CountBucket::SeventeenPlus => "guest_download_skill_child_task_count_17_plus",
    }
}

fn guest_download_framework_home_instructions_task_action(present: bool) -> &'static str {
    if present {
        "guest_download_framework_home_instructions_task_present"
    } else {
        "guest_download_framework_home_instructions_task_absent"
    }
}

fn guest_download_potential_parent_child_overlap_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_potential_parent_child_overlap_count_0",
        CountBucket::One => "guest_download_potential_parent_child_overlap_count_1",
        CountBucket::Two => "guest_download_potential_parent_child_overlap_count_2",
        CountBucket::ThreeToFour => "guest_download_potential_parent_child_overlap_count_3_4",
        CountBucket::FiveToEight => "guest_download_potential_parent_child_overlap_count_5_8",
        CountBucket::NineToSixteen => "guest_download_potential_parent_child_overlap_count_9_16",
        CountBucket::SeventeenPlus => "guest_download_potential_parent_child_overlap_count_17_plus",
    }
}

fn guest_download_mount_conflict_deferral_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_mount_conflict_deferral_count_0",
        CountBucket::One => "guest_download_mount_conflict_deferral_count_1",
        CountBucket::Two => "guest_download_mount_conflict_deferral_count_2",
        CountBucket::ThreeToFour => "guest_download_mount_conflict_deferral_count_3_4",
        CountBucket::FiveToEight => "guest_download_mount_conflict_deferral_count_5_8",
        CountBucket::NineToSixteen => "guest_download_mount_conflict_deferral_count_9_16",
        CountBucket::SeventeenPlus => "guest_download_mount_conflict_deferral_count_17_plus",
    }
}

fn guest_download_instructions_skill_conflict_deferral_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_instructions_skill_conflict_deferral_count_0",
        CountBucket::One => "guest_download_instructions_skill_conflict_deferral_count_1",
        CountBucket::Two => "guest_download_instructions_skill_conflict_deferral_count_2",
        CountBucket::ThreeToFour => "guest_download_instructions_skill_conflict_deferral_count_3_4",
        CountBucket::FiveToEight => "guest_download_instructions_skill_conflict_deferral_count_5_8",
        CountBucket::NineToSixteen => {
            "guest_download_instructions_skill_conflict_deferral_count_9_16"
        }
        CountBucket::SeventeenPlus => {
            "guest_download_instructions_skill_conflict_deferral_count_17_plus"
        }
    }
}

fn guest_download_exact_path_conflict_deferral_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_exact_path_conflict_deferral_count_0",
        CountBucket::One => "guest_download_exact_path_conflict_deferral_count_1",
        CountBucket::Two => "guest_download_exact_path_conflict_deferral_count_2",
        CountBucket::ThreeToFour => "guest_download_exact_path_conflict_deferral_count_3_4",
        CountBucket::FiveToEight => "guest_download_exact_path_conflict_deferral_count_5_8",
        CountBucket::NineToSixteen => "guest_download_exact_path_conflict_deferral_count_9_16",
        CountBucket::SeventeenPlus => "guest_download_exact_path_conflict_deferral_count_17_plus",
    }
}

fn guest_download_other_parent_child_conflict_deferral_count_action(count: usize) -> &'static str {
    match count_bucket(count) {
        CountBucket::Zero => "guest_download_other_parent_child_conflict_deferral_count_0",
        CountBucket::One => "guest_download_other_parent_child_conflict_deferral_count_1",
        CountBucket::Two => "guest_download_other_parent_child_conflict_deferral_count_2",
        CountBucket::ThreeToFour => "guest_download_other_parent_child_conflict_deferral_count_3_4",
        CountBucket::FiveToEight => "guest_download_other_parent_child_conflict_deferral_count_5_8",
        CountBucket::NineToSixteen => {
            "guest_download_other_parent_child_conflict_deferral_count_9_16"
        }
        CountBucket::SeventeenPlus => {
            "guest_download_other_parent_child_conflict_deferral_count_17_plus"
        }
    }
}

#[derive(Clone, Copy)]
enum CountBucket {
    Zero,
    One,
    Two,
    ThreeToFour,
    FiveToEight,
    NineToSixteen,
    SeventeenPlus,
}

fn count_bucket(count: usize) -> CountBucket {
    match count {
        0 => CountBucket::Zero,
        1 => CountBucket::One,
        2 => CountBucket::Two,
        3 | 4 => CountBucket::ThreeToFour,
        5..=8 => CountBucket::FiveToEight,
        9..=16 => CountBucket::NineToSixteen,
        _ => CountBucket::SeventeenPlus,
    }
}

fn start_ready_downloads<'scope, 'env: 'scope>(
    scope: &'scope thread::Scope<'scope, 'env>,
    pending: &mut VecDeque<DownloadTask>,
    active: &mut Vec<ActiveDownload>,
    completion_tx: &mpsc::Sender<DownloadCompletion>,
    next_id: &mut usize,
    task_runner: TaskRunner,
    stats: &mut DownloadScheduleStats,
) {
    while active.len() < MAX_CONCURRENT {
        let startable = find_startable_download(pending, active);
        stats.conflict_deferrals.merge(startable.conflict_deferrals);
        let Some((index, mount_path, kind)) = startable.selected else {
            break;
        };
        let Some(task) = pending.remove(index) else {
            log_error!(LOG_TAG, "Download scheduler selected a missing task");
            break;
        };
        let id = *next_id;
        *next_id += 1;
        active.push(ActiveDownload {
            id,
            mount_path,
            kind,
        });

        let completion_tx = completion_tx.clone();
        scope.spawn(move || {
            let outcome = std::panic::catch_unwind(|| task_runner(task))
                .map(DownloadOutcome::Finished)
                .unwrap_or_else(|e| DownloadOutcome::Panicked(panic_message(e.as_ref())));

            let _ = completion_tx.send(DownloadCompletion { id, outcome });
        });
    }
}

fn find_startable_download(
    pending: &VecDeque<DownloadTask>,
    active: &[ActiveDownload],
) -> StartableDownload {
    // Scan the pending queue instead of using strict FIFO so an active
    // parent/child mount-path conflict does not leave a slot idle when a later
    // independent task can start.
    let mut conflict_deferrals = DownloadConflictDeferralStats::default();
    for (index, task) in pending.iter().enumerate() {
        let mount_path = normalize_mount_path(task.mount_path());

        if let Some(conflict) = active.iter().find_map(|download| {
            classify_download_conflict(
                mount_path.as_path(),
                task.kind,
                download.mount_path.as_path(),
                download.kind,
            )
        }) {
            conflict_deferrals.record(conflict);
            continue;
        }

        return StartableDownload {
            selected: Some((index, mount_path, task.kind)),
            conflict_deferrals,
        };
    }

    StartableDownload {
        selected: None,
        conflict_deferrals,
    }
}

pub(crate) fn classify_download_task_kind(
    mount_path: &str,
    instructions_target_filename: Option<&str>,
) -> DownloadTaskKind {
    if instructions_target_filename.is_some() {
        return DownloadTaskKind::FrameworkHomeInstructions;
    }

    if is_framework_skill_child_path(&normalize_mount_path(mount_path)) {
        return DownloadTaskKind::FrameworkSkillChild;
    }

    DownloadTaskKind::Other
}

fn classify_download_conflict(
    left_path: &Path,
    left_kind: DownloadTaskKind,
    right_path: &Path,
    right_kind: DownloadTaskKind,
) -> Option<DownloadConflictKind> {
    if !mount_paths_conflict(left_path, right_path) {
        return None;
    }
    if left_path == right_path {
        return Some(DownloadConflictKind::ExactPath);
    }
    if task_kinds_are_instructions_and_skill(left_kind, right_kind) {
        return Some(DownloadConflictKind::InstructionsSkill);
    }
    Some(DownloadConflictKind::OtherParentChild)
}

fn task_kinds_are_instructions_and_skill(left: DownloadTaskKind, right: DownloadTaskKind) -> bool {
    matches!(
        (left, right),
        (
            DownloadTaskKind::FrameworkHomeInstructions,
            DownloadTaskKind::FrameworkSkillChild
        ) | (
            DownloadTaskKind::FrameworkSkillChild,
            DownloadTaskKind::FrameworkHomeInstructions
        )
    )
}

fn potential_parent_child_overlap_count(tasks: &[DownloadTask]) -> usize {
    let normalized_paths: Vec<PathBuf> = tasks
        .iter()
        .map(|task| normalize_mount_path(task.mount_path()))
        .collect();
    let mut path_counts = HashMap::new();
    for path in &normalized_paths {
        *path_counts.entry(path.clone()).or_insert(0usize) += 1;
    }

    let mut count = 0;

    for path in &normalized_paths {
        for ancestor in path.ancestors().skip(1) {
            if let Some(ancestor_count) = path_counts.get(ancestor) {
                count += ancestor_count;
            }
        }
    }

    count
}

fn is_framework_skill_child_path(path: &Path) -> bool {
    is_child_path(path, Path::new("/home/user/.codex/skills"))
        || is_child_path(path, Path::new("/home/user/.claude/skills"))
}

fn is_child_path(path: &Path, parent: &Path) -> bool {
    path.starts_with(parent) && path != parent
}

fn normalize_mount_path(path: &str) -> PathBuf {
    let mut components = Vec::new();

    for component in Path::new(path).components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => match components.last() {
                Some(Component::Normal(_)) => {
                    components.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => components.push(component),
            },
            _ => components.push(component),
        }
    }

    let mut normalized = PathBuf::new();
    for component in components {
        normalized.push(component.as_os_str());
    }
    normalized
}

fn mount_paths_conflict(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|msg| (*msg).to_owned()))
        .unwrap_or_else(|| "unknown".to_owned())
}

fn run_download_task(task: DownloadTask) -> bool {
    let start = Instant::now();
    log_info!(LOG_TAG, "Downloading {} to {}", task.label, task.mount_path);
    let mut remote_metrics = task.is_remote_url().then(RemoteArchiveTaskMetrics::default);

    match download_with_retry(&task.url, &task.mount_path, remote_metrics.as_mut()) {
        Ok(()) => {
            let elapsed = start.elapsed();
            record_sandbox_op(task.archive_kind.total_action(), elapsed, true, None);
            if let Some(metrics) = &remote_metrics {
                record_remote_archive_attribution(task.archive_kind, metrics, true);
            }
            log_info!(
                LOG_TAG,
                "{} downloaded in {}ms",
                task.label,
                elapsed.as_millis()
            );
            true
        }
        Err(e) => {
            let failure_detail = task.failure_detail(&e);
            record_sandbox_op(
                task.archive_kind.total_action(),
                start.elapsed(),
                false,
                Some(&failure_detail),
            );
            if let Some(metrics) = &remote_metrics {
                record_remote_archive_attribution(task.archive_kind, metrics, false);
            }
            log_error!(LOG_TAG, "{failure_detail}");
            false
        }
    }
}

fn record_remote_archive_attribution(
    archive_kind: ArchiveKind,
    metrics: &RemoteArchiveTaskMetrics,
    success: bool,
) {
    record_sandbox_op(
        archive_kind.request_to_response_headers_action(),
        metrics.request_to_response_headers,
        success,
        None,
    );
    record_sandbox_op(
        archive_kind.body_read_action(),
        metrics.body_read,
        success,
        None,
    );
    record_sandbox_op(
        archive_kind.extract_outside_body_read_action(),
        metrics.extract_outside_body_read,
        success,
        None,
    );
    record_sandbox_op(
        archive_kind.compressed_bytes_consumed_action(metrics.compressed_bytes_consumed),
        Duration::ZERO,
        success,
        None,
    );
    record_sandbox_op(
        archive_kind.attempt_count_action(metrics.attempts),
        Duration::ZERO,
        success,
        None,
    );
}

/// Download and extract an archive, retrying retriable failures.
///
/// Every attempt uses the same `target_path`. The retry loop neither clears the
/// target nor rolls back files written by a failed extraction attempt, so later
/// attempts run against any filesystem state left by earlier ones.
fn download_with_retry(
    url: &str,
    target_path: &str,
    mut remote_metrics: Option<&mut RemoteArchiveTaskMetrics>,
) -> Result<(), DownloadError> {
    let mut last_error = None;

    for attempt in 1..=MAX_RETRIES {
        if let Some(metrics) = remote_metrics.as_deref_mut() {
            metrics.begin_attempt();
        }
        let attempt_start = Instant::now();
        match download_and_extract(url, target_path, remote_metrics.as_deref_mut()) {
            Ok(()) => return Ok(()),
            Err(e) => {
                log_warn!(
                    LOG_TAG,
                    "Attempt {attempt}/{MAX_RETRIES} failed after {}ms: {e}",
                    attempt_start.elapsed().as_millis()
                );
                let should_break = !e.retriable;
                last_error = Some(e);
                if should_break {
                    break;
                }
                if attempt < MAX_RETRIES {
                    thread::sleep(RETRY_DELAY);
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| DownloadError::fatal("download failed with no error")))
}

fn download_and_extract(
    url: &str,
    target_path: &str,
    remote_metrics: Option<&mut RemoteArchiveTaskMetrics>,
) -> Result<(), DownloadError> {
    fs::create_dir_all(target_path).map_err(|e| {
        DownloadError::fatal(format!("Failed to create directory {target_path}: {e}"))
    })?;

    let attempt_metrics = remote_metrics
        .is_some()
        .then(source::RemoteArchiveAttemptMetrics::default);
    let reader = match source::open_archive(url, attempt_metrics.as_ref()) {
        Ok(reader) => reader,
        Err(error) => {
            if let (Some(metrics), Some(attempt_metrics)) = (remote_metrics, &attempt_metrics) {
                metrics.record_attempt(attempt_metrics.snapshot(), Duration::ZERO);
            }
            return Err(error);
        }
    };
    let extract_start = Instant::now();
    let result = archive::extract_tar_gz(reader, target_path);
    let extract_wall = extract_start.elapsed();
    if let (Some(metrics), Some(attempt_metrics)) = (remote_metrics, &attempt_metrics) {
        metrics.record_attempt(attempt_metrics.snapshot(), extract_wall);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::{Mutex, MutexGuard};

    static SANDBOX_OP_TEST_LOCK: Mutex<()> = Mutex::new(());

    struct SandboxOpsLogGuard {
        _lock: MutexGuard<'static, ()>,
    }

    impl SandboxOpsLogGuard {
        fn set(path: impl AsRef<Path>) -> Self {
            let lock = SANDBOX_OP_TEST_LOCK
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guest_common::telemetry::set_sandbox_ops_log_file(path);
            Self { _lock: lock }
        }
    }

    impl Drop for SandboxOpsLogGuard {
        fn drop(&mut self) {
            guest_common::telemetry::clear_sandbox_ops_log_file();
        }
    }

    fn task_at(path: &str, kind: DownloadTaskKind) -> DownloadTask {
        DownloadTask::new_with_kind(
            format!("task {path}"),
            ArchiveKind::Storage,
            "file:///tmp/archive.tar.gz".to_owned(),
            path.to_owned(),
            kind,
        )
    }

    fn active_at(path: &str, kind: DownloadTaskKind) -> ActiveDownload {
        ActiveDownload {
            id: 0,
            mount_path: normalize_mount_path(path),
            kind,
        }
    }

    #[test]
    fn mount_paths_conflict_for_exact_and_parent_child_paths() {
        assert!(mount_paths_conflict(
            &normalize_mount_path("/tmp/mount"),
            &normalize_mount_path("/tmp/mount")
        ));
        assert!(mount_paths_conflict(
            &normalize_mount_path("/tmp/mount"),
            &normalize_mount_path("/tmp/mount/child")
        ));
        assert!(mount_paths_conflict(
            &normalize_mount_path("/tmp/mount/child"),
            &normalize_mount_path("/tmp/mount")
        ));
    }

    #[test]
    fn mount_paths_do_not_conflict_for_siblings_or_prefix_traps() {
        assert!(!mount_paths_conflict(
            &normalize_mount_path("/tmp/mount-a"),
            &normalize_mount_path("/tmp/mount-b")
        ));
        assert!(!mount_paths_conflict(
            &normalize_mount_path("/tmp/foo/bar"),
            &normalize_mount_path("/tmp/foo/barista")
        ));
    }

    #[test]
    fn mount_path_conflicts_use_lexical_normalization() {
        assert!(mount_paths_conflict(
            &normalize_mount_path("/tmp//foo/./bar/baz/.."),
            &normalize_mount_path("/tmp/foo/bar")
        ));
        assert!(!mount_paths_conflict(
            &normalize_mount_path("/tmp/foo/bar/../barista"),
            &normalize_mount_path("/tmp/foo/bar")
        ));
    }

    #[test]
    fn task_kind_classification_identifies_instructions_and_skill_children() {
        assert_eq!(
            classify_download_task_kind("/home/user/.codex", Some("AGENTS.md")),
            DownloadTaskKind::FrameworkHomeInstructions
        );
        assert_eq!(
            classify_download_task_kind("/home/user/.codex/skills/workflow", None),
            DownloadTaskKind::FrameworkSkillChild
        );
        assert_eq!(
            classify_download_task_kind("/home/user/.claude/skills/tool", None),
            DownloadTaskKind::FrameworkSkillChild
        );
        assert_eq!(
            classify_download_task_kind("/home/user/.codex/skills", None),
            DownloadTaskKind::Other
        );
        assert_eq!(
            classify_download_task_kind("/workspace", None),
            DownloadTaskKind::Other
        );
    }

    #[test]
    fn task_kind_classification_uses_normalized_component_paths() {
        assert_eq!(
            classify_download_task_kind("/home/user/.codex/skills/./workflow", None),
            DownloadTaskKind::FrameworkSkillChild
        );
        assert_eq!(
            classify_download_task_kind("/home/user/.claude/skills/./tool", None),
            DownloadTaskKind::FrameworkSkillChild
        );
        assert_eq!(
            classify_download_task_kind("/home/user/.codex/skills/../workflow", None),
            DownloadTaskKind::Other
        );
        assert_eq!(
            classify_download_task_kind("/home/user/.claude/skills", None),
            DownloadTaskKind::Other
        );
        assert_eq!(
            classify_download_task_kind("/home/user/.claude/skills-old/tool", None),
            DownloadTaskKind::Other
        );
    }

    #[test]
    fn conflict_classifier_buckets_exact_instruction_skill_and_other_parent_child() {
        assert_eq!(
            classify_download_conflict(
                &normalize_mount_path("/home/user/.codex/skills/foo"),
                DownloadTaskKind::FrameworkSkillChild,
                &normalize_mount_path("/home/user/.codex"),
                DownloadTaskKind::FrameworkHomeInstructions,
            ),
            Some(DownloadConflictKind::InstructionsSkill)
        );
        assert_eq!(
            classify_download_conflict(
                &normalize_mount_path("/same"),
                DownloadTaskKind::Other,
                &normalize_mount_path("/same"),
                DownloadTaskKind::Other,
            ),
            Some(DownloadConflictKind::ExactPath)
        );
        assert_eq!(
            classify_download_conflict(
                &normalize_mount_path("/tmp/parent/child"),
                DownloadTaskKind::Other,
                &normalize_mount_path("/tmp/parent"),
                DownloadTaskKind::Other,
            ),
            Some(DownloadConflictKind::OtherParentChild)
        );
        assert_eq!(
            classify_download_conflict(
                &normalize_mount_path("/home/user/.codex/skills/foo"),
                DownloadTaskKind::FrameworkSkillChild,
                &normalize_mount_path("/home/user/.codex/skills/bar"),
                DownloadTaskKind::FrameworkSkillChild,
            ),
            None
        );
    }

    #[test]
    fn conflict_classifier_does_not_overlap_staged_instructions_with_skill_children() {
        assert_eq!(
            classify_download_conflict(
                &normalize_mount_path("/home/user/.codex/skills/workflow"),
                DownloadTaskKind::FrameworkSkillChild,
                &normalize_mount_path(
                    "/home/user/.vm0/guest-agent/runs/run-id/storage-instructions/0",
                ),
                DownloadTaskKind::FrameworkHomeInstructions,
            ),
            None
        );
    }

    #[test]
    fn potential_parent_child_overlap_count_excludes_exact_paths_and_siblings() {
        let tasks = [
            task_at("/workspace", DownloadTaskKind::Other),
            task_at("/workspace/src", DownloadTaskKind::Other),
            task_at("/workspace/tests", DownloadTaskKind::Other),
            task_at("/workspace/src", DownloadTaskKind::Other),
            task_at("/workspace/src/nested", DownloadTaskKind::Other),
        ];

        assert_eq!(potential_parent_child_overlap_count(&tasks), 6);
    }

    #[test]
    fn task_panic_returns_false_without_unwinding() {
        guest_common::log::clear_system_log_file();

        fn runner(task: DownloadTask) -> bool {
            if task.url == "panic" {
                panic!("expected panic");
            }
            true
        }

        let result = std::panic::catch_unwind(|| {
            download_all_parallel_with_runner(
                vec![
                    DownloadTask::new(
                        "panic".to_owned(),
                        ArchiveKind::Storage,
                        "panic".to_owned(),
                        "/tmp/panic".to_owned(),
                    ),
                    DownloadTask::new(
                        "success".to_owned(),
                        ArchiveKind::Storage,
                        "success".to_owned(),
                        "/tmp/success".to_owned(),
                    ),
                ],
                runner,
            )
        });

        assert!(matches!(result, Ok(false)));
    }

    #[test]
    fn find_startable_download_counts_mount_conflict_deferrals() {
        let pending = VecDeque::from(vec![
            DownloadTask::new(
                "blocked child".to_owned(),
                ArchiveKind::Storage,
                "file:///tmp/archive.tar.gz".to_owned(),
                "/tmp/mount/child".to_owned(),
            ),
            DownloadTask::new(
                "independent".to_owned(),
                ArchiveKind::Artifact,
                "https://example.com/archive.tar.gz".to_owned(),
                "/tmp/other".to_owned(),
            ),
        ]);
        let active = vec![ActiveDownload {
            id: 0,
            mount_path: normalize_mount_path("/tmp/mount"),
            kind: DownloadTaskKind::Other,
        }];

        let startable = find_startable_download(&pending, &active);

        assert_eq!(
            startable.conflict_deferrals,
            DownloadConflictDeferralStats {
                total: 1,
                instructions_skill: 0,
                exact_path: 0,
                other_parent_child: 1,
            }
        );
        assert_eq!(startable.selected.map(|(index, _, _)| index), Some(1));
    }

    #[test]
    fn find_startable_download_buckets_instruction_skill_deferrals_in_both_directions() {
        let independent = task_at("/tmp/other", DownloadTaskKind::Other);

        let pending_child = VecDeque::from(vec![
            task_at(
                "/home/user/.codex/skills/workflow",
                DownloadTaskKind::FrameworkSkillChild,
            ),
            independent,
        ]);
        let active_parent = vec![active_at(
            "/home/user/.codex",
            DownloadTaskKind::FrameworkHomeInstructions,
        )];
        let child_startable = find_startable_download(&pending_child, &active_parent);

        assert_eq!(
            child_startable.conflict_deferrals,
            DownloadConflictDeferralStats {
                total: 1,
                instructions_skill: 1,
                exact_path: 0,
                other_parent_child: 0,
            }
        );
        assert_eq!(child_startable.selected.map(|(index, _, _)| index), Some(1));

        let pending_parent = VecDeque::from(vec![
            task_at(
                "/home/user/.claude",
                DownloadTaskKind::FrameworkHomeInstructions,
            ),
            task_at("/tmp/other", DownloadTaskKind::Other),
        ]);
        let active_child = vec![active_at(
            "/home/user/.claude/skills/workflow",
            DownloadTaskKind::FrameworkSkillChild,
        )];
        let parent_startable = find_startable_download(&pending_parent, &active_child);

        assert_eq!(
            parent_startable.conflict_deferrals,
            DownloadConflictDeferralStats {
                total: 1,
                instructions_skill: 1,
                exact_path: 0,
                other_parent_child: 0,
            }
        );
        assert_eq!(
            parent_startable.selected.map(|(index, _, _)| index),
            Some(1)
        );
    }

    #[test]
    fn find_startable_download_buckets_exact_path_deferrals() {
        let pending = VecDeque::from(vec![
            task_at("/tmp/mount", DownloadTaskKind::Other),
            task_at("/tmp/other", DownloadTaskKind::Other),
        ]);
        let active = vec![active_at("/tmp/mount", DownloadTaskKind::Other)];

        let startable = find_startable_download(&pending, &active);

        assert_eq!(
            startable.conflict_deferrals,
            DownloadConflictDeferralStats {
                total: 1,
                instructions_skill: 0,
                exact_path: 1,
                other_parent_child: 0,
            }
        );
        assert_eq!(startable.selected.map(|(index, _, _)| index), Some(1));
    }

    #[test]
    fn download_all_parallel_records_conflict_shape_actions() {
        let dir = tempfile::tempdir().unwrap();
        let ops_path = dir.path().join("sandbox-ops.jsonl");
        let _ops_guard = SandboxOpsLogGuard::set(&ops_path);

        fn runner(_task: DownloadTask) -> bool {
            true
        }

        let success = download_all_parallel_with_runner(
            vec![
                task_at(
                    "/home/user/.codex",
                    DownloadTaskKind::FrameworkHomeInstructions,
                ),
                task_at(
                    "/home/user/.codex/skills/workflow",
                    DownloadTaskKind::FrameworkSkillChild,
                ),
            ],
            runner,
        );

        assert!(success);
        let ops = std::fs::read_to_string(&ops_path).unwrap();
        assert!(ops.contains(r#""action_type":"guest_download_task_count_2""#));
        assert!(ops.contains(r#""action_type":"guest_download_skill_child_task_count_1""#));
        assert!(ops.contains(
            r#""action_type":"guest_download_framework_home_instructions_task_present""#
        ));
        assert!(
            ops.contains(
                r#""action_type":"guest_download_potential_parent_child_overlap_count_1""#
            )
        );
        assert!(ops.contains(r#""action_type":"guest_download_mount_conflict_deferral_count_1""#));
        assert!(ops.contains(
            r#""action_type":"guest_download_instructions_skill_conflict_deferral_count_1""#
        ));
        assert!(
            ops.contains(r#""action_type":"guest_download_exact_path_conflict_deferral_count_0""#)
        );
        assert!(ops.contains(
            r#""action_type":"guest_download_other_parent_child_conflict_deferral_count_0""#
        ));
    }

    #[test]
    fn download_task_failure_detail_includes_entry_metadata() {
        let task = DownloadTask::new(
            "storage 1 mountPath=/workspace vasStorageName=repo vasVersionId=v1 urlScheme=file cached=false"
                .into(),
            ArchiveKind::Storage,
            "file:///tmp/archive.tar.gz".into(),
            "/workspace".into(),
        );
        let error = DownloadError::fatal("Failed to read archive entries: invalid gzip header");

        let detail = task.failure_detail(&error);

        assert!(detail.contains("storage 1"));
        assert!(detail.contains("mountPath=/workspace"));
        assert!(detail.contains("vasStorageName=repo"));
        assert!(detail.contains("vasVersionId=v1"));
        assert!(detail.contains("urlScheme=file"));
        assert!(detail.contains("Failed to read archive entries"));
    }
}
