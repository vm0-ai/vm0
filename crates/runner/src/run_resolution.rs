//! Resolve user-supplied run ids through live runner config and status state.

use std::path::{Path, PathBuf};

use crate::error::{RunnerError, RunnerResult};
use crate::process::RunnerProcessInfo;

/// Load only the `base_dir` field from a runner config YAML (best-effort).
///
/// Read / parse failures log at `warn` level and return `None` so a single
/// broken runner config doesn't stop resolution for the rest.
async fn load_base_dir(config_path: &Path) -> Option<PathBuf> {
    #[derive(serde::Deserialize)]
    struct ConfigShape {
        base_dir: PathBuf,
    }
    let content = match tokio::fs::read_to_string(config_path).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(path = %config_path.display(), error = %e, "skipping runner: cannot read config");
            return None;
        }
    };
    let shape: ConfigShape = match serde_yaml_ng::from_str(&content) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(path = %config_path.display(), error = %e, "skipping runner: cannot parse config");
            return None;
        }
    };
    if shape.base_dir.is_absolute() {
        Some(shape.base_dir)
    } else {
        config_path.parent().map(|p| p.join(&shape.base_dir))
    }
}

/// Read `{base_dir}/status.json` and extract `(run_id, sandbox_id)` for
/// every active run. Returns `None` if the file is missing or unparseable
/// (logs at `warn` level so the operator sees the miss immediately).
async fn read_active_runs(base_dir: &Path) -> Option<Vec<(String, String)>> {
    #[derive(serde::Deserialize)]
    struct StatusShape {
        #[serde(default)]
        active_runs: Vec<ActiveRunShape>,
    }
    #[derive(serde::Deserialize)]
    struct ActiveRunShape {
        run_id: String,
        sandbox_id: String,
    }
    let path = base_dir.join("status.json");
    let content = match tokio::fs::read_to_string(&path).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "skipping runner: cannot read status.json");
            return None;
        }
    };
    let shape: StatusShape = match serde_json::from_str(&content) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(path = %path.display(), error = %e, "skipping runner: cannot parse status.json");
            return None;
        }
    };
    Some(
        shape
            .active_runs
            .into_iter()
            .map(|r| (r.run_id, r.sandbox_id))
            .collect(),
    )
}

