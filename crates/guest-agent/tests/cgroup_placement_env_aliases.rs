//! Cgroup placement aliases are resolved before capability consumption.

#![cfg(unix)]

mod common;

use std::ffi::{OsStr, OsString};
use std::os::fd::AsFd;
use std::os::unix::ffi::OsStringExt;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use tokio::process::Command;

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

const CHILD_TIMEOUT: Duration = Duration::from_secs(30);
const ENDPOINT_MARKER: &str = "must-not-leak";
static NEXT_ENDPOINT: AtomicU32 = AtomicU32::new(1);

#[derive(Clone, Copy)]
enum AliasSource {
    CanonicalOnly,
    LegacyOnly,
    Dual,
}

fn unique_endpoint() -> String {
    let seq = std::process::id().wrapping_add(NEXT_ENDPOINT.fetch_add(1, Ordering::Relaxed));
    process_control_ipc::endpoint_name(seq, b"cgroup-placement")
}

fn guest_agent_command() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_guest-agent"));
    for key in [
        process_control_ipc::BOOTSTRAP_ENV,
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
        guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
        guest_contracts::process_containment::TOOL_CGROUP_PROCS_ENDPOINT_ENV,
        "OKOU_TEST_ALLOW_UNMANAGED_PROCESS_CONTROL",
    ] {
        command.env_remove(key);
    }
    command.env(
        process_control_ipc::CANONICAL_BOOTSTRAP_ENV,
        "process-control-endpoint-must-not-leak",
    );
    command
}

fn apply_pair(
    command: &mut Command,
    canonical_key: &'static str,
    legacy_key: &'static str,
    source: AliasSource,
    value: &OsStr,
) {
    match source {
        AliasSource::CanonicalOnly => {
            command.env(canonical_key, value);
        }
        AliasSource::LegacyOnly => {
            command.env(legacy_key, value);
        }
        AliasSource::Dual => {
            command.env(canonical_key, value).env(legacy_key, value);
        }
    }
}

fn apply_values(
    command: &mut Command,
    canonical_key: &'static str,
    legacy_key: &'static str,
    canonical: Option<OsString>,
    legacy: Option<OsString>,
) {
    command.env_remove(canonical_key).env_remove(legacy_key);
    if let Some(value) = canonical {
        command.env(canonical_key, value);
    }
    if let Some(value) = legacy {
        command.env(legacy_key, value);
    }
}

async fn command_output(command: &mut Command, context: &str) -> TestResult<std::process::Output> {
    Ok(common::command_output_with_timeout(command, CHILD_TIMEOUT, context).await?)
}

fn assert_value_free(stderr: &str, endpoint: &str, context: &str) {
    for value in [
        endpoint,
        "process-control-endpoint-must-not-leak",
        "canonical-workload-must-not-leak",
        "legacy-workload-must-not-leak",
        "canonical-tool-must-not-leak",
        "legacy-tool-must-not-leak",
    ] {
        assert!(
            !stderr.contains(value),
            "{context} exposed cgroup placement endpoint material"
        );
    }
}

async fn assert_rejected_before_workload_connection<F>(
    name: &str,
    expected_error: &str,
    configure: F,
) -> TestResult
where
    F: FnOnce(&mut Command, &str),
{
    let endpoint = unique_endpoint();
    let listener = process_control_ipc::bind_abstract_listener(&endpoint)?;
    let mut command = guest_agent_command();
    configure(&mut command, &endpoint);

    let output = command_output(
        &mut command,
        &format!("{name} guest-agent scenario did not finish"),
    )
    .await?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "{name} stderr: {stderr}");
    assert!(stderr.contains(expected_error), "{name} stderr: {stderr}");
    assert_value_free(&stderr, &endpoint, name);

    listener.set_nonblocking(true)?;
    let accept_error = match listener.accept() {
        Err(error) => error,
        Ok(_) => {
            return Err(format!(
                "{name} connected to the workload capability before rejecting invalid aliases"
            )
            .into());
        }
    };
    assert_eq!(
        accept_error.kind(),
        std::io::ErrorKind::WouldBlock,
        "{name}"
    );
    Ok(())
}

#[tokio::test]
async fn guest_agent_accepts_each_resolved_alias_source_for_both_pairs() -> TestResult {
    let sources = [
        AliasSource::CanonicalOnly,
        AliasSource::LegacyOnly,
        AliasSource::Dual,
    ];

    for (workload_index, workload_source) in sources.into_iter().enumerate() {
        for (tool_index, tool_source) in sources.into_iter().enumerate() {
            let endpoint = unique_endpoint();
            let listener = process_control_ipc::bind_abstract_listener(&endpoint)?;
            let broker = std::thread::spawn(move || -> std::io::Result<()> {
                let stream =
                    process_control_ipc::accept_with_timeout(&listener, Duration::from_secs(5))?;
                let invalid_placement =
                    std::fs::OpenOptions::new().write(true).open("/dev/null")?;
                process_control_ipc::send_workload_placement(&stream, invalid_placement.as_fd())
            });
            let tool_endpoint = format!("tool-{workload_index}-{tool_index}-{ENDPOINT_MARKER}");
            let mut command = guest_agent_command();
            apply_pair(
                &mut command,
                guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV,
                guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV,
                workload_source,
                OsStr::new(&endpoint),
            );
            apply_pair(
                &mut command,
                guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV,
                guest_contracts::process_containment::TOOL_CGROUP_PROCS_ENDPOINT_ENV,
                tool_source,
                OsStr::new(&tool_endpoint),
            );

            let output = command_output(
                &mut command,
                "resolved cgroup placement alias scenario did not finish",
            )
            .await?;
            broker
                .join()
                .map_err(|_| "workload placement broker thread panicked")??;
            let stderr = String::from_utf8_lossy(&output.stderr);
            assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
            assert!(
                stderr.contains("workload placement fd is not on cgroup v2"),
                "stderr: {stderr}"
            );
            assert_value_free(&stderr, &endpoint, "resolved alias source");
            assert!(!stderr.contains(&tool_endpoint));
        }
    }
    Ok(())
}

