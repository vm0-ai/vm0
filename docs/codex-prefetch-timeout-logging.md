# Codex catalog prefetch timeout diagnostics

The Codex OAuth model-catalog prefetch is optional, supervised work. Its
10-second guest execution deadline is separate from the one-second process
start deadline and the bounded host terminal wait.

The prefetch marks its host-side process request with `timeout_is_expected`.
The guest-control client registers that intent before writing the start frame.
A guest `TimedOut` terminal result without diagnostic text, stdout/stderr
truncation, or stream overflow is logged at **info** with
`terminal_reason=expected_timeout`. The result is still `TimedOut`, and
`runner_codex_model_catalog_prefetch` still records an unsuccessful
`process_timed_out` outcome and the guest duration. The main Agent result is
independent.

This is a host terminal-log classification, not a timeout extension or an error
filter. Ordinary workloads and Agents retain timeout warnings. Diagnostic text,
output loss, unexpected cancellation, start/wait failures, and transport errors
retain their existing classification. In particular, a start timeout after a
possible frame write still makes the sandbox unusable; its retirement and
replacement rules are unchanged.

Runner's existing Axiom layer ingests WARN+ tracing events, so the expected info
event stays in local Runner logs, not the central warning feed. The Runner's
Sentry integration reports panics, not these terminal tracing events. Guest
control-server stderr forensic tags are separate and unchanged. No guest wire,
API, persisted state, or independently deployed protocol is modified.

## Rollout verification

Keep [#32753](https://github.com/vm0-ai/vm0/issues/32753) open after the code PR.
The original sanitized event has no run ID; it does not prove the historical
main run succeeded.

After the containing Runner artifact is promoted, record its version and observe
a 24-hour window, separating draining older versions. Correlate prefetch
`process_timed_out` telemetry with main-run completion where identifiers are
available. Check that clean expected prefetch timeouts do not generate host
warn/error events, while actual process/connection failures remain actionable.
Absence of warnings without any exercised timeout is not recovery evidence;
record that limitation or supplement with a controlled validation.
