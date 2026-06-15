use std::fmt;
use std::time::{Duration, Instant};

use tracing::{info, warn};

pub(super) const SLOW_SANDBOX_CREATE_THRESHOLD: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SandboxCreateStage {
    CowPoolAcquire,
    WorkspaceDirRename,
    WorkspaceDrivePrepare,
    WorkspaceSeedSparseCopy,
    WorkspaceFreshFormat,
    SockDirPrepare,
    NetnsAcquire,
    NbdCowCreate,
}

impl SandboxCreateStage {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::CowPoolAcquire => "cow_pool_acquire",
            Self::WorkspaceDirRename => "workspace_dir_rename",
            Self::WorkspaceDrivePrepare => "workspace_drive_prepare",
            Self::WorkspaceSeedSparseCopy => "workspace_seed_sparse_copy",
            Self::WorkspaceFreshFormat => "workspace_fresh_format",
            Self::SockDirPrepare => "sock_dir_prepare",
            Self::NetnsAcquire => "netns_acquire",
            Self::NbdCowCreate => "nbd_cow_create",
        }
    }
}

#[derive(Default)]
struct SandboxCreateStageDurations {
    cow_pool_acquire: Option<Duration>,
    workspace_dir_rename: Option<Duration>,
    workspace_drive_prepare: Option<Duration>,
    workspace_seed_sparse_copy: Option<Duration>,
    workspace_fresh_format: Option<Duration>,
    sock_dir_prepare: Option<Duration>,
    netns_acquire: Option<Duration>,
    nbd_cow_create: Option<Duration>,
}

impl SandboxCreateStageDurations {
    fn set(&mut self, stage: SandboxCreateStage, duration: Duration) {
        match stage {
            SandboxCreateStage::CowPoolAcquire => self.cow_pool_acquire = Some(duration),
            SandboxCreateStage::WorkspaceDirRename => self.workspace_dir_rename = Some(duration),
            SandboxCreateStage::WorkspaceDrivePrepare => {
                self.workspace_drive_prepare = Some(duration);
            }
            SandboxCreateStage::WorkspaceSeedSparseCopy => {
                self.workspace_seed_sparse_copy = Some(duration);
            }
            SandboxCreateStage::WorkspaceFreshFormat => {
                self.workspace_fresh_format = Some(duration)
            }
            SandboxCreateStage::SockDirPrepare => self.sock_dir_prepare = Some(duration),
            SandboxCreateStage::NetnsAcquire => self.netns_acquire = Some(duration),
            SandboxCreateStage::NbdCowCreate => self.nbd_cow_create = Some(duration),
        }
    }

    #[cfg(test)]
    fn get(&self, stage: SandboxCreateStage) -> Option<Duration> {
        match stage {
            SandboxCreateStage::CowPoolAcquire => self.cow_pool_acquire,
            SandboxCreateStage::WorkspaceDirRename => self.workspace_dir_rename,
            SandboxCreateStage::WorkspaceDrivePrepare => self.workspace_drive_prepare,
            SandboxCreateStage::WorkspaceSeedSparseCopy => self.workspace_seed_sparse_copy,
            SandboxCreateStage::WorkspaceFreshFormat => self.workspace_fresh_format,
            SandboxCreateStage::SockDirPrepare => self.sock_dir_prepare,
            SandboxCreateStage::NetnsAcquire => self.netns_acquire,
            SandboxCreateStage::NbdCowCreate => self.nbd_cow_create,
        }
    }
}

pub(crate) struct SandboxCreateTiming {
    sandbox_id: String,
    profile: String,
    started_at: Instant,
    durations: SandboxCreateStageDurations,
    workspace_drive_present: bool,
    workspace_seed_image_used: bool,
    failure_logged: bool,
}

impl SandboxCreateTiming {
    pub(super) fn new(sandbox_id: String, profile: String) -> Self {
        Self {
            sandbox_id,
            profile,
            started_at: Instant::now(),
            durations: SandboxCreateStageDurations::default(),
            workspace_drive_present: false,
            workspace_seed_image_used: false,
            failure_logged: false,
        }
    }

    pub(super) fn mark_workspace_drive_present(&mut self) {
        self.workspace_drive_present = true;
    }

