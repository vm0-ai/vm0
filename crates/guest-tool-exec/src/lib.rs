//! Explicit shell-tool launcher and runtime hook adapter for VM0 guests.

use std::env;
use std::ffi::{OsStr, OsString};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path};
use std::process::{Command, ExitCode};
use std::time::Duration;

use guest_contracts::process_containment::{
    CANONICAL_TOOL_CGROUP_PROCS_ENV, EXEC_CGROUP_NAME_PREFIX, RUNTIME_CGROUP_NAME,
    TOOL_CGROUP_PROCS_ENDPOINT_ENV, TOOL_EXEC_PATH, WORKLOAD_CGROUP_NAME,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use shell_quote::quote_shell_arg;

const BASH_PATH: &str = "/bin/bash";
const HOOK_MODE: &str = "hook";
const SHELL_OPTION: &str = "--shell";
const PROC_SELF_CGROUP: &str = "/proc/self/cgroup";
const PLACEMENT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
struct PreToolUseInput {
    hook_event_name: String,
    tool_name: String,
    tool_input: Map<String, Value>,
}

/// Rewrite managed runtime shell tools or execute one in its assigned cgroup.
pub fn run() -> ExitCode {
    if env::args_os().nth(1).as_deref() == Some(OsStr::new(HOOK_MODE)) {
        return run_pre_tool_use_hook();
    }

    if let Err(error) = place_managed_tool() {
        eprintln!("guest tool exec: placement failed: {error}");
        return ExitCode::from(125);
    }

    let error = exec_shell();
    eprintln!("guest tool exec: failed to exec shell: {error}");
    ExitCode::from(126)
}

fn run_pre_tool_use_hook() -> ExitCode {
    match rewrite_pre_tool_use_hook(&mut io::stdin().lock(), &mut io::stdout().lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("guest tool exec: hook rewrite failed: {error}");
            if write_hook_denial(&mut io::stdout().lock(), &error.to_string()).is_ok() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(125)
            }
        }
    }
}

fn rewrite_pre_tool_use_hook(input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    let mut payload = String::new();
    input.read_to_string(&mut payload)?;
    let mut input: PreToolUseInput = serde_json::from_str(&payload).map_err(io::Error::other)?;
    if input.hook_event_name != "PreToolUse" || input.tool_name != "Bash" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a PreToolUse Bash hook payload",
        ));
    }
    let command = input
        .tool_input
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Bash command is missing"))?;
    if command.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Bash command contains a null byte",
        ));
    }
    let wrapped = format!(
        "exec {} {} \"$0\" -c {}",
        quote_shell_arg(TOOL_EXEC_PATH),
        SHELL_OPTION,
        quote_shell_arg(command)
    );
    input
        .tool_input
        .insert("command".to_string(), Value::String(wrapped));
    write_hook_output(output, Value::Object(input.tool_input))
}

fn write_hook_output(output: &mut impl Write, updated_input: Value) -> io::Result<()> {
    serde_json::to_writer(
        &mut *output,
        &json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "updatedInput": updated_input,
            }
        }),
    )?;
    output.write_all(b"\n")
}

fn write_hook_denial(output: &mut impl Write, reason: &str) -> io::Result<()> {
    serde_json::to_writer(
        &mut *output,
        &json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": format!("VM0 could not isolate this shell tool: {reason}"),
            }
        }),
    )?;
    output.write_all(b"\n")
}

fn place_managed_tool() -> io::Result<()> {
    if !current_process_is_runtime()? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "tool executor was not launched from the managed runtime cgroup",
        ));
    }
    let endpoint = tool_placement_endpoint_from_process_env()?;
    place_current_process(&endpoint)
}

/// Resolve Stage 1 compatibility between managed CLI children and this tool
/// reader. Existing runners and reusable sandboxes can run for the two-hour
/// guest runtime budget plus bounded finalization. #28914 owns the later
/// writer-cutover and reader-removal follow-ups; remove the legacy branch only
/// after the reader floor, drain, rollback window, and legacy-read-zero gates.
fn tool_placement_endpoint_from_process_env() -> io::Result<String> {
    let canonical = env::var_os(CANONICAL_TOOL_CGROUP_PROCS_ENV);
    let legacy = env::var_os(TOOL_CGROUP_PROCS_ENDPOINT_ENV);
    resolve_tool_placement_endpoint(canonical, legacy)
}

