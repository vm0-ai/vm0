use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde::de::DeserializeOwned;

use crate::error::RunnerError;
use crate::ids::RunId;

const STATUS_FILE_NAME: &str = "status.json";

#[derive(Debug)]
pub(crate) enum StatusFileReadError {
    Read {
        path: PathBuf,
        error: RunnerError,
    },
    ParseJson {
        path: PathBuf,
        error: serde_json::Error,
    },
}

impl std::fmt::Display for StatusFileReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read { path, error } => write!(f, "read {}: {error}", path.display()),
            Self::ParseJson { path, error } => write!(f, "parse {}: {error}", path.display()),
        }
    }
}

pub(crate) fn path(base_dir: &Path) -> PathBuf {
    base_dir.join(STATUS_FILE_NAME)
}

/// Read and deserialize `status.json` into the caller-selected wire shape.
///
/// Callers intentionally use different shapes below so fields irrelevant to one
/// command cannot make that command reject an otherwise usable status file.
pub(crate) async fn read_as<T>(base_dir: &Path) -> Result<Option<T>, StatusFileReadError>
where
    T: DeserializeOwned,
{
    let path = path(base_dir);
    let content = match crate::private_fs::read_private_file_to_string_with_max(
        &path,
        crate::private_fs::PRIVATE_STATUS_FILE_READ_MAX_BYTES,
    )
    .await
    {
        Ok(Some(content)) => content,
        Ok(None) => return Ok(None),
        Err(error) => {
            return Err(StatusFileReadError::Read { path, error });
        }
    };
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| StatusFileReadError::ParseJson { path, error })
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusForGate {
    pub(crate) mode: String,
    // Gate intentionally requires this field so malformed active-job status
    // never looks like an empty runner.
    pub(crate) active_runs: Vec<StatusGateActiveRun>,
    pub(crate) started_at: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusGateActiveRun {
    pub(crate) run_id: RunId,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusForDoctor {
    pub(crate) mode: String,
    // Defaulting collections preserves doctor reports across rolling schema
    // skew while keeping required per-entry identifiers strict.
    #[serde(default)]
    pub(crate) active_runs: Vec<StatusActiveRun>,
    pub(crate) started_at: String,
    #[serde(default)]
    pub(crate) idle_vms: Vec<StatusIdleVm>,
    #[serde(default)]
    pub(crate) proxy_port: Option<u16>,
    #[serde(default)]
    pub(crate) dns_port: Option<u16>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusActiveRunsOnly {
    // Run resolution only needs mappings. Missing active_runs has historically
    // meant "no active runs", but malformed entries still invalidate the file.
    #[serde(default)]
    pub(crate) active_runs: Vec<StatusActiveRunMapping>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusActiveRunMapping {
    pub(crate) run_id: String,
    pub(crate) sandbox_id: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusActiveRun {
    pub(crate) run_id: String,
    pub(crate) sandbox_id: String,
    pub(crate) phase: Option<String>,
    pub(crate) phase_started_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StatusIdleVm {
    pub(crate) session_id: String,
    pub(crate) sandbox_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_missing_file_returns_none() {
        let dir = tempfile::tempdir().unwrap();

        let status = read_as::<StatusForGate>(dir.path()).await.unwrap();

        assert!(status.is_none());
    }

    #[tokio::test]
    async fn read_malformed_json_returns_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("status.json"), "not json")
            .await
            .unwrap();

        let error = read_as::<StatusForGate>(dir.path()).await.unwrap_err();

        assert!(matches!(error, StatusFileReadError::ParseJson { .. }));
    }

    #[tokio::test]
    async fn read_full_writer_payload_preserves_doctor_fields() {
        let dir = tempfile::tempdir().unwrap();
        let content = r#"{
            "mode": "running",
            "max_concurrent": 4,
            "active_runs": [
                {
                    "run_id":"0191c4e0-0000-7000-8000-000000000001",
                    "sandbox_id":"aaaaaaaa-0000-7000-8000-000000000001",
                    "phase":"preparing",
                    "phase_started_at":"2026-04-13T00:00:01.000Z"
                }
            ],
            "idle_vms": [
                {"session_id":"sess-1","sandbox_id":"bbbbbbbb-0000-7000-8000-000000000001"}
            ],
            "proxy_port": 8080,
            "dns_port": 5300,
            "started_at": "2026-04-13T00:00:00.000Z",
            "updated_at": "2026-04-13T00:05:00.000Z"
        }"#;
        tokio::fs::write(dir.path().join("status.json"), content)
            .await
            .unwrap();

        let status = read_as::<StatusForDoctor>(dir.path())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(status.mode, "running");
        assert_eq!(status.started_at, "2026-04-13T00:00:00.000Z");
        assert_eq!(status.proxy_port, Some(8080));
        assert_eq!(status.dns_port, Some(5300));
        assert_eq!(status.active_runs.len(), 1);
        assert_eq!(
            status.active_runs[0].run_id,
            "0191c4e0-0000-7000-8000-000000000001"
        );
        assert_eq!(status.active_runs[0].phase.as_deref(), Some("preparing"));
        assert_eq!(
            status.active_runs[0].phase_started_at.as_deref(),
            Some("2026-04-13T00:00:01.000Z")
        );
        assert_eq!(status.idle_vms.len(), 1);
        assert_eq!(status.idle_vms[0].session_id, "sess-1");
    }

    #[tokio::test]
    async fn active_runs_only_defaults_missing_active_runs_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{"mode":"running","started_at":"2026-04-13T00:00:00.000Z"}"#,
        )
        .await
        .unwrap();

        let status = read_as::<StatusActiveRunsOnly>(dir.path())
            .await
            .unwrap()
            .unwrap();

        assert!(status.active_runs.is_empty());
    }

    #[tokio::test]
    async fn gate_shape_ignores_unneeded_malformed_fields() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{
                "mode":"running",
                "active_runs":[],
                "started_at":"2026-04-13T00:00:00.000Z",
                "idle_vms":null
            }"#,
        )
        .await
        .unwrap();

        let status = read_as::<StatusForGate>(dir.path()).await.unwrap().unwrap();

        assert_eq!(status.mode, "running");
    }

    #[tokio::test]
    async fn active_runs_only_rejects_null_active_runs() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{"mode":"running","active_runs":null}"#,
        )
        .await
        .unwrap();

        let error = read_as::<StatusActiveRunsOnly>(dir.path())
            .await
            .unwrap_err();

        assert!(matches!(error, StatusFileReadError::ParseJson { .. }));
    }

    #[tokio::test]
    async fn active_runs_only_ignores_unneeded_malformed_phase_fields() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(
            dir.path().join("status.json"),
            r#"{
                "active_runs": [
                    {
                        "run_id":"run-a",
                        "sandbox_id":"sandbox-a",
                        "phase":42,
                        "phase_started_at":{}
                    }
                ]
            }"#,
        )
        .await
        .unwrap();

        let status = read_as::<StatusActiveRunsOnly>(dir.path())
            .await
            .unwrap()
            .unwrap();

        assert_eq!(status.active_runs.len(), 1);
        assert_eq!(status.active_runs[0].run_id, "run-a");
        assert_eq!(status.active_runs[0].sandbox_id, "sandbox-a");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn read_rejects_fifo_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("status.json");
        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let result = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        assert_eq!(
            result,
            0,
            "mkfifo failed: {}",
            std::io::Error::last_os_error()
        );

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            read_as::<StatusForGate>(dir.path()),
        )
        .await;

        assert!(result.is_ok(), "FIFO read should not block");
        assert!(result.unwrap().is_err(), "FIFO status should be rejected");
    }
}