/// Result of collecting `(run_id, sandbox_id)` pairs from runners.
pub(crate) struct ActiveRunMappings {
    pub entries: Vec<(String, String)>,
    /// How many runners were discovered on the host.
    pub runners_total: usize,
    /// How many runners had unreadable configs or status files.
    pub runners_failed: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedRunMapping {
    pub run_id: String,
    pub sandbox_id: String,
}

/// Collect all `(run_id, sandbox_id)` pairs from every reachable runner's
/// `status.json`. Used by `kill --run` and `exec --run` to translate a
/// user-supplied run_id into the sandbox_id that identifies the FC.
pub(crate) async fn collect_active_run_mappings(
    runners: &[RunnerProcessInfo],
) -> ActiveRunMappings {
    let mut entries = Vec::new();
    let mut failed = 0usize;
    for runner in runners {
        let Some(base_dir) = load_base_dir(&runner.config_path).await else {
            failed += 1;
            continue;
        };
        match read_active_runs(&base_dir).await {
            Some(runs) => entries.extend(runs),
            None => failed += 1,
        }
    }
    ActiveRunMappings {
        entries,
        runners_total: runners.len(),
        runners_failed: failed,
    }
}

/// Given a `run_id` prefix, find the unique matching active run from collected
/// status entries.
///
/// Returns the full `run_id` and `sandbox_id` on unique match. Errors on empty
/// or ambiguous.
/// When no match is found and some runners were unreadable, the error
/// message includes a diagnostic hint so the operator knows why.
pub(crate) fn resolve_run_mapping(
    input: &str,
    mappings: &ActiveRunMappings,
) -> RunnerResult<ResolvedRunMapping> {
    if input.is_empty() {
        return Err(RunnerError::Config("run id must not be empty".into()));
    }

    let mut matching: Vec<&(String, String)> = mappings
        .entries
        .iter()
        .filter(|(rid, _)| rid.starts_with(input))
        .collect();
    matching.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    matching.dedup();

    match matching.as_slice() {
        [(run_id, sandbox_id)] => Ok(ResolvedRunMapping {
            run_id: (*run_id).clone(),
            sandbox_id: (*sandbox_id).clone(),
        }),
        [] => {
            let mut msg = format!("no active run matches '{input}'");
            if mappings.runners_failed > 0 {
                msg.push_str(&format!(
                    " ({} of {} runner(s) had unreadable config/status — \
                     check warnings above)",
                    mappings.runners_failed, mappings.runners_total,
                ));
            } else if mappings.runners_total == 0 {
                msg.push_str(" (no runner processes found on this host)");
            }
            Err(RunnerError::Config(msg))
        }
        _ => {
            let lines: Vec<String> = matching
                .iter()
                .map(|(rid, sid)| format!("run={rid} sandbox={sid}"))
                .collect();
            Err(RunnerError::Config(format!(
                "ambiguous run prefix '{input}', matches: [{}]",
                lines.join(", ")
            )))
        }
    }
}

/// Given a `run_id` prefix, find the unique matching `sandbox_id` from
/// collected status entries.
pub(crate) fn resolve_run_to_sandbox(
    input: &str,
    mappings: &ActiveRunMappings,
) -> RunnerResult<String> {
    Ok(resolve_run_mapping(input, mappings)?.sandbox_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mappings(entries: Vec<(String, String)>) -> ActiveRunMappings {
        let total = if entries.is_empty() { 0 } else { 1 };
        ActiveRunMappings {
            entries,
            runners_total: total,
            runners_failed: 0,
        }
    }

    #[tokio::test]
    async fn load_base_dir_absolute() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("runner.yaml");
        std::fs::write(&config, "base_dir: /data/runner-01\nname: test\n").unwrap();
        let bd = load_base_dir(&config).await.unwrap();
        assert_eq!(bd, Path::new("/data/runner-01"));
    }

    #[tokio::test]
    async fn load_base_dir_relative() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("runner.yaml");
        std::fs::write(&config, "base_dir: ./data\nname: test\n").unwrap();
        let bd = load_base_dir(&config).await.unwrap();
        assert_eq!(bd, dir.path().join("./data"));
    }

    #[tokio::test]
    async fn load_base_dir_missing_file() {
        let result = load_base_dir(Path::new("/no/such/config.yaml")).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn load_base_dir_malformed_yaml() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("runner.yaml");
        std::fs::write(&config, "not: valid: yaml: [[[").unwrap();
        assert!(load_base_dir(&config).await.is_none());
    }