fn resolve_tool_placement_endpoint(
    canonical: Option<OsString>,
    legacy: Option<OsString>,
) -> io::Result<String> {
    let canonical = tool_placement_endpoint_value(canonical)?;
    let legacy = tool_placement_endpoint_value(legacy)?;
    let endpoint = match (canonical, legacy) {
        (None, None) => {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "managed runtime is missing the tool placement endpoint",
            ));
        }
        (Some(endpoint), None) | (None, Some(endpoint)) => endpoint,
        (Some(canonical), Some(legacy)) if canonical == legacy => canonical,
        (Some(_), Some(_)) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "conflicting tool placement environment aliases: canonical_key={} \
                     legacy_key={} state=conflict",
                    CANONICAL_TOOL_CGROUP_PROCS_ENV, TOOL_CGROUP_PROCS_ENDPOINT_ENV
                ),
            ));
        }
    };
    if endpoint.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "tool placement endpoint is empty",
        ));
    }
    Ok(endpoint)
}

fn tool_placement_endpoint_value(value: Option<OsString>) -> io::Result<Option<String>> {
    value
        .map(|value| {
            value.into_string().map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "tool placement endpoint is not valid UTF-8",
                )
            })
        })
        .transpose()
}

fn current_process_is_runtime() -> io::Result<bool> {
    let contents = std::fs::read_to_string(PROC_SELF_CGROUP)?;
    let Some(path) = contents.lines().find_map(|line| line.strip_prefix("0::")) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "current unified cgroup path is missing",
        ));
    };
    Ok(is_canonical_runtime_path(Path::new(path)))
}

fn is_canonical_runtime_path(path: &Path) -> bool {
    let components = path.components().collect::<Vec<_>>();
    let [
        Component::RootDir,
        Component::Normal(base),
        Component::Normal(operation),
        Component::Normal(workload),
        Component::Normal(runtime),
    ] = components.as_slice()
    else {
        return false;
    };
    *base == "vm0-exec"
        && operation
            .as_encoded_bytes()
            .starts_with(EXEC_CGROUP_NAME_PREFIX.as_bytes())
        && *workload == WORKLOAD_CGROUP_NAME
        && *runtime == RUNTIME_CGROUP_NAME
}

fn place_current_process(endpoint: &str) -> io::Result<()> {
    let stream = process_control_ipc::connect_abstract(endpoint)?;
    stream.set_read_timeout(Some(PLACEMENT_TIMEOUT))?;
    stream.set_write_timeout(Some(PLACEMENT_TIMEOUT))?;
    let placement = process_control_ipc::receive_tool_placement(&stream)?;
    write_self_to_cgroup(&placement)?;
    drop(placement);
    process_control_ipc::write_tool_placement_confirmation(&stream)?;
    process_control_ipc::read_tool_placement_ack(&stream)
}

