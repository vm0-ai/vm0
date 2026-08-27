//! Guest runtime-directory aliases resolve before bootstrap side effects.

#![cfg(unix)]

mod common;

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tokio::process::Command;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CHILD_TIMEOUT: Duration = Duration::from_secs(15);
const SOURCE_EVENT: &str = "guest_runtime_dir_env_source";
static NEXT_ENDPOINT: AtomicU32 = AtomicU32::new(1);

struct PrivateFiles {
    user_env_path: PathBuf,
    run_payload_path: PathBuf,
}

fn unique_endpoint(label: u8) -> String {
    let seq = std::process::id().wrapping_add(NEXT_ENDPOINT.fetch_add(1, Ordering::Relaxed));
    let mut nonce = [0_u8; 16];
    nonce[..4].copy_from_slice(&seq.to_le_bytes());
    nonce[4] = label;
    process_control_ipc::endpoint_name(seq, &nonce)
}

fn write_private_files(runtime_dir: &Path, valid_payload: bool) -> TestResult<PrivateFiles> {
    let user_env_dir = runtime_dir.join(guest_contracts::env::USER_ENV_PRIVATE_DIR_NAME);
    let user_env_path = user_env_dir.join(guest_contracts::env::USER_ENV_FILENAME);
    let run_payload_dir = runtime_dir.join(guest_contracts::env::RUN_PAYLOAD_PRIVATE_DIR_NAME);
    let run_payload_path = run_payload_dir.join(guest_contracts::env::RUN_PAYLOAD_FILENAME);
    std::fs::create_dir_all(&user_env_dir)?;
    std::fs::create_dir_all(&run_payload_dir)?;
    std::fs::write(&user_env_path, br#"{"HOME":"/home/user"}"#)?;
    if valid_payload {
        std::fs::write(
            &run_payload_path,
            serde_json::to_vec(&guest_contracts::env::RunPayload::default())?,
        )?;
    } else {
        std::fs::write(&run_payload_path, b"invalid-json")?;
    }
    Ok(PrivateFiles {
        user_env_path,
        run_payload_path,
    })
}

fn guest_agent_command(root: &Path, run_id: &str, private_files: &PrivateFiles) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    command
        .env_clear()
        .env(guest_contracts::env::RUN_ID_ENV, run_id)
        .env("HOME", root.join("process-home"))
        .env(
            guest_contracts::env::CANONICAL_API_URL_ENV,
            "http://127.0.0.1:1",
        )
        .env(guest_contracts::env::CANONICAL_API_TOKEN_ENV, "")
        .env(
            guest_contracts::env::CANONICAL_USER_ENV_FILE_ENV,
            &private_files.user_env_path,
        )
        .env(
            guest_contracts::env::CANONICAL_RUN_PAYLOAD_FILE_ENV,
            &private_files.run_payload_path,
        );
    command
}

fn apply_runtime_aliases(command: &mut Command, canonical: Option<&OsStr>, legacy: Option<&OsStr>) {
    command
        .env_remove(guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV)
        .env_remove(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV);
    if let Some(value) = canonical {
        command.env(
            guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV,
            value,
        );
    }
    if let Some(value) = legacy {
        command.env(guest_contracts::runtime_paths::GUEST_RUNTIME_DIR_ENV, value);
    }
}

async fn command_output(command: &mut Command, context: &str) -> TestResult<std::process::Output> {
    Ok(common::command_output_with_timeout(command, CHILD_TIMEOUT, context).await?)
}

fn source_messages(log: &str) -> Vec<&str> {
    log.lines()
        .filter_map(|line| line.rsplit_once("] ").map(|(_, message)| message))
        .filter(|message| message.starts_with(SOURCE_EVENT))
        .collect()
}

fn assert_value_free(text: &str, forbidden: &[&str], context: &str) {
    for value in forbidden {
        assert!(
            !text.contains(value),
            "{context} exposed guest runtime-directory material"
        );
    }
}

