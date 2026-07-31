use crate::source;
use guest_common::telemetry::record_sandbox_op;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DownloadTaskTelemetry {
    archive_kind: ArchiveKind,
    task_kind: DownloadTaskKind,
    url_kind: DownloadUrlKind,
}

impl DownloadTaskTelemetry {
    pub(crate) fn storage(url: &str, mount_path: &Path, has_instructions_target: bool) -> Self {
        Self {
            archive_kind: ArchiveKind::Storage,
            task_kind: classify_download_task_kind(mount_path, has_instructions_target),
            url_kind: DownloadUrlKind::from_url(url),
        }
    }

    pub(crate) fn artifact(url: &str, mount_path: &Path) -> Self {
        Self {
            archive_kind: ArchiveKind::Artifact,
            task_kind: classify_download_task_kind(mount_path, false),
            url_kind: DownloadUrlKind::from_url(url),
        }
    }

    pub(crate) fn remote_metrics(self) -> Option<RemoteArchiveTaskMetrics> {
        matches!(self.url_kind, DownloadUrlKind::Remote).then(RemoteArchiveTaskMetrics::default)
    }

    pub(crate) fn record_result(
        self,
        duration: Duration,
        success: bool,
        error: Option<&str>,
        remote_metrics: Option<&RemoteArchiveTaskMetrics>,
    ) {
        record_sandbox_op(self.archive_kind.total_action(), duration, success, error);
        if let Some(metrics) = remote_metrics {
            record_remote_archive_attribution(self.archive_kind, metrics, success);
        }
    }
}

pub(crate) struct DownloadRunTelemetry {
    task_kinds: Vec<DownloadTaskKind>,
    conflict_deferrals: DownloadConflictDeferralStats,
}

impl DownloadRunTelemetry {
    pub(crate) fn start<'a>(
        tasks: impl IntoIterator<Item = (DownloadTaskTelemetry, &'a Path)>,
    ) -> Self {
        let mut task_count = 0;
        let mut remote_url_count = 0;
        let mut file_url_count = 0;
        let mut skill_child_task_count = 0;
        let mut framework_home_instructions_task_present = false;
        let mut mount_paths = Vec::new();
        let mut task_kinds = Vec::new();

        for (task, mount_path) in tasks {
            task_count += 1;
            match task.url_kind {
                DownloadUrlKind::Remote => remote_url_count += 1,
                DownloadUrlKind::File => file_url_count += 1,
                DownloadUrlKind::Other => {}
            }
            match task.task_kind {
                DownloadTaskKind::FrameworkHomeInstructions => {
                    framework_home_instructions_task_present = true;
                }
                DownloadTaskKind::FrameworkSkillChild => skill_child_task_count += 1,
                DownloadTaskKind::Other => {}
            }
            mount_paths.push(mount_path);
            task_kinds.push(task.task_kind);
        }

        record_count_metric(CountMetric::Task, task_count);
        record_count_metric(CountMetric::RemoteUrl, remote_url_count);
        record_count_metric(CountMetric::FileUrl, file_url_count);
        record_count_metric(CountMetric::SkillChildTask, skill_child_task_count);
        record_sandbox_op(
            framework_home_instructions_task_action(framework_home_instructions_task_present),
            Duration::ZERO,
            true,
            None,
        );
        record_count_metric(
            CountMetric::PotentialParentChildOverlap,
            potential_parent_child_overlap_count(&mount_paths),
        );

        Self {
            task_kinds,
            conflict_deferrals: DownloadConflictDeferralStats::default(),
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
        self.conflict_deferrals.record(classify_download_conflict(
            pending_path,
            pending_kind,
            active_path,
            active_kind,
        ));
    }

    pub(crate) fn finish(self) {
        record_count_metric(
            CountMetric::MountConflictDeferral,
            self.conflict_deferrals.total,
        );
        record_count_metric(
            CountMetric::InstructionsSkillConflictDeferral,
            self.conflict_deferrals.instructions_skill,
        );
        record_count_metric(
            CountMetric::ExactPathConflictDeferral,
            self.conflict_deferrals.exact_path,
        );
        record_count_metric(
            CountMetric::OtherParentChildConflictDeferral,
            self.conflict_deferrals.other_parent_child,
        );
    }
}

#[derive(Default)]
pub(crate) struct RemoteArchiveTaskMetrics {
    request_to_response_headers: Duration,
    body_read: Duration,
    extract_outside_body_read: Duration,
    compressed_bytes_consumed: u64,
    attempts: u32,
}

impl RemoteArchiveTaskMetrics {
    pub(crate) fn begin_attempt(&mut self) {
        self.attempts = self.attempts.saturating_add(1);
    }