fn write_self_to_cgroup(placement: &OwnedFd) -> io::Result<()> {
    loop {
        // SAFETY: `placement` is open for writing and the one-byte buffer is
        // valid for the duration of the call.
        let written = unsafe { libc::write(placement.as_raw_fd(), b"0".as_ptr().cast(), 1) };
        if written == 1 {
            return Ok(());
        }
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
}

fn exec_shell() -> io::Error {
    let mut arguments = env::args_os().skip(1).collect::<Vec<_>>();
    let shell = if arguments
        .first()
        .is_some_and(|arg| arg == OsStr::new(SHELL_OPTION))
    {
        let _ = arguments.remove(0);
        if arguments.is_empty() {
            return io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{SHELL_OPTION} requires a shell executable"),
            );
        }
        arguments.remove(0)
    } else {
        OsString::from(BASH_PATH)
    };
    if shell.is_empty() {
        return io::Error::new(io::ErrorKind::InvalidInput, "shell executable is empty");
    }
    let mut command = Command::new(shell);
    command.args(arguments);
    command.exec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::ffi::OsStringExt;

    #[test]
    fn recognizes_only_canonical_runtime_leaf() {
        assert!(is_canonical_runtime_path(Path::new(
            "/vm0-exec/exec-12-34/workload/runtime"
        )));
        assert!(!is_canonical_runtime_path(Path::new(
            "/vm0-exec/exec-12-34/workload/tools/tool-1"
        )));
        assert!(!is_canonical_runtime_path(Path::new(
            "/vm0-exec/not-an-operation/workload/runtime"
        )));
        assert!(!is_canonical_runtime_path(Path::new("/workload/runtime")));
    }

    #[test]
    fn self_placement_writes_kernel_self_selector() {
        use std::io::{Read, Seek, SeekFrom};

        let mut file = tempfile::tempfile().unwrap();
        let placement: OwnedFd = file.try_clone().unwrap().into();
        write_self_to_cgroup(&placement).unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut contents = String::new();
        file.read_to_string(&mut contents).unwrap();
        assert_eq!(contents, "0");
    }

    #[test]
    fn resolves_tool_placement_aliases_and_preserves_empty_validation() {
        for (name, canonical, legacy, expected) in [
            (
                "canonical-only",
                Some("canonical-endpoint"),
                None,
                "canonical-endpoint",
            ),
            (
                "legacy-only",
                None,
                Some("legacy-endpoint"),
                "legacy-endpoint",
            ),
            (
                "equal-dual",
                Some("shared-endpoint"),
                Some("shared-endpoint"),
                "shared-endpoint",
            ),
        ] {
            let endpoint = resolve_tool_placement_endpoint(
                canonical.map(OsString::from),
                legacy.map(OsString::from),
            )
            .unwrap();
            assert_eq!(endpoint, expected, "{name} resolved incorrectly");
        }

        for (name, canonical, legacy) in [
            ("canonical-empty", Some(""), None),
            ("legacy-empty", None, Some("")),
            ("dual-empty", Some(""), Some("")),
        ] {
            let error = resolve_tool_placement_endpoint(
                canonical.map(OsString::from),
                legacy.map(OsString::from),
            )
            .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            assert_eq!(
                error.to_string(),
                "tool placement endpoint is empty",
                "{name}"
            );
        }
    }

    #[test]
    fn rejects_tool_placement_conflicts_and_invalid_encoding_without_values() {
        let conflict = resolve_tool_placement_endpoint(
            Some(OsString::from("canonical-must-not-leak")),
            Some(OsString::from("legacy-must-not-leak")),
        )
        .unwrap_err();
        assert_eq!(conflict.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(
            conflict.to_string(),
            format!(
                "conflicting tool placement environment aliases: canonical_key={} \
                 legacy_key={} state=conflict",
                CANONICAL_TOOL_CGROUP_PROCS_ENV, TOOL_CGROUP_PROCS_ENDPOINT_ENV
            )
        );
        assert!(!conflict.to_string().contains("must-not-leak"));

        for (name, canonical, legacy) in [
            (
                "canonical-non-unicode",
                Some(OsString::from_vec(vec![0xff])),
                None,
            ),
            (
                "legacy-non-unicode",
                None,
                Some(OsString::from_vec(vec![0xff])),
            ),
            (
                "readable-with-non-unicode",
                Some(OsString::from("canonical-must-not-leak")),
                Some(OsString::from_vec(vec![0xff])),
            ),
        ] {
            let error = resolve_tool_placement_endpoint(canonical, legacy).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{name}");
            assert_eq!(
                error.to_string(),
                "tool placement endpoint is not valid UTF-8",
                "{name}"
            );
            assert!(!error.to_string().contains("must-not-leak"), "{name}");
        }

        for (name, canonical, legacy) in [
            ("canonical-empty", "", "legacy-must-not-leak"),
            ("legacy-empty", "canonical-must-not-leak", ""),
        ] {
            let error = resolve_tool_placement_endpoint(
                Some(OsString::from(canonical)),
                Some(OsString::from(legacy)),
            )
            .unwrap_err();
            assert_eq!(error.to_string(), conflict.to_string(), "{name}");
            assert!(!error.to_string().contains("must-not-leak"), "{name}");
        }
    }

    #[test]
    fn hook_wraps_command_and_preserves_other_bash_fields() {
        let mut output = Vec::new();
        rewrite_pre_tool_use_hook(
            &mut br#"{
                "hook_event_name":"PreToolUse",
                "tool_name":"Bash",
                "tool_input":{
                    "command":"printf '%s\\n' \"$HOME\"",
                    "description":"print home",
                    "timeout":120000,
                    "run_in_background":false
                }
            }"#
            .as_slice(),
            &mut output,
        )
        .unwrap();

        let output: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(
            output["hookSpecificOutput"]["updatedInput"],
            json!({
                "command": "exec '/usr/local/bin/guest-tool-exec' --shell \"$0\" -c 'printf '\\''%s\\n'\\'' \"$HOME\"'",
                "description": "print home",
                "timeout": 120000,
                "run_in_background": false,
            })
        );
        assert_eq!(output["hookSpecificOutput"]["permissionDecision"], "allow");
    }

    #[test]
    fn malformed_hook_payload_fails_closed() {
        let error = rewrite_pre_tool_use_hook(
            &mut br#"{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{}}"#
                .as_slice(),
            &mut Vec::new(),
        )
        .unwrap_err();
        let mut output = Vec::new();
        write_hook_denial(&mut output, &error.to_string()).unwrap();
        let output: Value = serde_json::from_slice(&output).unwrap();

        assert_eq!(output["hookSpecificOutput"]["permissionDecision"], "deny");
        assert!(
            output["hookSpecificOutput"]["permissionDecisionReason"]
                .as_str()
                .unwrap()
                .contains("expected a PreToolUse Bash hook payload")
        );
    }
}
