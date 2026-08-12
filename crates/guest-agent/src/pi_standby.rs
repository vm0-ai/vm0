//! Guest-local controls and lifecycle contract for Pi standby execution.
//!
//! # Selection and ownership
//!
//! [`crate::cli::execute_cli_with_controls_for_config_started_at`] selects the
//! Pi branch when [`crate::env::GuestConfig`] contains all three fixed Pi
//! inputs: a system prompt, model config, and Skill snapshot. Supplying none
//! selects the configured Claude or Codex path; supplying only some of them is
//! an execution error.
//!
//! The runner's process-control connection and the Pi child's JSONL protocol
//! are separate transports. [`PiStandbyController`] recognizes runner
//! `pi-handoff` and `pi-standby-release` payloads and sends a
//! [`PiStandbySignal`] through the guest-local channel. CLI execution owns the
//! corresponding [`PiStandbyReader`] and translates those signals into JSONL
//! frames for the child.
//!
//! # Lifecycle
//!
//! The TypeScript `okou __agent-loop --standby` child and guest-agent follow
//! this sequence:
//!
//! 1. The child emits `pi-ready` with its run id, system-prompt digest, and
//!    Skill-snapshot digest. Guest-agent accepts this frame exactly once,
//!    verifies all three values against the fixed run inputs, and rejects work
//!    before it.
//! 2. Immediately after startup, the child repeatedly sends a numbered
//!    `pi-transcript-read` with its current ordinal. Guest-agent reads the next
//!    canonical transcript page with its authenticated HTTP client. A runner
//!    `pi-handoff` only accelerates the next read; an API-driven
//!    `pi-standby-release` retires an unused standby.
//! 3. When the latest persisted message belongs to the current run and is an
//!    assistant tool-use batch, the child takes over without waiting for runner
//!    control and ignores later controls. When the latest message belongs to a
//!    previous run, it does not trigger takeover even if it is a tool-use batch,
//!    so the child keeps polling. If no qualifying message is persisted before
//!    the standby TTL, the child fails and guest-agent completes the run with an
//!    error.
//! 4. The child sends each completed native message as a `pi-message` with an
//!    intended sequence and `<run-id>/<sequence>` message id. Guest-agent
//!    validates the event identity, writes it through the API, requires
//!    acknowledged sequences to advance, and returns a matching
//!    `pi-message-ack` before the child continues.
//! 5. The child finishes with `pi-complete`, `pi-released`, or `pi-error`.
//!    Completion is accepted only when the fixed digests are unchanged, its
//!    exit code is 0 or 1, and its final event sequence equals guest-agent's
//!    last acknowledged sequence. Release is limited to `api-complete`.
//!
//! Frame names, ordering, identity fields, digests, and the final
//! acknowledgement watermark form a cross-language compatibility contract
//! with `turbo/apps/cli/src/lib/pi-agent-loop.ts`; changes must keep both sides
//! in sync.
//!
//! # Security and completion
//!
//! Guest-agent removes the sandbox API token and Vercel protection-bypass
//! value from the child environment. It retains those credentials to relay
//! transcript reads and exact Pi event writes; the child still receives the
//! environment required for model execution. Native Pi event payloads bypass
//! the legacy CLI secret masker so they can be relayed unchanged. Collected
//! child stderr and a terminal `pi-complete` error are masked before they are
//! returned.
//!
//! User cancellation, heartbeat failure, timeout, or a protocol error is a
//! terminal execution failure, not a standby release. A valid `pi-complete`
//! yields [`crate::cli::CliCompletionDisposition::PiCompleted`]: top-level
//! execution completes the run but skips the normal successful CLI checkpoint
//! because acknowledged Pi events already persist its output. A valid release
//! yields [`crate::cli::CliCompletionDisposition::PiStandbyReleased`], so
//! top-level execution skips checkpoint and `/complete`. API-driven release
//! exits successfully.

use tokio::sync::mpsc;

/// Runner process-control action for the Pi standby child.
///
/// See [`crate::pi_standby`] for how these actions become child JSONL frames.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PiStandbySignal {
    /// Transfer the retained run from API-side execution to the standby child.
    Handoff,
    /// Release the standby allocation without completing the run in guest-agent.
    Release,
}