    pub(crate) fn record_attempt(
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
enum ArchiveKind {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DownloadTaskKind {
    FrameworkHomeInstructions,
    FrameworkSkillChild,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DownloadUrlKind {
    Remote,
    File,
    Other,
}

impl DownloadUrlKind {
    fn from_url(url: &str) -> Self {
        if url.starts_with("http://") || url.starts_with("https://") {
            Self::Remote
        } else if url.starts_with("file://") {
            Self::File
        } else {
            Self::Other
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DownloadConflictKind {
    InstructionsSkill,
    ExactPath,
    OtherParentChild,
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

#[derive(Clone, Copy)]
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
    fn actions(self) -> CountMetricActions {
        match self {
            Self::Task => CountMetricActions {
                zero: "guest_download_task_count_0",
                one: "guest_download_task_count_1",
                two: "guest_download_task_count_2",
                three_to_four: "guest_download_task_count_3_4",
                five_to_eight: "guest_download_task_count_5_8",
                nine_to_sixteen: "guest_download_task_count_9_16",
                seventeen_plus: "guest_download_task_count_17_plus",
            },
            Self::RemoteUrl => CountMetricActions {
                zero: "guest_download_remote_url_count_0",
                one: "guest_download_remote_url_count_1",
                two: "guest_download_remote_url_count_2",
                three_to_four: "guest_download_remote_url_count_3_4",
                five_to_eight: "guest_download_remote_url_count_5_8",
                nine_to_sixteen: "guest_download_remote_url_count_9_16",
                seventeen_plus: "guest_download_remote_url_count_17_plus",
            },
            Self::FileUrl => CountMetricActions {
                zero: "guest_download_file_url_count_0",
                one: "guest_download_file_url_count_1",
                two: "guest_download_file_url_count_2",
                three_to_four: "guest_download_file_url_count_3_4",
                five_to_eight: "guest_download_file_url_count_5_8",
                nine_to_sixteen: "guest_download_file_url_count_9_16",
                seventeen_plus: "guest_download_file_url_count_17_plus",
            },
            Self::SkillChildTask => CountMetricActions {
                zero: "guest_download_skill_child_task_count_0",
                one: "guest_download_skill_child_task_count_1",
                two: "guest_download_skill_child_task_count_2",
                three_to_four: "guest_download_skill_child_task_count_3_4",
                five_to_eight: "guest_download_skill_child_task_count_5_8",
                nine_to_sixteen: "guest_download_skill_child_task_count_9_16",
                seventeen_plus: "guest_download_skill_child_task_count_17_plus",
            },
            Self::PotentialParentChildOverlap => CountMetricActions {
                zero: "guest_download_potential_parent_child_overlap_count_0",
                one: "guest_download_potential_parent_child_overlap_count_1",
                two: "guest_download_potential_parent_child_overlap_count_2",
                three_to_four: "guest_download_potential_parent_child_overlap_count_3_4",
                five_to_eight: "guest_download_potential_parent_child_overlap_count_5_8",
                nine_to_sixteen: "guest_download_potential_parent_child_overlap_count_9_16",
                seventeen_plus: "guest_download_potential_parent_child_overlap_count_17_plus",
            },
            Self::MountConflictDeferral => CountMetricActions {
                zero: "guest_download_mount_conflict_deferral_count_0",
                one: "guest_download_mount_conflict_deferral_count_1",
                two: "guest_download_mount_conflict_deferral_count_2",
                three_to_four: "guest_download_mount_conflict_deferral_count_3_4",
                five_to_eight: "guest_download_mount_conflict_deferral_count_5_8",
                nine_to_sixteen: "guest_download_mount_conflict_deferral_count_9_16",
                seventeen_plus: "guest_download_mount_conflict_deferral_count_17_plus",
            },
            Self::InstructionsSkillConflictDeferral => CountMetricActions {
                zero: "guest_download_instructions_skill_conflict_deferral_count_0",
                one: "guest_download_instructions_skill_conflict_deferral_count_1",
                two: "guest_download_instructions_skill_conflict_deferral_count_2",
                three_to_four: "guest_download_instructions_skill_conflict_deferral_count_3_4",
                five_to_eight: "guest_download_instructions_skill_conflict_deferral_count_5_8",
                nine_to_sixteen: "guest_download_instructions_skill_conflict_deferral_count_9_16",
                seventeen_plus: "guest_download_instructions_skill_conflict_deferral_count_17_plus",
            },
            Self::ExactPathConflictDeferral => CountMetricActions {
                zero: "guest_download_exact_path_conflict_deferral_count_0",
                one: "guest_download_exact_path_conflict_deferral_count_1",
                two: "guest_download_exact_path_conflict_deferral_count_2",
                three_to_four: "guest_download_exact_path_conflict_deferral_count_3_4",
                five_to_eight: "guest_download_exact_path_conflict_deferral_count_5_8",
                nine_to_sixteen: "guest_download_exact_path_conflict_deferral_count_9_16",
                seventeen_plus: "guest_download_exact_path_conflict_deferral_count_17_plus",
            },
            Self::OtherParentChildConflictDeferral => CountMetricActions {
                zero: "guest_download_other_parent_child_conflict_deferral_count_0",
                one: "guest_download_other_parent_child_conflict_deferral_count_1",
                two: "guest_download_other_parent_child_conflict_deferral_count_2",
                three_to_four: "guest_download_other_parent_child_conflict_deferral_count_3_4",
                five_to_eight: "guest_download_other_parent_child_conflict_deferral_count_5_8",
                nine_to_sixteen: "guest_download_other_parent_child_conflict_deferral_count_9_16",
                seventeen_plus: "guest_download_other_parent_child_conflict_deferral_count_17_plus",
            },
        }
    }
}

#[derive(Clone, Copy)]
struct CountMetricActions {
    zero: &'static str,
    one: &'static str,
    two: &'static str,
    three_to_four: &'static str,
    five_to_eight: &'static str,
    nine_to_sixteen: &'static str,
    seventeen_plus: &'static str,
}

impl CountMetricActions {
    fn action(self, count: usize) -> &'static str {
        match count {
            0 => self.zero,
            1 => self.one,
            2 => self.two,
            3 | 4 => self.three_to_four,
            5..=8 => self.five_to_eight,
            9..=16 => self.nine_to_sixteen,
            _ => self.seventeen_plus,
        }
    }
}

fn record_count_metric(metric: CountMetric, count: usize) {
    record_sandbox_op(metric.actions().action(count), Duration::ZERO, true, None);
}

fn framework_home_instructions_task_action(present: bool) -> &'static str {
    if present {
        "guest_download_framework_home_instructions_task_present"
    } else {
        "guest_download_framework_home_instructions_task_absent"
    }
}

fn classify_download_task_kind(
    mount_path: &Path,
    has_instructions_target: bool,
) -> DownloadTaskKind {
    if has_instructions_target {
        return DownloadTaskKind::FrameworkHomeInstructions;
    }

    if is_framework_skill_child_path(mount_path) {
        return DownloadTaskKind::FrameworkSkillChild;
    }

    DownloadTaskKind::Other
}

fn classify_download_conflict(
    left_path: &Path,
    left_kind: DownloadTaskKind,
    right_path: &Path,
    right_kind: DownloadTaskKind,
) -> DownloadConflictKind {
    if left_path == right_path {
        return DownloadConflictKind::ExactPath;
    }
    if task_kinds_are_instructions_and_skill(left_kind, right_kind) {
        return DownloadConflictKind::InstructionsSkill;
    }
    DownloadConflictKind::OtherParentChild
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

fn potential_parent_child_overlap_count(normalized_paths: &[&Path]) -> usize {
    let mut path_counts = HashMap::new();
    for &path in normalized_paths {
        *path_counts.entry(path).or_insert(0usize) += 1;
    }

    let mut count = 0;
    for &path in normalized_paths {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;

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
    const COUNT_REPRESENTATIVES: [usize; 7] = [0, 1, 2, 3, 5, 9, 17];
    const COMPRESSED_BYTE_REPRESENTATIVES: [u64; 8] = [
        0, 1, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864,
    ];
    const EXPECTED_ACTION_SCHEMA: [&str; 95] = [
        "guest_download_task_count_0",
        "guest_download_task_count_1",
        "guest_download_task_count_2",
        "guest_download_task_count_3_4",
        "guest_download_task_count_5_8",
        "guest_download_task_count_9_16",
        "guest_download_task_count_17_plus",
        "guest_download_remote_url_count_0",
        "guest_download_remote_url_count_1",
        "guest_download_remote_url_count_2",
        "guest_download_remote_url_count_3_4",
        "guest_download_remote_url_count_5_8",
        "guest_download_remote_url_count_9_16",
        "guest_download_remote_url_count_17_plus",
        "guest_download_file_url_count_0",
        "guest_download_file_url_count_1",
        "guest_download_file_url_count_2",
        "guest_download_file_url_count_3_4",
        "guest_download_file_url_count_5_8",
        "guest_download_file_url_count_9_16",
        "guest_download_file_url_count_17_plus",
        "guest_download_skill_child_task_count_0",
        "guest_download_skill_child_task_count_1",
        "guest_download_skill_child_task_count_2",
        "guest_download_skill_child_task_count_3_4",
        "guest_download_skill_child_task_count_5_8",
        "guest_download_skill_child_task_count_9_16",
        "guest_download_skill_child_task_count_17_plus",
        "guest_download_potential_parent_child_overlap_count_0",
        "guest_download_potential_parent_child_overlap_count_1",
        "guest_download_potential_parent_child_overlap_count_2",
        "guest_download_potential_parent_child_overlap_count_3_4",
        "guest_download_potential_parent_child_overlap_count_5_8",
        "guest_download_potential_parent_child_overlap_count_9_16",
        "guest_download_potential_parent_child_overlap_count_17_plus",
        "guest_download_mount_conflict_deferral_count_0",
        "guest_download_mount_conflict_deferral_count_1",
        "guest_download_mount_conflict_deferral_count_2",
        "guest_download_mount_conflict_deferral_count_3_4",
        "guest_download_mount_conflict_deferral_count_5_8",
        "guest_download_mount_conflict_deferral_count_9_16",
        "guest_download_mount_conflict_deferral_count_17_plus",
        "guest_download_instructions_skill_conflict_deferral_count_0",
        "guest_download_instructions_skill_conflict_deferral_count_1",
        "guest_download_instructions_skill_conflict_deferral_count_2",
        "guest_download_instructions_skill_conflict_deferral_count_3_4",
        "guest_download_instructions_skill_conflict_deferral_count_5_8",
        "guest_download_instructions_skill_conflict_deferral_count_9_16",
        "guest_download_instructions_skill_conflict_deferral_count_17_plus",
        "guest_download_exact_path_conflict_deferral_count_0",
        "guest_download_exact_path_conflict_deferral_count_1",
        "guest_download_exact_path_conflict_deferral_count_2",
        "guest_download_exact_path_conflict_deferral_count_3_4",
        "guest_download_exact_path_conflict_deferral_count_5_8",
        "guest_download_exact_path_conflict_deferral_count_9_16",
        "guest_download_exact_path_conflict_deferral_count_17_plus",
        "guest_download_other_parent_child_conflict_deferral_count_0",
        "guest_download_other_parent_child_conflict_deferral_count_1",
        "guest_download_other_parent_child_conflict_deferral_count_2",
        "guest_download_other_parent_child_conflict_deferral_count_3_4",
        "guest_download_other_parent_child_conflict_deferral_count_5_8",
        "guest_download_other_parent_child_conflict_deferral_count_9_16",
        "guest_download_other_parent_child_conflict_deferral_count_17_plus",
        "guest_download_framework_home_instructions_task_absent",
        "guest_download_framework_home_instructions_task_present",
        "storage_download",
        "storage_download_remote_request_to_response_headers",
        "storage_download_remote_body_read",
        "storage_download_remote_extract_outside_body_read",
        "storage_download_remote_compressed_bytes_consumed_zero",
        "storage_download_remote_compressed_bytes_consumed_lt_64_kib",
        "storage_download_remote_compressed_bytes_consumed_64_kib_to_256_kib",
        "storage_download_remote_compressed_bytes_consumed_256_kib_to_1_mib",
        "storage_download_remote_compressed_bytes_consumed_1_mib_to_4_mib",
        "storage_download_remote_compressed_bytes_consumed_4_mib_to_16_mib",
        "storage_download_remote_compressed_bytes_consumed_16_mib_to_64_mib",
        "storage_download_remote_compressed_bytes_consumed_64_mib_plus",
        "storage_download_remote_attempt_count_1",
        "storage_download_remote_attempt_count_2",
        "storage_download_remote_attempt_count_3",
        "artifact_download",
        "artifact_download_remote_request_to_response_headers",
        "artifact_download_remote_body_read",
        "artifact_download_remote_extract_outside_body_read",
        "artifact_download_remote_compressed_bytes_consumed_zero",
        "artifact_download_remote_compressed_bytes_consumed_lt_64_kib",
        "artifact_download_remote_compressed_bytes_consumed_64_kib_to_256_kib",
        "artifact_download_remote_compressed_bytes_consumed_256_kib_to_1_mib",
        "artifact_download_remote_compressed_bytes_consumed_1_mib_to_4_mib",
        "artifact_download_remote_compressed_bytes_consumed_4_mib_to_16_mib",
        "artifact_download_remote_compressed_bytes_consumed_16_mib_to_64_mib",
        "artifact_download_remote_compressed_bytes_consumed_64_mib_plus",
        "artifact_download_remote_attempt_count_1",
        "artifact_download_remote_attempt_count_2",
        "artifact_download_remote_attempt_count_3",
    ];

    fn action_schema() -> Vec<&'static str> {
        let mut actions = Vec::new();
        for metric in COUNT_METRICS {
            actions.extend(COUNT_REPRESENTATIVES.map(|count| metric.actions().action(count)));
        }
        actions.extend([
            framework_home_instructions_task_action(false),
            framework_home_instructions_task_action(true),
        ]);
        for archive_kind in [ArchiveKind::Storage, ArchiveKind::Artifact] {
            actions.extend([
                archive_kind.total_action(),
                archive_kind.request_to_response_headers_action(),
                archive_kind.body_read_action(),
                archive_kind.extract_outside_body_read_action(),
            ]);
            actions.extend(
                COMPRESSED_BYTE_REPRESENTATIVES
                    .map(|bytes| archive_kind.compressed_bytes_consumed_action(bytes)),
            );
            actions.extend([1, 2, 3].map(|attempts| archive_kind.attempt_count_action(attempts)));
        }
        actions
    }

    #[test]
    fn task_kind_classification_identifies_instructions_and_skill_children() {
        assert_eq!(
            DownloadTaskTelemetry::storage(
                "https://example.com/archive.tar.gz",
                Path::new("/home/user/.codex"),
                true,
            )
            .task_kind,
            DownloadTaskKind::FrameworkHomeInstructions
        );
        assert_eq!(
            DownloadTaskTelemetry::storage(
                "https://example.com/archive.tar.gz",
                Path::new("/home/user/.codex/skills/workflow"),
                false,
            )
            .task_kind,
            DownloadTaskKind::FrameworkSkillChild
        );
        assert_eq!(
            DownloadTaskTelemetry::storage(
                "https://example.com/archive.tar.gz",
                Path::new("/home/user/.claude/skills/tool"),
                false,
            )
            .task_kind,
            DownloadTaskKind::FrameworkSkillChild
        );
        assert_eq!(
            DownloadTaskTelemetry::storage(
                "https://example.com/archive.tar.gz",
                Path::new("/home/user/.codex/skills"),
                false,
            )
            .task_kind,
            DownloadTaskKind::Other
        );
        assert_eq!(
            DownloadTaskTelemetry::storage(
                "https://example.com/archive.tar.gz",
                Path::new("/workspace"),
                false,
            )
            .task_kind,
            DownloadTaskKind::Other
        );
    }

    #[test]
    fn conflict_classifier_buckets_exact_instruction_skill_and_other_parent_child() {
        assert_eq!(
            classify_download_conflict(
                Path::new("/home/user/.codex/skills/foo"),
                DownloadTaskKind::FrameworkSkillChild,
                Path::new("/home/user/.codex"),
                DownloadTaskKind::FrameworkHomeInstructions,
            ),
            DownloadConflictKind::InstructionsSkill
        );
        assert_eq!(
            classify_download_conflict(
                Path::new("/same"),
                DownloadTaskKind::Other,
                Path::new("/same"),
                DownloadTaskKind::Other,
            ),
            DownloadConflictKind::ExactPath
        );
        assert_eq!(
            classify_download_conflict(
                Path::new("/tmp/parent/child"),
                DownloadTaskKind::Other,
                Path::new("/tmp/parent"),
                DownloadTaskKind::Other,
            ),
            DownloadConflictKind::OtherParentChild
        );
    }

    #[test]
    fn potential_parent_child_overlap_count_excludes_exact_paths_and_siblings() {
        let paths = [
            PathBuf::from("/workspace"),
            PathBuf::from("/workspace/src"),
            PathBuf::from("/workspace/tests"),
            PathBuf::from("/workspace/src"),
            PathBuf::from("/workspace/src/nested"),
        ];

        assert_eq!(
            potential_parent_child_overlap_count(
                &paths.iter().map(PathBuf::as_path).collect::<Vec<_>>()
            ),
            6
        );
    }

    #[test]
    fn count_bucket_boundaries_are_stable() {
        assert_eq!(
            [0, 1, 2, 3, 4, 5, 8, 9, 16, 17].map(|count| CountMetric::Task.actions().action(count)),
            [
                "guest_download_task_count_0",
                "guest_download_task_count_1",
                "guest_download_task_count_2",
                "guest_download_task_count_3_4",
                "guest_download_task_count_3_4",
                "guest_download_task_count_5_8",
                "guest_download_task_count_5_8",
                "guest_download_task_count_9_16",
                "guest_download_task_count_9_16",
                "guest_download_task_count_17_plus",
            ]
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
    fn attempt_count_actions_are_stable() {
        assert_eq!(
            [0, 1, 2, 3, 4].map(|attempts| { ArchiveKind::Storage.attempt_count_action(attempts) }),
            [
                "storage_download_remote_attempt_count_3",
                "storage_download_remote_attempt_count_1",
                "storage_download_remote_attempt_count_2",
                "storage_download_remote_attempt_count_3",
                "storage_download_remote_attempt_count_3",
            ]
        );
    }

    #[test]
    fn complete_action_schema_is_exact_and_unique() {
        let actions = action_schema();

        assert_eq!(actions.as_slice(), EXPECTED_ACTION_SCHEMA.as_slice());
        assert_eq!(actions.iter().copied().collect::<HashSet<_>>().len(), 95);
    }
}