fn assert_listener_idle(listener: &std::os::unix::net::UnixListener, context: &str) -> TestResult {
    listener.set_nonblocking(true)?;
    let error = match listener.accept() {
        Err(error) => error,
        Ok(_) => {
            return Err(format!("{context} connected before rejecting runtime aliases").into());
        }
    };
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock, "{context}");
    Ok(())
}

#[tokio::test]
async fn guest_agent_uses_shared_runtime_alias_semantics_and_sink_scoped_evidence() -> TestResult {
    struct Case {
        name: &'static str,
        canonical: Option<&'static str>,
        legacy: Option<&'static str>,
        source: Option<&'static str>,
        fallback: bool,
    }

    let cases = [
        Case {
            name: "absent",
            canonical: None,
            legacy: None,
            source: None,
            fallback: true,
        },
        Case {
            name: "dual-empty",
            canonical: Some(""),
            legacy: Some(""),
            source: None,
            fallback: true,
        },
        Case {
            name: "canonical-only",
            canonical: Some("selected"),
            legacy: None,
            source: Some("canonical-only"),
            fallback: false,
        },
        Case {
            name: "legacy-only",
            canonical: None,
            legacy: Some("selected"),
            source: Some("legacy-only"),
            fallback: false,
        },
        Case {
            name: "equal-dual",
            canonical: Some("selected"),
            legacy: Some("selected"),
            source: Some("dual"),
            fallback: false,
        },
        Case {
            name: "canonical-empty",
            canonical: Some(""),
            legacy: Some("selected"),
            source: Some("legacy-only"),
            fallback: false,
        },
        Case {
            name: "legacy-empty",
            canonical: Some("selected"),
            legacy: Some(""),
            source: Some("canonical-only"),
            fallback: false,
        },
    ];

    let root = tempfile::tempdir()?;
    for case in cases {
        let run_id = format!("runtime-alias-{}", case.name);
        let runtime_dir = if case.fallback {
            guest_contracts::runtime_paths::run_dir_for_home(
                root.path().join("process-home"),
                &run_id,
            )?
        } else {
            root.path()
                .join(format!("{}-runtime-value-must-not-leak", case.name))
        };
        let private_files = write_private_files(&runtime_dir, false)?;
        let mut command = guest_agent_command(root.path(), &run_id, &private_files);
        let selected = runtime_dir.as_os_str();
        let canonical = case.canonical.map(|value| {
            if value.is_empty() {
                OsStr::new("")
            } else {
                selected
            }
        });
        let legacy = case.legacy.map(|value| {
            if value.is_empty() {
                OsStr::new("")
            } else {
                selected
            }
        });
        apply_runtime_aliases(&mut command, canonical, legacy);

        let output = command_output(
            &mut command,
            &format!("{} runtime alias scenario did not finish", case.name),
        )
        .await?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(1), "{}: {stderr}", case.name);
        assert!(
            stderr.contains("parse VM0_RUN_PAYLOAD_FILE JSON"),
            "{}: {stderr}",
            case.name
        );

        let log = std::fs::read_to_string(guest_contracts::runtime_paths::system_log_file(
            &runtime_dir,
        ))?;
        let messages = source_messages(&log);
        let expected = case.source.map(|source| {
            format!(
                "{SOURCE_EVENT} key={} source={source}",
                guest_contracts::runtime_paths::CANONICAL_GUEST_RUNTIME_DIR_ENV
            )
        });
        match expected {
            Some(expected) => assert_eq!(messages, [expected.as_str()], "{}", case.name),
            None => assert!(messages.is_empty(), "{}", case.name),
        }
        let runtime_marker = format!("{}-runtime-value-must-not-leak", case.name);
        assert_value_free(&stderr, &[&runtime_marker], case.name);
        assert_value_free(&log, &[&runtime_marker], case.name);
    }

    Ok(())
}