/// Guest-local channel connecting runner process control to Pi CLI execution.
///
/// The controller is cloneable for control handling; the reader is consumed
/// once by [`crate::cli::CliExecutionControls::with_pi_standby_reader`].
/// See [`crate::pi_standby`] for the end-to-end lifecycle.
pub struct PiStandbyRuntime {
    controller: PiStandbyController,
    reader: PiStandbyReader,
}

/// Cloneable sender for runner-originated Pi standby controls.
///
/// See [`crate::pi_standby`] for the end-to-end lifecycle.
#[derive(Clone)]
pub struct PiStandbyController {
    sender: mpsc::UnboundedSender<PiStandbySignal>,
}

/// Receiving half of the guest-local Pi standby control channel.
///
/// CLI execution owns this reader for the lifetime of the Pi child.
/// See [`crate::pi_standby`] for the end-to-end lifecycle.
pub struct PiStandbyReader {
    receiver: mpsc::UnboundedReceiver<PiStandbySignal>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct PiStandbyPayload {
    #[serde(rename = "type")]
    payload_type: String,
}

impl PiStandbyRuntime {
    /// Create a connected Pi standby controller and reader.
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        Self {
            controller: PiStandbyController { sender },
            reader: PiStandbyReader { receiver },
        }
    }

    /// Clone the process-control side of this runtime.
    pub fn controller(&self) -> PiStandbyController {
        self.controller.clone()
    }

    /// Consume the runtime and return its single CLI-execution reader.
    pub fn into_reader(self) -> PiStandbyReader {
        self.reader
    }
}

impl Default for PiStandbyRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl PiStandbyController {
    /// Recognize and enqueue one runner process-control payload.
    ///
    /// Returns `Ok(true)` after enqueueing `pi-handoff` or
    /// `pi-standby-release`, and `Ok(false)` when the payload is not a Pi
    /// standby control. A recognized payload returns an error when its strict
    /// shape is invalid or the receiving CLI execution has closed.
    pub fn handle_control_payload(&self, payload: &[u8]) -> Result<bool, String> {
        let Some(payload_type) = serde_json::from_slice::<serde_json::Value>(payload)
            .ok()
            .and_then(|value| value.get("type")?.as_str().map(str::to_owned))
        else {
            return Ok(false);
        };
        let signal = match payload_type.as_str() {
            "pi-handoff" => PiStandbySignal::Handoff,
            "pi-standby-release" => PiStandbySignal::Release,
            _ => return Ok(false),
        };
        let parsed: PiStandbyPayload = serde_json::from_slice(payload)
            .map_err(|error| format!("Pi standby payload is invalid: {error}"))?;
        if parsed.payload_type != payload_type {
            return Err("Pi standby payload type changed while parsing".to_string());
        }
        self.sender
            .send(signal)
            .map_err(|_| "Pi standby receiver is closed".to_string())?;
        Ok(true)
    }
}

impl PiStandbyReader {
    /// Create a reader with no sender, used when Pi controls are disabled.
    ///
    /// [`Self::recv`] returns `None` immediately for this reader.
    pub fn closed() -> Self {
        let (sender, receiver) = mpsc::unbounded_channel();
        drop(sender);
        Self { receiver }
    }

    /// Wait for the next handoff or release signal.
    ///
    /// Returns `None` after every associated controller has been dropped.
    pub async fn recv(&mut self) -> Option<PiStandbySignal> {
        self.receiver.recv().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn controls_preserve_handoff_and_release_as_distinct_signals() {
        let runtime = PiStandbyRuntime::new();
        let controller = runtime.controller();
        let mut reader = runtime.into_reader();

        assert_eq!(
            controller.handle_control_payload(br#"{"type":"pi-handoff"}"#),
            Ok(true)
        );
        assert_eq!(reader.recv().await, Some(PiStandbySignal::Handoff));
        assert_eq!(
            controller.handle_control_payload(br#"{"type":"pi-standby-release"}"#),
            Ok(true)
        );
        assert_eq!(reader.recv().await, Some(PiStandbySignal::Release));
    }
}