    pub(super) fn mark_workspace_seed_image_used(&mut self) {
        self.workspace_seed_image_used = true;
    }

    pub(super) fn record_stage_result<T, E>(
        &mut self,
        stage: SandboxCreateStage,
        started_at: Instant,
        result: Result<T, E>,
    ) -> Result<T, E>
    where
        E: fmt::Display,
    {
        let elapsed = started_at.elapsed();
        self.record_stage_duration(stage, elapsed);
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                let message = error.to_string();
                self.emit_stage_failure(stage, elapsed, &message);
                Err(error)
            }
        }
    }

    pub(super) fn emit_success_summary(&self) {
        self.emit_success_summary_with_total(self.started_at.elapsed());
    }

    #[cfg(test)]
    pub(super) fn stage_duration_for_test(&self, stage: SandboxCreateStage) -> Option<Duration> {
        self.durations.get(stage)
    }

    fn record_stage_duration(&mut self, stage: SandboxCreateStage, duration: Duration) {
        self.durations.set(stage, duration);
    }

    fn emit_stage_failure(&mut self, stage: SandboxCreateStage, elapsed: Duration, error: &str) {
        if self.failure_logged {
            return;
        }
        self.failure_logged = true;
        let safe_error = sanitize_error_for_timing(error);
        warn!(
            stage = stage.as_str(),
            elapsed_ms = duration_ms(elapsed),
            success = false,
            sandbox_id = self.sandbox_id.as_str(),
            profile = self.profile.as_str(),
            error = safe_error.as_str(),
            "sandbox create stage failed"
        );
    }

    fn emit_success_summary_with_total(&self, total_elapsed: Duration) {
        if total_elapsed < SLOW_SANDBOX_CREATE_THRESHOLD {
            info!(
                stage = "sandbox_create",
                total_elapsed_ms = duration_ms(total_elapsed),
                threshold_ms = duration_ms(SLOW_SANDBOX_CREATE_THRESHOLD),
                success = true,
                sandbox_id = self.sandbox_id.as_str(),
                profile = self.profile.as_str(),
                workspace_drive_present = self.workspace_drive_present,
                workspace_seed_image_used = self.workspace_seed_image_used,
                cow_pool_acquire_ms = optional_duration_ms(self.durations.cow_pool_acquire),
                workspace_dir_rename_ms = optional_duration_ms(self.durations.workspace_dir_rename),
                workspace_drive_prepare_ms =
                    optional_duration_ms(self.durations.workspace_drive_prepare),
                workspace_seed_sparse_copy_ms =
                    optional_duration_ms(self.durations.workspace_seed_sparse_copy),
                workspace_fresh_format_ms =
                    optional_duration_ms(self.durations.workspace_fresh_format),
                sock_dir_prepare_ms = optional_duration_ms(self.durations.sock_dir_prepare),
                netns_acquire_ms = optional_duration_ms(self.durations.netns_acquire),
                nbd_cow_create_ms = optional_duration_ms(self.durations.nbd_cow_create),
                "sandbox create timing"
            );
            return;
        }
        warn!(
            stage = "sandbox_create",
            total_elapsed_ms = duration_ms(total_elapsed),
            threshold_ms = duration_ms(SLOW_SANDBOX_CREATE_THRESHOLD),
            success = true,
            sandbox_id = self.sandbox_id.as_str(),
            profile = self.profile.as_str(),
            workspace_drive_present = self.workspace_drive_present,
            workspace_seed_image_used = self.workspace_seed_image_used,
            cow_pool_acquire_ms = optional_duration_ms(self.durations.cow_pool_acquire),
            workspace_dir_rename_ms = optional_duration_ms(self.durations.workspace_dir_rename),
            workspace_drive_prepare_ms =
                optional_duration_ms(self.durations.workspace_drive_prepare),
            workspace_seed_sparse_copy_ms =
                optional_duration_ms(self.durations.workspace_seed_sparse_copy),
            workspace_fresh_format_ms = optional_duration_ms(self.durations.workspace_fresh_format),
            sock_dir_prepare_ms = optional_duration_ms(self.durations.sock_dir_prepare),
            netns_acquire_ms = optional_duration_ms(self.durations.netns_acquire),
            nbd_cow_create_ms = optional_duration_ms(self.durations.nbd_cow_create),
            "slow sandbox create"
        );
    }
}