#[tokio::test]
async fn guest_agent_rejects_the_full_invalid_matrix_before_capability_consumption() -> TestResult {
    let workload_canonical =
        guest_contracts::process_containment::CANONICAL_WORKLOAD_CGROUP_PROCS_ENV;
    let workload_legacy = guest_contracts::process_containment::WORKLOAD_CGROUP_PROCS_ENDPOINT_ENV;
    let tool_canonical = guest_contracts::process_containment::CANONICAL_TOOL_CGROUP_PROCS_ENV;
    let tool_legacy = guest_contracts::process_containment::TOOL_CGROUP_PROCS_ENDPOINT_ENV;
    let workload_conflict = format!(
        "conflicting cgroup placement environment aliases: canonical_key={workload_canonical} \
         legacy_key={workload_legacy} state=conflict"
    );
    let tool_conflict = format!(
        "conflicting cgroup placement environment aliases: canonical_key={tool_canonical} \
         legacy_key={tool_legacy} state=conflict"
    );
    let workload_empty = format!(
        "invalid cgroup placement environment aliases: canonical_key={workload_canonical} \
         legacy_key={workload_legacy} state=empty"
    );
    let tool_empty = format!(
        "invalid cgroup placement environment aliases: canonical_key={tool_canonical} \
         legacy_key={tool_legacy} state=empty"
    );

    assert_rejected_before_workload_connection(
        "workload-conflict",
        &workload_conflict,
        |command, _endpoint| {
            apply_values(
                command,
                workload_canonical,
                workload_legacy,
                Some(OsString::from("canonical-workload-must-not-leak")),
                Some(OsString::from("legacy-workload-must-not-leak")),
            );
            command.env(tool_legacy, "legacy-tool-must-not-leak");
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "tool-conflict-after-workload-resolution",
        &tool_conflict,
        |command, endpoint| {
            command.env(workload_canonical, endpoint);
            apply_values(
                command,
                tool_canonical,
                tool_legacy,
                Some(OsString::from("canonical-tool-must-not-leak")),
                Some(OsString::from("legacy-tool-must-not-leak")),
            );
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "workload-empty",
        &workload_empty,
        |command, _endpoint| {
            command
                .env(workload_canonical, "")
                .env(tool_legacy, "legacy-tool-must-not-leak");
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "tool-dual-empty",
        &tool_empty,
        |command, endpoint| {
            command
                .env(workload_legacy, endpoint)
                .env(tool_canonical, "")
                .env(tool_legacy, "");
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "workload-empty-nonempty-conflict",
        &workload_conflict,
        |command, _endpoint| {
            command
                .env(workload_canonical, "")
                .env(workload_legacy, "legacy-workload-must-not-leak")
                .env(tool_legacy, "legacy-tool-must-not-leak");
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "tool-empty-nonempty-conflict",
        &tool_conflict,
        |command, endpoint| {
            command
                .env(workload_legacy, endpoint)
                .env(tool_canonical, "")
                .env(tool_legacy, "legacy-tool-must-not-leak");
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "workload-non-unicode",
        &format!("{workload_canonical} must be valid UTF-8"),
        |command, _endpoint| {
            command
                .env(workload_canonical, OsString::from_vec(vec![0xff]))
                .env(tool_legacy, "legacy-tool-must-not-leak");
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "tool-non-unicode-after-workload-resolution",
        &format!("{tool_legacy} must be valid UTF-8"),
        |command, endpoint| {
            command
                .env(workload_canonical, endpoint)
                .env(tool_legacy, OsString::from_vec(vec![0xff]));
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "missing-tool-pair",
        "are required with",
        |command, endpoint| {
            command.env(workload_canonical, endpoint);
        },
    )
    .await?;
    assert_rejected_before_workload_connection(
        "cgroup-endpoints-without-process-control",
        "require OKOU_PROCESS_CONTROL_ENDPOINT or VM0_PROCESS_CONTROL_ENDPOINT",
        |command, endpoint| {
            command
                .env_remove(process_control_ipc::CANONICAL_BOOTSTRAP_ENV)
                .env(workload_canonical, endpoint)
                .env(tool_canonical, "canonical-tool-must-not-leak");
        },
    )
    .await?;

    Ok(())
}