    #[tokio::test]
    async fn read_active_runs_normal() {
        let dir = tempfile::tempdir().unwrap();
        let status = r#"{
            "mode": "running",
            "active_runs": [
                {"run_id": "R1", "sandbox_id": "S1"},
                {"run_id": "R2", "sandbox_id": "S2"}
            ],
            "started_at": "2026-01-01T00:00:00.000Z"
        }"#;
        std::fs::write(dir.path().join("status.json"), status).unwrap();
        let runs = read_active_runs(dir.path()).await.unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0], ("R1".into(), "S1".into()));
    }

    #[tokio::test]
    async fn read_active_runs_missing_field_defaults_empty() {
        let dir = tempfile::tempdir().unwrap();
        // status.json without active_runs field — serde(default) kicks in
        std::fs::write(dir.path().join("status.json"), r#"{"mode":"running"}"#).unwrap();
        let runs = read_active_runs(dir.path()).await.unwrap();
        assert!(runs.is_empty());
    }

    #[tokio::test]
    async fn read_active_runs_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_active_runs(dir.path()).await.is_none());
    }

    #[tokio::test]
    async fn read_active_runs_malformed_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("status.json"), "not json").unwrap();
        assert!(read_active_runs(dir.path()).await.is_none());
    }

    #[test]
    fn run_prefix_resolves_to_sandbox_id() {
        let status = mappings(vec![(
            "550e8400-run-1111-2222-aaaaaaaaaaaa".into(),
            "sbox-9999".into(),
        )]);
        let result = resolve_run_to_sandbox("550e8400", &status);
        assert_eq!(result.unwrap(), "sbox-9999");
    }

    #[test]
    fn run_prefix_resolves_full_mapping() {
        let status = mappings(vec![(
            "550e8400-run-1111-2222-aaaaaaaaaaaa".into(),
            "sbox-9999".into(),
        )]);

        let result = resolve_run_mapping("550e8400", &status).unwrap();

        assert_eq!(result.run_id, "550e8400-run-1111-2222-aaaaaaaaaaaa");
        assert_eq!(result.sandbox_id, "sbox-9999");
    }

    #[test]
    fn run_prefix_full_uuid() {
        let status = mappings(vec![(
            "550e8400-e29b-41d4-a716-446655440000".into(),
            "sbox-full".into(),
        )]);
        let result = resolve_run_to_sandbox("550e8400-e29b-41d4-a716-446655440000", &status);
        assert_eq!(result.unwrap(), "sbox-full");
    }

    #[test]
    fn run_prefix_ambiguous() {
        let status = mappings(vec![
            ("abc-111".into(), "sbox-A".into()),
            ("abc-222".into(), "sbox-B".into()),
        ]);
        let Err(e) = resolve_run_to_sandbox("abc", &status) else {
            panic!("expected ambiguity error");
        };
        let msg = e.to_string();
        assert!(msg.contains("ambiguous"), "{msg}");
        assert!(msg.contains("abc-111"), "{msg}");
        assert!(msg.contains("abc-222"), "{msg}");
    }

    #[test]
    fn run_prefix_no_match() {
        let status = mappings(vec![("abc-111".into(), "sbox-A".into())]);
        let result = resolve_run_to_sandbox("deadbeef", &status);
        assert!(result.is_err());
    }

    #[test]
    fn run_prefix_empty_input() {
        let empty = mappings(vec![]);
        let result = resolve_run_to_sandbox("", &empty);
        assert!(result.is_err());
    }

    #[test]
    fn run_prefix_dedups_duplicate_entries() {
        let status = mappings(vec![("R1".into(), "S1".into()), ("R1".into(), "S1".into())]);
        let result = resolve_run_to_sandbox("R1", &status);
        assert_eq!(result.unwrap(), "S1");
    }

    #[test]
    fn run_prefix_dedup_preserves_true_ambiguity() {
        let status = mappings(vec![
            ("R1".into(), "S1".into()),
            ("R1".into(), "S1".into()),
            ("R2".into(), "S2".into()),
        ]);
        let Err(e) = resolve_run_to_sandbox("R", &status) else {
            panic!("expected ambiguity");
        };
        let msg = e.to_string();
        let r1_count = msg.matches("R1").count();
        assert_eq!(r1_count, 1, "R1 should appear once after dedup: {msg}");
        assert!(msg.contains("R2"), "{msg}");
    }

    #[test]
    fn run_prefix_aggregated_across_runners() {
        let status = mappings(vec![
            ("aaa-111".into(), "sbox-A".into()),
            ("bbb-222".into(), "sbox-B".into()),
        ]);
        assert_eq!(resolve_run_to_sandbox("aaa", &status).unwrap(), "sbox-A");
        assert_eq!(resolve_run_to_sandbox("bbb", &status).unwrap(), "sbox-B");
    }

    #[test]
    fn run_prefix_no_match_hints_unreadable_runners() {
        let m = ActiveRunMappings {
            entries: vec![],
            runners_total: 3,
            runners_failed: 2,
        };
        let err = resolve_run_to_sandbox("abc", &m).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("2 of 3"), "{msg}");
        assert!(msg.contains("unreadable"), "{msg}");
    }

    #[test]
    fn run_prefix_no_match_hints_no_runners() {
        let m = ActiveRunMappings {
            entries: vec![],
            runners_total: 0,
            runners_failed: 0,
        };
        let err = resolve_run_to_sandbox("abc", &m).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("no runner processes"), "{msg}");
    }
}