fn duration_ms(duration: Duration) -> u64 {
    duration.as_millis() as u64
}

fn optional_duration_ms(duration: Option<Duration>) -> u64 {
    duration.map_or(0, duration_ms)
}

fn sanitize_error_for_timing(error: &str) -> String {
    let first_line = error.lines().next().unwrap_or_default().trim();
    let command_redacted = if let Some((prefix, _)) = first_line.split_once("command failed:") {
        let prefix = prefix.trim_end();
        if prefix.is_empty() {
            "command failed".to_owned()
        } else {
            format!("{prefix} command failed")
        }
    } else {
        first_line.to_owned()
    };
    redact_path_tokens(&command_redacted)
}

fn redact_path_tokens(value: &str) -> String {
    value
        .split_whitespace()
        .map(|token| {
            if is_path_like_token(token) {
                "<path>"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_path_like_token(token: &str) -> bool {
    let token =
        token.trim_matches(|c: char| matches!(c, ':' | ',' | ';' | ')' | '(' | '"' | '\'' | '`'));
    token.contains('/')
        || token.contains('\\')
        || token.starts_with('.')
        || token.ends_with(".ext4")
        || token.ends_with(".img")
        || token.ends_with(".qcow2")
        || token.ends_with(".raw")
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tracing::Level;
    use tracing_subscriber::prelude::*;
    use tracing_test_support::{CapturedEvent, CapturedEvents};

    use super::*;

    fn capture_events(action: impl FnOnce()) -> Vec<CapturedEvent> {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        tracing::subscriber::with_default(subscriber, action);
        captured.entries()
    }

    fn assert_field(event: &CapturedEvent, field: &str, expected: &str) {
        let actual = event
            .fields
            .get(field)
            .unwrap_or_else(|| panic!("missing field {field}; event={event:#?}"));
        assert_eq!(actual, expected, "field {field} mismatch; event={event:#?}");
    }

    #[test]
    fn fast_success_emits_info_summary() {
        let timing = SandboxCreateTiming::new("sandbox-1".into(), "vm0/default".into());

        let events = capture_events(|| {
            timing.emit_success_summary_with_total(SLOW_SANDBOX_CREATE_THRESHOLD / 2);
        });

        assert_eq!(events.len(), 1, "events: {events:#?}");
        let event = &events[0];
        assert_eq!(event.level, Level::INFO);
        assert_field(event, "message", "sandbox create timing");
        assert_field(event, "stage", "sandbox_create");
        assert_field(event, "success", "true");
        assert_field(event, "sandbox_id", "sandbox-1");
        assert_field(event, "profile", "vm0/default");
        assert_field(event, "total_elapsed_ms", "1500");
        assert_field(event, "threshold_ms", "3000");
        assert_field(event, "workspace_drive_present", "false");
        assert_field(event, "workspace_seed_image_used", "false");
    }

    #[test]
    fn slow_success_emits_summary_with_stable_fields() {
        let mut timing = SandboxCreateTiming::new("sandbox-1".into(), "vm0/default".into());
        timing.mark_workspace_drive_present();
        timing.mark_workspace_seed_image_used();
        timing.record_stage_duration(
            SandboxCreateStage::CowPoolAcquire,
            Duration::from_millis(10),
        );
        timing.record_stage_duration(
            SandboxCreateStage::WorkspaceDirRename,
            Duration::from_millis(20),
        );
        timing.record_stage_duration(
            SandboxCreateStage::WorkspaceDrivePrepare,
            Duration::from_millis(30),
        );
        timing.record_stage_duration(
            SandboxCreateStage::WorkspaceSeedSparseCopy,
            Duration::from_millis(40),
        );
        timing.record_stage_duration(
            SandboxCreateStage::SockDirPrepare,
            Duration::from_millis(50),
        );
        timing.record_stage_duration(SandboxCreateStage::NetnsAcquire, Duration::from_millis(60));
        timing.record_stage_duration(SandboxCreateStage::NbdCowCreate, Duration::from_millis(70));

        let events = capture_events(|| {
            timing.emit_success_summary_with_total(SLOW_SANDBOX_CREATE_THRESHOLD);
        });

        assert_eq!(events.len(), 1, "events: {events:#?}");
        let event = &events[0];
        assert_eq!(event.level, Level::WARN);
        assert_field(event, "message", "slow sandbox create");
        assert_field(event, "stage", "sandbox_create");
        assert_field(event, "success", "true");
        assert_field(event, "sandbox_id", "sandbox-1");
        assert_field(event, "profile", "vm0/default");
        assert_field(event, "total_elapsed_ms", "3000");
        assert_field(event, "threshold_ms", "3000");
        assert_field(event, "workspace_drive_present", "true");
        assert_field(event, "workspace_seed_image_used", "true");
        assert_field(event, "cow_pool_acquire_ms", "10");
        assert_field(event, "workspace_dir_rename_ms", "20");
        assert_field(event, "workspace_drive_prepare_ms", "30");
        assert_field(event, "workspace_seed_sparse_copy_ms", "40");
        assert_field(event, "workspace_fresh_format_ms", "0");
        assert_field(event, "sock_dir_prepare_ms", "50");
        assert_field(event, "netns_acquire_ms", "60");
        assert_field(event, "nbd_cow_create_ms", "70");
    }

    #[test]
    fn stage_failure_emits_warning_once() {
        let mut timing = SandboxCreateTiming::new("sandbox-1".into(), "vm0/default".into());

        let events = capture_events(|| {
            timing.emit_stage_failure(
                SandboxCreateStage::WorkspaceSeedSparseCopy,
                Duration::from_millis(25),
                "copy failed",
            );
            timing.emit_stage_failure(
                SandboxCreateStage::WorkspaceDrivePrepare,
                Duration::from_millis(30),
                "outer failed",
            );
        });

        assert_eq!(events.len(), 1, "events: {events:#?}");
        let event = &events[0];
        assert_eq!(event.level, Level::WARN);
        assert_field(event, "message", "sandbox create stage failed");
        assert_field(event, "stage", "workspace_seed_sparse_copy");
        assert_field(event, "elapsed_ms", "25");
        assert_field(event, "success", "false");
        assert_field(event, "sandbox_id", "sandbox-1");
        assert_field(event, "profile", "vm0/default");
        assert_field(event, "error", "copy failed");
    }

    #[test]
    fn stage_failure_redacts_paths_and_command_argv() {
        let mut timing = SandboxCreateTiming::new("sandbox-1".into(), "vm0/default".into());

        let events = capture_events(|| {
            timing.emit_stage_failure(
                SandboxCreateStage::WorkspaceSeedSparseCopy,
                Duration::from_millis(25),
                "sandbox sandbox allocation initialization failed: copy workspace seed image: command failed: cp --sparse=always -- /tmp/source.ext4 /tmp/target.ext4\nsecret stderr",
            );
        });

        assert_eq!(events.len(), 1, "events: {events:#?}");
        let event = &events[0];
        assert_field(
            event,
            "error",
            "sandbox sandbox allocation initialization failed: copy workspace seed image: command failed",
        );
        assert!(!event.fields["error"].contains("/tmp"), "event={event:#?}");
        assert!(!event.fields["error"].contains("cp --"), "event={event:#?}");
        assert!(
            !event.fields["error"].contains("secret stderr"),
            "event={event:#?}"
        );
    }

    #[test]
    fn stage_failure_redacts_command_argv_without_prefix() {
        let error = sanitize_error_for_timing("command failed: cp /tmp/source /tmp/target");

        assert_eq!(error, "command failed");
    }

    #[test]
    fn stage_failure_redacts_path_tokens() {
        let error = sanitize_error_for_timing(
            "workspace seed image size mismatch for /tmp/seed.ext4: expected 1 bytes, got 0 bytes",
        );

        assert_eq!(
            error,
            "workspace seed image size mismatch for <path> expected 1 bytes, got 0 bytes"
        );
    }

    #[test]
    fn stage_failure_redacts_relative_image_path_tokens() {
        let error = sanitize_error_for_timing(
            "workspace seed image size mismatch for seed.ext4: expected 1 bytes, got 0 bytes",
        );

        assert_eq!(
            error,
            "workspace seed image size mismatch for <path> expected 1 bytes, got 0 bytes"
        );
    }
}
