//! Ordered public projection of eligible native assistant delimiter examples.

use std::collections::{HashSet, VecDeque};
use std::path::Path;

use guest_contracts::session_history_identity::SessionHistorySourceRef;
use guest_telemetry::log_warn;
use serde_json::Value;

use super::codex_citation_source::{CitationSource, MAX_TEXT, MessageIdentity};
use super::pi_memory_citation::{CLOSE, OPEN, project_segments};

#[cfg(test)]
mod tests;

const MAX_PENDING_EVENTS: usize = 128;
const MAX_PENDING_BYTES: usize = 16 * 1024 * 1024;
const MAX_ITEMS: usize = 4096;

struct PendingEvent {
    event: Value,
    identity: Option<MessageIdentity>,
    bytes: usize,
}

#[derive(Default)]
pub(super) struct NativeCitationRepair {
    source_ref: Option<SessionHistorySourceRef>,
    source: Option<CitationSource>,
    deferred_open: bool,
    attempted_open: bool,
    pending: VecDeque<PendingEvent>,
    pending_bytes: usize,
    seen: HashSet<(String, String)>,
    diagnostic_emitted: bool,
    disabled: bool,
}

impl NativeCitationRepair {
    pub(super) fn new(home: &str, thread_id: &str, resumed: bool) -> Self {
        let source_ref = SessionHistorySourceRef::Codex {
            sessions_dir: Path::new(home)
                .join("sessions")
                .to_string_lossy()
                .into_owned(),
            thread_id: thread_id.to_string(),
        };
        let source = CitationSource::open(&source_ref, resumed).ok();
        let deferred_open = !resumed && source.is_none();
        Self {
            source_ref: Some(source_ref),
            source,
            deferred_open,
            ..Self::default()
        }
    }

    pub(super) fn submit(
        &mut self,
        event: Value,
        phase: Option<&str>,
        terminal: bool,
    ) -> Vec<Value> {
        if self.source_ref.is_none() {
            return vec![event];
        }
        let identity = candidate_identity(&event, phase);
        if let Some(identity) = &identity
            && !self.disabled
        {
            if !self
                .seen
                .insert((identity.turn.clone(), identity.item.clone()))
            {
                return self.drain(terminal);
            }
            if self.seen.len() >= MAX_ITEMS {
                self.disabled = true;
            }
        }
        if self.pending.is_empty() && (identity.is_none() || self.disabled) {
            return vec![event];
        }
        let bytes = event.to_string().len();
        if self.pending.len() >= MAX_PENDING_EVENTS
            || self.pending_bytes.saturating_add(bytes) > MAX_PENDING_BYTES
        {
            self.disabled = true;
            self.diagnostic();
            let mut output = self.drain(true);
            output.push(event);
            return output;
        }
        self.pending_bytes = self.pending_bytes.saturating_add(bytes);
        self.pending.push_back(PendingEvent {
            event,
            identity,
            bytes,
        });
        self.drain(terminal)
    }

    pub(super) fn drain(&mut self, terminal: bool) -> Vec<Value> {
        let mut output = Vec::new();
        if self.pending.is_empty() {
            return output;
        }
        if self.deferred_open && (!self.attempted_open || terminal) {
            if let Some(source_ref) = &self.source_ref {
                self.source = CitationSource::open(source_ref, false).ok();
            }
            // One bounded lookup after the first completed message, then one
            // final attempt at the native flush barrier if still unavailable.
            if self.source.is_some() || terminal {
                self.deferred_open = false;
            }
            self.attempted_open = true;
        }
        while let Some(pending) = self.pending.front_mut() {
            if let Some(identity) = &pending.identity {
                let evidence = if self.disabled {
                    Err(())
                } else {
                    match &mut self.source {
                        Some(source) => source.find(identity),
                        None => Ok(None),
                    }
                };
                match evidence {
                    Ok(Some(raw)) => {
                        if let Some(text) = pending.event.pointer_mut("/item/text")
                            && let Some(normalized) = text.as_str()
                            && let Some(repaired) = repair_text(&raw, normalized)
                        {
                            *text = Value::String(repaired);
                        } else {
                            self.diagnostic();
                        }
                    }
                    Ok(None) if !terminal && !self.disabled => break,
                    _ => self.diagnostic(),
                }
            }
            if let Some(pending) = self.pending.pop_front() {
                self.pending_bytes -= pending.bytes;
                output.push(pending.event);
            }
        }
        output
    }

    pub(super) fn abandon(&mut self) -> Vec<Value> {
        // Cancellation/process failure has no successful native flush barrier.
        // Release only the original normalized events and keep terminal status.
        self.disabled = true;
        self.drain(true)
    }

    fn diagnostic(&mut self) {
        if !self.diagnostic_emitted {
            log_warn!(
                super::LOG_TAG,
                "Native citation literal repair unavailable; preserving native projection"
            );
            self.diagnostic_emitted = true;
        }
    }
}

fn candidate_identity(event: &Value, phase: Option<&str>) -> Option<MessageIdentity> {
    if event.get("type")?.as_str()? != "item.completed"
        || event.pointer("/item/type")?.as_str()? != "agent_message"
    {
        return None;
    }
    let text = event.pointer("/item/text")?.as_str()?;
    if text.len() > MAX_TEXT || (!text.contains('`') && !text.contains('~')) {
        return None;
    }
    let phase = phase.filter(|phase| matches!(*phase, "commentary" | "final_answer"))?;
    let turn = event.get("turn_id")?.as_str()?;
    let item = event.pointer("/item/id")?.as_str()?;
    if turn.is_empty() || item.is_empty() || turn.len() > 128 || item.len() > 128 {
        return None;
    }
    Some(MessageIdentity {
        turn: turn.to_string(),
        item: item.to_string(),
        phase: phase.to_string(),
    })
}

fn repair_text(raw: &str, normalized: &str) -> Option<String> {
    // Native contributors and plan-mode projection remain authoritative. Never
    // restore text in a message containing native plan controls, even if a
    // preceding citation would also have hidden those controls from comparison.
    if raw.contains("<proposed_plan>")
        || raw.contains("</proposed_plan>")
        || native_citation_projection(raw) != normalized
    {
        return None;
    }
    Some(project_segments(&[raw]).visible_segments.concat())
}

/// Pinned native literal-only behavior (OpenAI Codex 0.153.4, Apache-2.0).
/// Unlike the platform's public defense, native leaves a stray closing marker unchanged.
fn native_citation_projection(mut text: &str) -> String {
    let mut visible = String::new();
    while let Some((before, body)) = text.split_once(OPEN) {
        visible.push_str(before);
        let Some((_, after)) = body.split_once(CLOSE) else {
            return visible;
        };
        text = after;
    }
    visible.push_str(text);
    visible
}
