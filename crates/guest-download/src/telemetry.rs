use crate::source;
use guest_common::telemetry::record_sandbox_op;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArchiveKind {
    Storage,
    Artifact,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceKind {
    Remote,
    File,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TaskKind {
    FrameworkHomeInstructions,
    FrameworkSkillChild,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TaskMetadata {
    archive_kind: ArchiveKind,
    source_kind: SourceKind,
    task_kind: TaskKind,
}

impl TaskMetadata {
    pub(crate) fn storage(
        url: &str,
        normalized_mount_path: &Path,
        instructions_target_filename: Option<&str>,
    ) -> Self {
        Self::new(
            ArchiveKind::Storage,
            url,
            normalized_mount_path,
            instructions_target_filename,
        )
    }

    pub(crate) fn artifact(url: &str, normalized_mount_path: &Path) -> Self {
        Self::new(ArchiveKind::Artifact, url, normalized_mount_path, None)
    }

    fn new(
        archive_kind: ArchiveKind,
        url: &str,
        normalized_mount_path: &Path,
        instructions_target_filename: Option<&str>,
    ) -> Self {
        Self {
            archive_kind,
            source_kind: classify_source(url),
            task_kind: classify_task(normalized_mount_path, instructions_target_filename),
        }
    }
}

fn classify_source(url: &str) -> SourceKind {
    if url.starts_with("http://") || url.starts_with("https://") {
        SourceKind::Remote
    } else if url.starts_with("file://") {
        SourceKind::File
    } else {
        SourceKind::Other
    }
}

fn classify_task(
    normalized_mount_path: &Path,
    instructions_target_filename: Option<&str>,
) -> TaskKind {
    if instructions_target_filename.is_some() {
        TaskKind::FrameworkHomeInstructions
    } else if is_framework_skill_child_path(normalized_mount_path) {
        TaskKind::FrameworkSkillChild
    } else {
        TaskKind::Other
    }
}

fn is_framework_skill_child_path(path: &Path) -> bool {
    is_child_path(path, Path::new("/home/user/.codex/skills"))
        || is_child_path(path, Path::new("/home/user/.claude/skills"))
}

fn is_child_path(path: &Path, parent: &Path) -> bool {
    path.starts_with(parent) && path != parent
}

pub(crate) struct TaskSnapshot {
    metadata: TaskMetadata,
    mount_path: PathBuf,
}

impl TaskSnapshot {
    pub(crate) fn new(metadata: TaskMetadata, mount_path: PathBuf) -> Self {
        Self {
            metadata,
            mount_path,
        }
    }
}

pub(crate) struct BatchRecorder {
    task_kinds: Vec<TaskKind>,
    conflict_deferrals: ConflictDeferralStats,
}

impl BatchRecorder {
    pub(crate) fn new(tasks: impl IntoIterator<Item = TaskSnapshot>) -> Self {
        let tasks: Vec<TaskSnapshot> = tasks.into_iter().collect();
        record_batch_attribution(&tasks);
        Self {
            task_kinds: tasks.iter().map(|task| task.metadata.task_kind).collect(),
            conflict_deferrals: ConflictDeferralStats::default(),
        }
    }

    pub(crate) fn record_conflict(
        &mut self,
        pending_id: usize,
        pending_path: &Path,
        active_id: usize,
        active_path: &Path,
    ) {
        let pending_kind = self.task_kinds.get(pending_id).copied();
        let active_kind = self.task_kinds.get(active_id).copied();
        debug_assert!(
            pending_kind.is_some() && active_kind.is_some(),
            "download telemetry id is out of range"
        );
        let (Some(pending_kind), Some(active_kind)) = (pending_kind, active_kind) else {
            return;
        };
        self.conflict_deferrals.record(classify_conflict(
            pending_path,
            pending_kind,
            active_path,
            active_kind,
        ));
    }

    pub(crate) fn finish(self) {
        record_sandbox_op(
            CountMetric::MountConflictDeferral.action(self.conflict_deferrals.total),
            Duration::ZERO,
            true,
            None,
        );
        record_sandbox_op(
            CountMetric::InstructionsSkillConflictDeferral
                .action(self.conflict_deferrals.instructions_skill),
            Duration::ZERO,
            true,
            None,
        );
        record_sandbox_op(
            CountMetric::ExactPathConflictDeferral.action(self.conflict_deferrals.exact_path),
            Duration::ZERO,
            true,
            None,
        );
        record_sandbox_op(
            CountMetric::OtherParentChildConflictDeferral
                .action(self.conflict_deferrals.other_parent_child),
            Duration::ZERO,
            true,
            None,
        );
    }
}

fn record_batch_attribution(tasks: &[TaskSnapshot]) {
    record_sandbox_op(
        CountMetric::Task.action(tasks.len()),
        Duration::ZERO,
        true,
        None,
    );
    record_sandbox_op(
        CountMetric::RemoteUrl.action(
            tasks
                .iter()
                .filter(|task| task.metadata.source_kind == SourceKind::Remote)
                .count(),
        ),
        Duration::ZERO,
        true,
        None,
    );
    record_sandbox_op(
        CountMetric::FileUrl.action(
            tasks
                .iter()
                .filter(|task| task.metadata.source_kind == SourceKind::File)
                .count(),
        ),
        Duration::ZERO,
        true,
        None,
    );
    record_sandbox_op(
        CountMetric::SkillChildTask.action(
            tasks
                .iter()
                .filter(|task| task.metadata.task_kind == TaskKind::FrameworkSkillChild)
                .count(),
        ),
        Duration::ZERO,
        true,
        None,
    );
    record_sandbox_op(
        framework_home_instructions_action(
            tasks
                .iter()
                .any(|task| task.metadata.task_kind == TaskKind::FrameworkHomeInstructions),
        ),
        Duration::ZERO,
        true,
        None,
    );
    record_sandbox_op(
        CountMetric::PotentialParentChildOverlap
            .action(potential_parent_child_overlap_count(tasks)),
        Duration::ZERO,
        true,
        None,
    );
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ConflictKind {
    InstructionsSkill,
    ExactPath,
    OtherParentChild,
}

fn classify_conflict(
    left_path: &Path,
    left_kind: TaskKind,
    right_path: &Path,
    right_kind: TaskKind,
) -> ConflictKind {
    if left_path == right_path {
        ConflictKind::ExactPath
    } else if task_kinds_are_instructions_and_skill(left_kind, right_kind) {
        ConflictKind::InstructionsSkill
    } else {
        ConflictKind::OtherParentChild
    }
}

fn task_kinds_are_instructions_and_skill(left: TaskKind, right: TaskKind) -> bool {
    matches!(
        (left, right),
        (
            TaskKind::FrameworkHomeInstructions,
            TaskKind::FrameworkSkillChild
        ) | (
            TaskKind::FrameworkSkillChild,
            TaskKind::FrameworkHomeInstructions
        )
    )
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ConflictDeferralStats {
    total: usize,
    instructions_skill: usize,
    exact_path: usize,
    other_parent_child: usize,
}

impl ConflictDeferralStats {
    fn record(&mut self, kind: ConflictKind) {
        self.total += 1;
        match kind {
            ConflictKind::InstructionsSkill => self.instructions_skill += 1,
            ConflictKind::ExactPath => self.exact_path += 1,
            ConflictKind::OtherParentChild => self.other_parent_child += 1,
        }
    }
}

fn potential_parent_child_overlap_count(tasks: &[TaskSnapshot]) -> usize {
    let mut path_counts = HashMap::new();
    for task in tasks {
        *path_counts.entry(task.mount_path.clone()).or_insert(0usize) += 1;
    }

    let mut count = 0;
    for task in tasks {
        for ancestor in task.mount_path.ancestors().skip(1) {
            if let Some(ancestor_count) = path_counts.get(ancestor) {
                count += ancestor_count;
            }
        }
    }
    count
}

pub(crate) struct TaskRecorder {
    metadata: TaskMetadata,
    remote_metrics: Option<RemoteArchiveTaskMetrics>,
}

impl TaskRecorder {
    pub(crate) fn new(metadata: TaskMetadata) -> Self {
        Self {
            metadata,
            remote_metrics: (metadata.source_kind == SourceKind::Remote)
                .then(RemoteArchiveTaskMetrics::default),
        }
    }

    pub(crate) fn begin_attempt(&mut self) -> Option<source::RemoteArchiveAttemptMetrics> {
        let metrics = self.remote_metrics.as_mut()?;
        metrics.attempts = metrics.attempts.saturating_add(1);
        Some(source::RemoteArchiveAttemptMetrics::default())
    }

    pub(crate) fn record_attempt(
        &mut self,
        metrics: &source::RemoteArchiveAttemptMetrics,
        extract_wall: Duration,
    ) {
        let Some(remote_metrics) = self.remote_metrics.as_mut() else {
            return;
        };
        let snapshot = metrics.snapshot();
        remote_metrics.request_to_response_headers = remote_metrics
            .request_to_response_headers
            .saturating_add(snapshot.request_to_response_headers);
        remote_metrics.body_read = remote_metrics.body_read.saturating_add(snapshot.body_read);
        remote_metrics.extract_outside_body_read = remote_metrics
            .extract_outside_body_read
            .saturating_add(extract_wall.saturating_sub(snapshot.body_read));
        remote_metrics.compressed_bytes_consumed = remote_metrics
            .compressed_bytes_consumed
            .saturating_add(snapshot.compressed_bytes_consumed);
    }

    pub(crate) fn finish(self, elapsed: Duration, success: bool, failure_detail: Option<&str>) {
        record_sandbox_op(
            archive_action(self.metadata.archive_kind, ArchiveMetric::Total),
            elapsed,
            success,
            failure_detail,
        );
        let Some(metrics) = self.remote_metrics else {
            return;
        };
        record_sandbox_op(
            archive_action(
                self.metadata.archive_kind,
                ArchiveMetric::RequestToResponseHeaders,
            ),
            metrics.request_to_response_headers,
            success,
            None,
        );
        record_sandbox_op(
            archive_action(self.metadata.archive_kind, ArchiveMetric::BodyRead),
            metrics.body_read,
            success,
            None,
        );
        record_sandbox_op(
            archive_action(
                self.metadata.archive_kind,
                ArchiveMetric::ExtractOutsideBodyRead,
            ),
            metrics.extract_outside_body_read,
            success,
            None,
        );
        record_sandbox_op(
            archive_action(
                self.metadata.archive_kind,
                ArchiveMetric::CompressedBytes(CompressedBytesBucket::from_bytes(
                    metrics.compressed_bytes_consumed,
                )),
            ),
            Duration::ZERO,
            success,
            None,
        );
        record_sandbox_op(
            archive_action(
                self.metadata.archive_kind,
                ArchiveMetric::AttemptCount(AttemptCountBucket::from_attempts(metrics.attempts)),
            ),
            Duration::ZERO,
            success,
            None,
        );
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CountMetric {
    Task,
    RemoteUrl,
    FileUrl,
    SkillChildTask,
    PotentialParentChildOverlap,
    MountConflictDeferral,
    InstructionsSkillConflictDeferral,
    ExactPathConflictDeferral,
    OtherParentChildConflictDeferral,
}

impl CountMetric {
    fn action(self, count: usize) -> &'static str {
        CountBucket::from_count(count).select(self.actions())
    }

    fn actions(self) -> [&'static str; 7] {
        match self {
            Self::Task => [
                "guest_download_task_count_0",
                "guest_download_task_count_1",
                "guest_download_task_count_2",
                "guest_download_task_count_3_4",
                "guest_download_task_count_5_8",
                "guest_download_task_count_9_16",
                "guest_download_task_count_17_plus",
            ],
            Self::RemoteUrl => [
                "guest_download_remote_url_count_0",
                "guest_download_remote_url_count_1",
                "guest_download_remote_url_count_2",
                "guest_download_remote_url_count_3_4",
                "guest_download_remote_url_count_5_8",
                "guest_download_remote_url_count_9_16",
                "guest_download_remote_url_count_17_plus",
            ],
            Self::FileUrl => [
                "guest_download_file_url_count_0",
                "guest_download_file_url_count_1",
                "guest_download_file_url_count_2",
                "guest_download_file_url_count_3_4",
                "guest_download_file_url_count_5_8",
                "guest_download_file_url_count_9_16",
                "guest_download_file_url_count_17_plus",
            ],
            Self::SkillChildTask => [
                "guest_download_skill_child_task_count_0",
                "guest_download_skill_child_task_count_1",
                "guest_download_skill_child_task_count_2",
                "guest_download_skill_child_task_count_3_4",
                "guest_download_skill_child_task_count_5_8",
                "guest_download_skill_child_task_count_9_16",
                "guest_download_skill_child_task_count_17_plus",
            ],
            Self::PotentialParentChildOverlap => [
                "guest_download_potential_parent_child_overlap_count_0",
                "guest_download_potential_parent_child_overlap_count_1",
                "guest_download_potential_parent_child_overlap_count_2",
                "guest_download_potential_parent_child_overlap_count_3_4",
                "guest_download_potential_parent_child_overlap_count_5_8",
                "guest_download_potential_parent_child_overlap_count_9_16",
                "guest_download_potential_parent_child_overlap_count_17_plus",
            ],
            Self::MountConflictDeferral => [
                "guest_download_mount_conflict_deferral_count_0",
                "guest_download_mount_conflict_deferral_count_1",
                "guest_download_mount_conflict_deferral_count_2",
                "guest_download_mount_conflict_deferral_count_3_4",
                "guest_download_mount_conflict_deferral_count_5_8",
                "guest_download_mount_conflict_deferral_count_9_16",
                "guest_download_mount_conflict_deferral_count_17_plus",
            ],
            Self::InstructionsSkillConflictDeferral => [
                "guest_download_instructions_skill_conflict_deferral_count_0",
                "guest_download_instructions_skill_conflict_deferral_count_1",
                "guest_download_instructions_skill_conflict_deferral_count_2",
                "guest_download_instructions_skill_conflict_deferral_count_3_4",
                "guest_download_instructions_skill_conflict_deferral_count_5_8",
                "guest_download_instructions_skill_conflict_deferral_count_9_16",
                "guest_download_instructions_skill_conflict_deferral_count_17_plus",
            ],
            Self::ExactPathConflictDeferral => [
                "guest_download_exact_path_conflict_deferral_count_0",
                "guest_download_exact_path_conflict_deferral_count_1",
                "guest_download_exact_path_conflict_deferral_count_2",
                "guest_download_exact_path_conflict_deferral_count_3_4",
                "guest_download_exact_path_conflict_deferral_count_5_8",
                "guest_download_exact_path_conflict_deferral_count_9_16",
                "guest_download_exact_path_conflict_deferral_count_17_plus",
            ],
            Self::OtherParentChildConflictDeferral => [
                "guest_download_other_parent_child_conflict_deferral_count_0",
                "guest_download_other_parent_child_conflict_deferral_count_1",
                "guest_download_other_parent_child_conflict_deferral_count_2",
                "guest_download_other_parent_child_conflict_deferral_count_3_4",
                "guest_download_other_parent_child_conflict_deferral_count_5_8",
                "guest_download_other_parent_child_conflict_deferral_count_9_16",
                "guest_download_other_parent_child_conflict_deferral_count_17_plus",
            ],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CountBucket {
    Zero,
    One,
    Two,
    ThreeToFour,
    FiveToEight,
    NineToSixteen,
    SeventeenPlus,
}

impl CountBucket {
    fn from_count(count: usize) -> Self {
        match count {
            0 => Self::Zero,
            1 => Self::One,
            2 => Self::Two,
            3 | 4 => Self::ThreeToFour,
            5..=8 => Self::FiveToEight,
            9..=16 => Self::NineToSixteen,
            _ => Self::SeventeenPlus,
        }
    }

    fn select(self, actions: [&'static str; 7]) -> &'static str {
        let [
            zero,
            one,
            two,
            three_to_four,
            five_to_eight,
            nine_to_sixteen,
            seventeen_plus,
        ] = actions;
        match self {
            Self::Zero => zero,
            Self::One => one,
            Self::Two => two,
            Self::ThreeToFour => three_to_four,
            Self::FiveToEight => five_to_eight,
            Self::NineToSixteen => nine_to_sixteen,
            Self::SeventeenPlus => seventeen_plus,
        }
    }
}

fn framework_home_instructions_action(present: bool) -> &'static str {
    if present {
        "guest_download_framework_home_instructions_task_present"
    } else {
        "guest_download_framework_home_instructions_task_absent"
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArchiveMetric {
    Total,
    RequestToResponseHeaders,
    BodyRead,
    ExtractOutsideBodyRead,
    CompressedBytes(CompressedBytesBucket),
    AttemptCount(AttemptCountBucket),
}

fn archive_action(kind: ArchiveKind, metric: ArchiveMetric) -> &'static str {
    match (kind, metric) {
        (ArchiveKind::Storage, ArchiveMetric::Total) => "storage_download",
        (ArchiveKind::Artifact, ArchiveMetric::Total) => "artifact_download",
        (ArchiveKind::Storage, ArchiveMetric::RequestToResponseHeaders) => {
            "storage_download_remote_request_to_response_headers"
        }
        (ArchiveKind::Artifact, ArchiveMetric::RequestToResponseHeaders) => {
            "artifact_download_remote_request_to_response_headers"
        }
        (ArchiveKind::Storage, ArchiveMetric::BodyRead) => "storage_download_remote_body_read",
        (ArchiveKind::Artifact, ArchiveMetric::BodyRead) => "artifact_download_remote_body_read",
        (ArchiveKind::Storage, ArchiveMetric::ExtractOutsideBodyRead) => {
            "storage_download_remote_extract_outside_body_read"
        }
        (ArchiveKind::Artifact, ArchiveMetric::ExtractOutsideBodyRead) => {
            "artifact_download_remote_extract_outside_body_read"
        }
        (ArchiveKind::Storage, ArchiveMetric::CompressedBytes(CompressedBytesBucket::Zero)) => {
            "storage_download_remote_compressed_bytes_consumed_zero"
        }
        (
            ArchiveKind::Storage,
            ArchiveMetric::CompressedBytes(CompressedBytesBucket::Under64Kib),
        ) => "storage_download_remote_compressed_bytes_consumed_lt_64_kib",
        (
            ArchiveKind::Storage,
            ArchiveMetric::CompressedBytes(CompressedBytesBucket::Kib64To256),
        ) => "storage_download_remote_compressed_bytes_consumed_64_kib_to_256_kib",
        (
            ArchiveKind::Storage,
            ArchiveMetric::CompressedBytes(CompressedBytesBucket::Kib256To1Mib),
        ) => "storage_download_remote_compressed_bytes_consumed_256_kib_to_1_mib",
        (ArchiveKind::Storage, ArchiveMetric::CompressedBytes(CompressedBytesBucket::Mib1To4)) => {
            "storage_download_remote_compressed_bytes_consumed_1_mib_to_4_mib"
        }
        (ArchiveKind::Storage, ArchiveMetric::CompressedBytes(CompressedBytesBucket::Mib4To16)) => {
            "storage_download_remote_compressed_bytes_consumed_4_mib_to_16_mib"
        }
        (
            ArchiveKind::Storage,
            ArchiveMetric::CompressedBytes(CompressedBytesBucket::Mib16To64),
        ) => "storage_download_remote_compressed_bytes_consumed_16_mib_to_64_mib",
        (
            ArchiveKind::Storage,
            ArchiveMetric::CompressedBytes(CompressedBytesBucket::Mib64Plus),
        ) => "storage_download_remote_compressed_bytes_consumed_64_mib_plus",
        (ArchiveKind::Artifact, ArchiveMetric::CompressedBytes(CompressedBytesBucket::Zero)) => {
            "artifact_download_remote_compressed_bytes_consumed_zero"
        }
        (
            ArchiveKind::Artifact,
            ArchiveMetric::CompressedBytes(CompressedBytesBucket::Under64Kib),
        ) => "artifact_download_remote_compressed_bytes_consumed_lt_64_kib",
        (
            ArchiveKind::Artifact,
            ArchiveMetric::CompressedBytes(CompressedBytesBucket::Kib64To256),
        ) => "artifact_download_remote_compressed_bytes_consumed_64_kib_to_256_kib",
        (
            ArchiveKind::Artifact,
            ArchiveMetric::CompressedBytes(CompressedBytesBucket::Kib256To1Mib),
        ) => "artifact_download_remote_compressed_bytes_consumed_256_kib_to_1_mib",
        (ArchiveKind::Artifact, ArchiveMetric::CompressedBytes(CompressedBytesBucket::Mib1To4)) => {
            "artifact_download_remote_compressed_bytes_consumed_1_mib_to_4_mib"
        }
        (
            ArchiveKind::Artifact,
            ArchiveMetric::CompressedBytes(CompressedBytesBucket::Mib4To16),
        ) => "artifact_download_remote_compressed_bytes_consumed_4_mib_to_16_mib",
        (
            ArchiveKind::Artifact,
            ArchiveMetric::CompressedBytes(CompressedBytesBucket::Mib16To64),
        ) => "artifact_download_remote_compressed_bytes_consumed_16_mib_to_64_mib",
        (
            ArchiveKind::Artifact,
            ArchiveMetric::CompressedBytes(CompressedBytesBucket::Mib64Plus),
        ) => "artifact_download_remote_compressed_bytes_consumed_64_mib_plus",
        (ArchiveKind::Storage, ArchiveMetric::AttemptCount(AttemptCountBucket::One)) => {
            "storage_download_remote_attempt_count_1"
        }
        (ArchiveKind::Storage, ArchiveMetric::AttemptCount(AttemptCountBucket::Two)) => {
            "storage_download_remote_attempt_count_2"
        }
        (ArchiveKind::Storage, ArchiveMetric::AttemptCount(AttemptCountBucket::Three)) => {
            "storage_download_remote_attempt_count_3"
        }
        (ArchiveKind::Artifact, ArchiveMetric::AttemptCount(AttemptCountBucket::One)) => {
            "artifact_download_remote_attempt_count_1"
        }
        (ArchiveKind::Artifact, ArchiveMetric::AttemptCount(AttemptCountBucket::Two)) => {
            "artifact_download_remote_attempt_count_2"
        }
        (ArchiveKind::Artifact, ArchiveMetric::AttemptCount(AttemptCountBucket::Three)) => {
            "artifact_download_remote_attempt_count_3"
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AttemptCountBucket {
    One,
    Two,
    Three,
}

impl AttemptCountBucket {
    fn from_attempts(attempts: u32) -> Self {
        match attempts {
            1 => Self::One,
            2 => Self::Two,
            _ => Self::Three,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const COUNT_METRICS: [CountMetric; 9] = [
        CountMetric::Task,
        CountMetric::RemoteUrl,
        CountMetric::FileUrl,
        CountMetric::SkillChildTask,
        CountMetric::PotentialParentChildOverlap,
        CountMetric::MountConflictDeferral,
        CountMetric::InstructionsSkillConflictDeferral,
        CountMetric::ExactPathConflictDeferral,
        CountMetric::OtherParentChildConflictDeferral,
    ];

    const ARCHIVE_KINDS: [ArchiveKind; 2] = [ArchiveKind::Storage, ArchiveKind::Artifact];

    fn metadata(task_kind: TaskKind) -> TaskMetadata {
        TaskMetadata {
            archive_kind: ArchiveKind::Storage,
            source_kind: SourceKind::File,
            task_kind,
        }
    }

    fn snapshot(path: &str, task_kind: TaskKind) -> TaskSnapshot {
        TaskSnapshot::new(metadata(task_kind), PathBuf::from(path))
    }

    fn assert_count_actions(metric: CountMetric, expected: [&'static str; 7]) {
        assert_eq!(
            [0, 1, 2, 3, 5, 9, 17].map(|count| metric.action(count)),
            expected
        );
    }

    #[test]
    fn task_metadata_classifies_sources_and_framework_paths() {
        assert_eq!(
            TaskMetadata::storage(
                "https://example.com/archive.tar.gz",
                Path::new("/staged/instructions"),
                Some("AGENTS.md"),
            ),
            TaskMetadata {
                archive_kind: ArchiveKind::Storage,
                source_kind: SourceKind::Remote,
                task_kind: TaskKind::FrameworkHomeInstructions,
            }
        );
        assert_eq!(
            TaskMetadata::artifact(
                "file:///tmp/archive.tar.gz",
                Path::new("/home/user/.codex/skills/workflow"),
            ),
            TaskMetadata {
                archive_kind: ArchiveKind::Artifact,
                source_kind: SourceKind::File,
                task_kind: TaskKind::FrameworkSkillChild,
            }
        );
        assert_eq!(
            TaskMetadata::artifact(
                "other://archive.tar.gz",
                Path::new("/home/user/.claude/skills"),
            ),
            TaskMetadata {
                archive_kind: ArchiveKind::Artifact,
                source_kind: SourceKind::Other,
                task_kind: TaskKind::Other,
            }
        );
        assert_eq!(
            TaskMetadata::artifact(
                "https://example.com/archive.tar.gz",
                Path::new("/home/user/.claude/skills-old/tool"),
            )
            .task_kind,
            TaskKind::Other
        );
    }

    #[test]
    fn conflict_classification_uses_task_kinds_only_after_path_conflict() {
        assert_eq!(
            classify_conflict(
                Path::new("/home/user/.codex/skills/foo"),
                TaskKind::FrameworkSkillChild,
                Path::new("/home/user/.codex"),
                TaskKind::FrameworkHomeInstructions,
            ),
            ConflictKind::InstructionsSkill
        );
        assert_eq!(
            classify_conflict(
                Path::new("/same"),
                TaskKind::Other,
                Path::new("/same"),
                TaskKind::Other,
            ),
            ConflictKind::ExactPath
        );
        assert_eq!(
            classify_conflict(
                Path::new("/tmp/parent/child"),
                TaskKind::Other,
                Path::new("/tmp/parent"),
                TaskKind::Other,
            ),
            ConflictKind::OtherParentChild
        );
    }

    #[test]
    fn potential_parent_child_overlap_excludes_exact_paths_and_siblings() {
        let tasks = [
            snapshot("/workspace", TaskKind::Other),
            snapshot("/workspace/src", TaskKind::Other),
            snapshot("/workspace/tests", TaskKind::Other),
            snapshot("/workspace/src", TaskKind::Other),
            snapshot("/workspace/src/nested", TaskKind::Other),
        ];

        assert_eq!(potential_parent_child_overlap_count(&tasks), 6);
    }

    #[test]
    fn batch_recorder_counts_each_observed_conflict() {
        let mut recorder = BatchRecorder::new([
            snapshot("/home/user/.codex", TaskKind::FrameworkHomeInstructions),
            snapshot(
                "/home/user/.codex/skills/workflow",
                TaskKind::FrameworkSkillChild,
            ),
        ]);

        recorder.record_conflict(
            1,
            Path::new("/home/user/.codex/skills/workflow"),
            0,
            Path::new("/home/user/.codex"),
        );
        recorder.record_conflict(
            1,
            Path::new("/home/user/.codex/skills/workflow"),
            0,
            Path::new("/home/user/.codex"),
        );

        assert_eq!(
            recorder.conflict_deferrals,
            ConflictDeferralStats {
                total: 2,
                instructions_skill: 2,
                exact_path: 0,
                other_parent_child: 0,
            }
        );
    }

    #[test]
    fn count_bucket_boundaries_are_stable() {
        assert_eq!(
            [0, 1, 2, 3, 4, 5, 8, 9, 16, 17].map(CountBucket::from_count),
            [
                CountBucket::Zero,
                CountBucket::One,
                CountBucket::Two,
                CountBucket::ThreeToFour,
                CountBucket::ThreeToFour,
                CountBucket::FiveToEight,
                CountBucket::FiveToEight,
                CountBucket::NineToSixteen,
                CountBucket::NineToSixteen,
                CountBucket::SeventeenPlus,
            ]
        );
    }

    #[test]
    fn count_metric_actions_are_stable() {
        assert_count_actions(
            CountMetric::Task,
            [
                "guest_download_task_count_0",
                "guest_download_task_count_1",
                "guest_download_task_count_2",
                "guest_download_task_count_3_4",
                "guest_download_task_count_5_8",
                "guest_download_task_count_9_16",
                "guest_download_task_count_17_plus",
            ],
        );
        assert_count_actions(
            CountMetric::RemoteUrl,
            [
                "guest_download_remote_url_count_0",
                "guest_download_remote_url_count_1",
                "guest_download_remote_url_count_2",
                "guest_download_remote_url_count_3_4",
                "guest_download_remote_url_count_5_8",
                "guest_download_remote_url_count_9_16",
                "guest_download_remote_url_count_17_plus",
            ],
        );
        assert_count_actions(
            CountMetric::FileUrl,
            [
                "guest_download_file_url_count_0",
                "guest_download_file_url_count_1",
                "guest_download_file_url_count_2",
                "guest_download_file_url_count_3_4",
                "guest_download_file_url_count_5_8",
                "guest_download_file_url_count_9_16",
                "guest_download_file_url_count_17_plus",
            ],
        );
        assert_count_actions(
            CountMetric::SkillChildTask,
            [
                "guest_download_skill_child_task_count_0",
                "guest_download_skill_child_task_count_1",
                "guest_download_skill_child_task_count_2",
                "guest_download_skill_child_task_count_3_4",
                "guest_download_skill_child_task_count_5_8",
                "guest_download_skill_child_task_count_9_16",
                "guest_download_skill_child_task_count_17_plus",
            ],
        );
        assert_count_actions(
            CountMetric::PotentialParentChildOverlap,
            [
                "guest_download_potential_parent_child_overlap_count_0",
                "guest_download_potential_parent_child_overlap_count_1",
                "guest_download_potential_parent_child_overlap_count_2",
                "guest_download_potential_parent_child_overlap_count_3_4",
                "guest_download_potential_parent_child_overlap_count_5_8",
                "guest_download_potential_parent_child_overlap_count_9_16",
                "guest_download_potential_parent_child_overlap_count_17_plus",
            ],
        );
        assert_count_actions(
            CountMetric::MountConflictDeferral,
            [
                "guest_download_mount_conflict_deferral_count_0",
                "guest_download_mount_conflict_deferral_count_1",
                "guest_download_mount_conflict_deferral_count_2",
                "guest_download_mount_conflict_deferral_count_3_4",
                "guest_download_mount_conflict_deferral_count_5_8",
                "guest_download_mount_conflict_deferral_count_9_16",
                "guest_download_mount_conflict_deferral_count_17_plus",
            ],
        );
        assert_count_actions(
            CountMetric::InstructionsSkillConflictDeferral,
            [
                "guest_download_instructions_skill_conflict_deferral_count_0",
                "guest_download_instructions_skill_conflict_deferral_count_1",
                "guest_download_instructions_skill_conflict_deferral_count_2",
                "guest_download_instructions_skill_conflict_deferral_count_3_4",
                "guest_download_instructions_skill_conflict_deferral_count_5_8",
                "guest_download_instructions_skill_conflict_deferral_count_9_16",
                "guest_download_instructions_skill_conflict_deferral_count_17_plus",
            ],
        );
        assert_count_actions(
            CountMetric::ExactPathConflictDeferral,
            [
                "guest_download_exact_path_conflict_deferral_count_0",
                "guest_download_exact_path_conflict_deferral_count_1",
                "guest_download_exact_path_conflict_deferral_count_2",
                "guest_download_exact_path_conflict_deferral_count_3_4",
                "guest_download_exact_path_conflict_deferral_count_5_8",
                "guest_download_exact_path_conflict_deferral_count_9_16",
                "guest_download_exact_path_conflict_deferral_count_17_plus",
            ],
        );
        assert_count_actions(
            CountMetric::OtherParentChildConflictDeferral,
            [
                "guest_download_other_parent_child_conflict_deferral_count_0",
                "guest_download_other_parent_child_conflict_deferral_count_1",
                "guest_download_other_parent_child_conflict_deferral_count_2",
                "guest_download_other_parent_child_conflict_deferral_count_3_4",
                "guest_download_other_parent_child_conflict_deferral_count_5_8",
                "guest_download_other_parent_child_conflict_deferral_count_9_16",
                "guest_download_other_parent_child_conflict_deferral_count_17_plus",
            ],
        );
    }

    #[test]
    fn presence_and_archive_phase_actions_are_stable() {
        assert_eq!(
            framework_home_instructions_action(false),
            "guest_download_framework_home_instructions_task_absent"
        );
        assert_eq!(
            framework_home_instructions_action(true),
            "guest_download_framework_home_instructions_task_present"
        );
        assert_eq!(
            archive_action(ArchiveKind::Storage, ArchiveMetric::Total),
            "storage_download"
        );
        assert_eq!(
            archive_action(ArchiveKind::Artifact, ArchiveMetric::Total),
            "artifact_download"
        );
        assert_eq!(
            archive_action(
                ArchiveKind::Storage,
                ArchiveMetric::RequestToResponseHeaders
            ),
            "storage_download_remote_request_to_response_headers"
        );
        assert_eq!(
            archive_action(
                ArchiveKind::Artifact,
                ArchiveMetric::RequestToResponseHeaders
            ),
            "artifact_download_remote_request_to_response_headers"
        );
        assert_eq!(
            archive_action(ArchiveKind::Storage, ArchiveMetric::BodyRead),
            "storage_download_remote_body_read"
        );
        assert_eq!(
            archive_action(ArchiveKind::Artifact, ArchiveMetric::BodyRead),
            "artifact_download_remote_body_read"
        );
        assert_eq!(
            archive_action(ArchiveKind::Storage, ArchiveMetric::ExtractOutsideBodyRead),
            "storage_download_remote_extract_outside_body_read"
        );
        assert_eq!(
            archive_action(ArchiveKind::Artifact, ArchiveMetric::ExtractOutsideBodyRead),
            "artifact_download_remote_extract_outside_body_read"
        );
    }

    #[test]
    fn compressed_byte_bucket_boundaries_are_stable() {
        assert_eq!(
            [
                0, 1, 65_535, 65_536, 262_143, 262_144, 1_048_575, 1_048_576, 4_194_303, 4_194_304,
                16_777_215, 16_777_216, 67_108_863, 67_108_864,
            ]
            .map(CompressedBytesBucket::from_bytes),
            [
                CompressedBytesBucket::Zero,
                CompressedBytesBucket::Under64Kib,
                CompressedBytesBucket::Under64Kib,
                CompressedBytesBucket::Kib64To256,
                CompressedBytesBucket::Kib64To256,
                CompressedBytesBucket::Kib256To1Mib,
                CompressedBytesBucket::Kib256To1Mib,
                CompressedBytesBucket::Mib1To4,
                CompressedBytesBucket::Mib1To4,
                CompressedBytesBucket::Mib4To16,
                CompressedBytesBucket::Mib4To16,
                CompressedBytesBucket::Mib16To64,
                CompressedBytesBucket::Mib16To64,
                CompressedBytesBucket::Mib64Plus,
            ]
        );
    }

    #[test]
    fn compressed_byte_actions_are_stable() {
        let buckets = [
            CompressedBytesBucket::Zero,
            CompressedBytesBucket::Under64Kib,
            CompressedBytesBucket::Kib64To256,
            CompressedBytesBucket::Kib256To1Mib,
            CompressedBytesBucket::Mib1To4,
            CompressedBytesBucket::Mib4To16,
            CompressedBytesBucket::Mib16To64,
            CompressedBytesBucket::Mib64Plus,
        ];
        assert_eq!(
            buckets.map(|bucket| archive_action(
                ArchiveKind::Storage,
                ArchiveMetric::CompressedBytes(bucket)
            )),
            [
                "storage_download_remote_compressed_bytes_consumed_zero",
                "storage_download_remote_compressed_bytes_consumed_lt_64_kib",
                "storage_download_remote_compressed_bytes_consumed_64_kib_to_256_kib",
                "storage_download_remote_compressed_bytes_consumed_256_kib_to_1_mib",
                "storage_download_remote_compressed_bytes_consumed_1_mib_to_4_mib",
                "storage_download_remote_compressed_bytes_consumed_4_mib_to_16_mib",
                "storage_download_remote_compressed_bytes_consumed_16_mib_to_64_mib",
                "storage_download_remote_compressed_bytes_consumed_64_mib_plus",
            ]
        );
        assert_eq!(
            buckets.map(|bucket| archive_action(
                ArchiveKind::Artifact,
                ArchiveMetric::CompressedBytes(bucket)
            )),
            [
                "artifact_download_remote_compressed_bytes_consumed_zero",
                "artifact_download_remote_compressed_bytes_consumed_lt_64_kib",
                "artifact_download_remote_compressed_bytes_consumed_64_kib_to_256_kib",
                "artifact_download_remote_compressed_bytes_consumed_256_kib_to_1_mib",
                "artifact_download_remote_compressed_bytes_consumed_1_mib_to_4_mib",
                "artifact_download_remote_compressed_bytes_consumed_4_mib_to_16_mib",
                "artifact_download_remote_compressed_bytes_consumed_16_mib_to_64_mib",
                "artifact_download_remote_compressed_bytes_consumed_64_mib_plus",
            ]
        );
    }

    #[test]
    fn attempt_actions_are_stable() {
        assert_eq!(
            [0, 1, 2, 3, 4].map(AttemptCountBucket::from_attempts),
            [
                AttemptCountBucket::Three,
                AttemptCountBucket::One,
                AttemptCountBucket::Two,
                AttemptCountBucket::Three,
                AttemptCountBucket::Three,
            ]
        );
        let buckets = [
            AttemptCountBucket::One,
            AttemptCountBucket::Two,
            AttemptCountBucket::Three,
        ];
        assert_eq!(
            buckets.map(|bucket| archive_action(
                ArchiveKind::Storage,
                ArchiveMetric::AttemptCount(bucket)
            )),
            [
                "storage_download_remote_attempt_count_1",
                "storage_download_remote_attempt_count_2",
                "storage_download_remote_attempt_count_3",
            ]
        );
        assert_eq!(
            buckets.map(|bucket| archive_action(
                ArchiveKind::Artifact,
                ArchiveMetric::AttemptCount(bucket)
            )),
            [
                "artifact_download_remote_attempt_count_1",
                "artifact_download_remote_attempt_count_2",
                "artifact_download_remote_attempt_count_3",
            ]
        );
    }

    #[test]
    fn complete_action_schema_contains_95_unique_strings() {
        let mut actions = HashSet::new();
        for metric in COUNT_METRICS {
            actions.extend(metric.actions());
        }
        actions.insert(framework_home_instructions_action(false));
        actions.insert(framework_home_instructions_action(true));
        for kind in ARCHIVE_KINDS {
            actions.insert(archive_action(kind, ArchiveMetric::Total));
            actions.insert(archive_action(
                kind,
                ArchiveMetric::RequestToResponseHeaders,
            ));
            actions.insert(archive_action(kind, ArchiveMetric::BodyRead));
            actions.insert(archive_action(kind, ArchiveMetric::ExtractOutsideBodyRead));
            for bucket in [
                CompressedBytesBucket::Zero,
                CompressedBytesBucket::Under64Kib,
                CompressedBytesBucket::Kib64To256,
                CompressedBytesBucket::Kib256To1Mib,
                CompressedBytesBucket::Mib1To4,
                CompressedBytesBucket::Mib4To16,
                CompressedBytesBucket::Mib16To64,
                CompressedBytesBucket::Mib64Plus,
            ] {
                actions.insert(archive_action(kind, ArchiveMetric::CompressedBytes(bucket)));
            }
            for bucket in [
                AttemptCountBucket::One,
                AttemptCountBucket::Two,
                AttemptCountBucket::Three,
            ] {
                actions.insert(archive_action(kind, ArchiveMetric::AttemptCount(bucket)));
            }
        }

        assert_eq!(actions.len(), 95);
    }
}
