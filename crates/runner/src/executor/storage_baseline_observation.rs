use std::collections::HashMap;
use std::sync::Mutex;

use super::JobParams;
use super::cli_framework::{EffectiveCliFramework, effective_cli_framework};
use crate::storage_manifest::StorageEntry;
use crate::telemetry::JobTelemetry;
use crate::types::ExecutionContext;

const STABILITY_ACTION: &str = "runner_storage_baseline_candidate_stability";
const CANDIDATE_COUNT_ACTION: &str = "runner_storage_baseline_candidate_count";
const ADDED_COUNT_ACTION: &str = "runner_storage_baseline_added_count";
const REMOVED_COUNT_ACTION: &str = "runner_storage_baseline_removed_count";
const CHANGED_AT_PATH_COUNT_ACTION: &str = "runner_storage_baseline_changed_at_path_count";

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct CandidateIdentity {
    mount_path: String,
    vas_storage_name: String,
    vas_version_id: String,
    instructions_target_filename: Option<String>,
}

impl From<&StorageEntry> for CandidateIdentity {
    fn from(entry: &StorageEntry) -> Self {
        Self {
            mount_path: entry.mount_path.clone(),
            vas_storage_name: entry.vas_storage_name.clone(),
            vas_version_id: entry.vas_version_id.clone(),
            instructions_target_filename: entry.instructions_target_filename.clone(),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Hash)]
struct ObservationKey {
    profile_name: String,
    framework: EffectiveCliFramework,
}

struct Observation {
    outcome: &'static str,
    candidate_count: usize,
    added_count: usize,
    removed_count: usize,
    changed_at_path_count: usize,
}

#[derive(Default)]
pub(crate) struct StorageBaselineObserver {
    previous: Mutex<HashMap<ObservationKey, Vec<CandidateIdentity>>>,
}

impl StorageBaselineObserver {
    pub(crate) fn record(
        &self,
        context: &ExecutionContext,
        params: &JobParams,
        telemetry: &mut JobTelemetry,
    ) {
        let mut candidates = context
            .storage_manifest
            .iter()
            .flat_map(|manifest| &manifest.storages)
            .filter(|entry| entry.baseline_candidate)
            .map(CandidateIdentity::from)
            .collect::<Vec<_>>();
        candidates.sort_unstable();

        let observation = if candidates.is_empty() {
            Observation {
                outcome: "none",
                candidate_count: 0,
                added_count: 0,
                removed_count: 0,
                changed_at_path_count: 0,
            }
        } else {
            self.observe_marked(
                ObservationKey {
                    profile_name: params.profile_name.clone(),
                    framework: effective_cli_framework(&context.cli_agent_type),
                },
                candidates,
            )
        };

        telemetry.record_bounded_outcome(STABILITY_ACTION, true, observation.outcome, None);
        for (action, count) in [
            (CANDIDATE_COUNT_ACTION, observation.candidate_count),
            (ADDED_COUNT_ACTION, observation.added_count),
            (REMOVED_COUNT_ACTION, observation.removed_count),
            (
                CHANGED_AT_PATH_COUNT_ACTION,
                observation.changed_at_path_count,
            ),
        ] {
            telemetry.record_bounded_outcome(action, true, count_bucket(count), None);
        }
    }

    fn observe_marked(
        &self,
        key: ObservationKey,
        candidates: Vec<CandidateIdentity>,
    ) -> Observation {
        let candidate_count = candidates.len();
        let mut previous_by_key = self
            .previous
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(previous) = previous_by_key.get_mut(&key) else {
            previous_by_key.insert(key, candidates);
            return Observation {
                outcome: "first",
                candidate_count,
                added_count: 0,
                removed_count: 0,
                changed_at_path_count: 0,
            };
        };

        if *previous == candidates {
            return Observation {
                outcome: "same",
                candidate_count,
                added_count: 0,
                removed_count: 0,
                changed_at_path_count: 0,
            };
        }

        let added_count = candidates
            .iter()
            .filter(|candidate| {
                previous
                    .iter()
                    .all(|entry| entry.mount_path != candidate.mount_path)
            })
            .count();
        let removed_count = previous
            .iter()
            .filter(|entry| {
                candidates
                    .iter()
                    .all(|candidate| candidate.mount_path != entry.mount_path)
            })
            .count();
        let changed_at_path_count = candidates
            .iter()
            .filter(|candidate| {
                previous
                    .iter()
                    .any(|entry| entry.mount_path == candidate.mount_path && entry != *candidate)
            })
            .count();
        *previous = candidates;

        Observation {
            outcome: "changed",
            candidate_count,
            added_count,
            removed_count,
            changed_at_path_count,
        }
    }
}

fn count_bucket(count: usize) -> &'static str {
    match count {
        0 => "0",
        1 => "1",
        2 => "2",
        3 | 4 => "3_4",
        5..=8 => "5_8",
        9..=16 => "9_16",
        _ => "17_plus",
    }
}