#[tokio::test]
async fn guest_agent_rejects_runtime_alias_conflict_before_capabilities_and_private_files()
-> TestResult {
    let root = tempfile::tempdir()?;
    let canonical_dir = root.path().join("canonical-runtime-must-not-leak");
    let legacy_dir = root.path().join("legacy-runtime-must-not-leak");
    std::fs::create_dir_all(&legacy_dir)?;
    let private_files = write_private_files(&canonical_dir, true)?;
    let process_endpoint = unique_endpoint(1);
    let workload_endpoint = unique_endpoint(2);
    let process_listener = process_control_ipc::bind_abstract_listener(&process_endpoint)?;
    let workload_listener = process_control_ipc::bind_abstract_listener(&workload_endpoint)?;
    let mut command = guest_agent_command(root.path(), "runtime-conflict", &private_files);
    apply_runtime_aliases(
        &mut command,
        Some(canonical_dir.as_os_str()),
        Some(legacy_dir.as_os_str()),
    );
    command
        .env(process_control_ipc::BOOTSTRAP_ENV, &process_endpoint)
        .env(
            guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
            &workload_endpoint,
        )
        .env(
            guest_contracts::process_containment::TOOL_CGROUP_PROCS_ENDPOINT_ENV,
            "tool-endpoint-must-not-leak",
        );

    let output = command_output(
        &mut command,
        "guest runtime alias conflict did not fail closed",
    )
    .await?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
    assert!(stderr.contains(
        "conflicting guest runtime directory environment aliases: \
         canonical_key=OKOU_GUEST_RUNTIME_DIR legacy_key=VM0_GUEST_RUNTIME_DIR state=conflict"
    ));
    assert_value_free(
        &stderr,
        &[
            "canonical-runtime-must-not-leak",
            "legacy-runtime-must-not-leak",
            "tool-endpoint-must-not-leak",
            &process_endpoint,
            &workload_endpoint,
        ],
        "runtime conflict",
    );
    assert_listener_idle(&process_listener, "process-control socket")?;
    assert_listener_idle(&workload_listener, "workload placement socket")?;
    assert!(private_files.user_env_path.exists());
    assert!(private_files.run_payload_path.exists());
    assert!(!guest_contracts::runtime_paths::system_log_file(&canonical_dir).exists());
    assert!(!guest_contracts::runtime_paths::system_log_file(&legacy_dir).exists());
    assert!(!guest_contracts::runtime_paths::sandbox_ops_log_file(&canonical_dir).exists());
    assert!(!guest_contracts::runtime_paths::sandbox_ops_log_file(&legacy_dir).exists());

    Ok(())
}

#[tokio::test]
async fn guest_agent_rejects_relative_runtime_alias_before_capability_connection() -> TestResult {
    let root = tempfile::tempdir()?;
    let runtime_dir = root.path().join("private-runtime");
    let private_files = write_private_files(&runtime_dir, true)?;
    let workload_endpoint = unique_endpoint(3);
    let workload_listener = process_control_ipc::bind_abstract_listener(&workload_endpoint)?;
    let mut command = guest_agent_command(root.path(), "relative-runtime", &private_files);
    apply_runtime_aliases(&mut command, Some(OsStr::new("relative-runtime")), None);
    command
        .env(process_control_ipc::BOOTSTRAP_ENV, "process-control")
        .env(
            guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
            &workload_endpoint,
        )
        .env(
            guest_contracts::process_containment::TOOL_CGROUP_PROCS_ENDPOINT_ENV,
            "tool-endpoint",
        );

    let output = command_output(
        &mut command,
        "relative runtime alias did not fail before capability connection",
    )
    .await?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
    assert!(stderr.contains("VM0_GUEST_RUNTIME_DIR must be an absolute path"));
    assert_listener_idle(&workload_listener, "relative runtime workload socket")?;
    assert!(private_files.user_env_path.exists());
    assert!(private_files.run_payload_path.exists());
    Ok(())
}
