//! Private, incremental access to the one canonical native Codex rollout.
//!
//! The shipped 0.153.4 writer queues raw items after normalized completions and
//! flushes them before turn completion. A missing row is not evidence of public
//! text: the caller waits for that barrier, then retains native safe output.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

use guest_contracts::codex_thread_id::canonical_codex_thread_id;
use guest_contracts::session_history_identity::SessionHistorySourceRef;
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::session_history::resolve_session_history_from_source;

const MAX_RECORD: usize = 4 * 1024 * 1024;
const MAX_RUN_READ: usize = 64 * 1024 * 1024;
pub(super) const MAX_TEXT: usize = 1024 * 1024;

#[derive(Clone)]
pub(super) struct MessageIdentity {
    pub(super) turn: String,
    pub(super) item: String,
    pub(super) phase: String,
}

#[derive(Deserialize)]
struct Record<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    #[serde(borrow)]
    payload: &'a RawValue,
}

#[derive(Deserialize)]
struct MessageHead<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    id: Option<&'a str>,
    role: Option<&'a str>,
    phase: Option<&'a str>,
    #[serde(borrow)]
    internal_chat_message_metadata_passthrough: Option<MessageMetadata<'a>>,
}

#[derive(Deserialize)]
struct MessageMetadata<'a> {
    turn_id: Option<&'a str>,
}

#[derive(Deserialize)]
struct MessageText {
    content: Vec<TextPart>,
}

#[derive(Deserialize)]
struct TextPart {
    #[serde(rename = "type")]
    kind: String,
    text: String,
}

pub(super) struct CitationSource {
    reader: BufReader<File>,
    line: Vec<u8>,
    read_bytes: usize,
}

impl CitationSource {
    pub(super) fn open(source: &SessionHistorySourceRef, resumed: bool) -> Result<Self, ()> {
        let SessionHistorySourceRef::Codex { thread_id, .. } = source else {
            return Err(());
        };
        let mut resolved = resolve_session_history_from_source(source).map_err(|_| ())?;
        // Active native rollouts are plain JSONL. Do not decode an entire
        // compressed archive or fall back to another session for this repair.
        let file = resolved
            .plain_file_mut()
            .ok_or(())?
            .try_clone()
            .map_err(|_| ())?;
        let mut result = Self {
            reader: BufReader::new(file),
            line: Vec::new(),
            read_bytes: 0,
        };
        if !result.read_line()? {
            return Err(());
        }
        let record: Record<'_> = serde_json::from_slice(&result.line).map_err(|_| ())?;
        #[derive(Deserialize)]
        struct SessionMeta<'a> {
            id: &'a str,
        }
        let meta: SessionMeta<'_> = serde_json::from_str(record.payload.get()).map_err(|_| ())?;
        if record.kind != "session_meta"
            || canonical_codex_thread_id(meta.id).as_deref() != Some(thread_id)
        {
            return Err(());
        }
        result.line.clear();
        if resumed {
            // Establish this cursor before turn/start; never scan old history.
            result.reader.seek(SeekFrom::End(0)).map_err(|_| ())?;
        }
        result.read_bytes = 0;
        Ok(result)
    }

    fn read_line(&mut self) -> Result<bool, ()> {
        let budget = MAX_RECORD.checked_sub(self.line.len()).ok_or(())?;
        let read = self
            .reader
            .by_ref()
            .take((budget + 1) as u64)
            .read_until(b'\n', &mut self.line)
            .map_err(|_| ())?;
        self.read_bytes = self.read_bytes.checked_add(read).ok_or(())?;
        if self.line.len() > MAX_RECORD || self.read_bytes > MAX_RUN_READ {
            return Err(());
        }
        Ok(self.line.last() == Some(&b'\n'))
    }

    pub(super) fn find(&mut self, identity: &MessageIdentity) -> Result<Option<String>, ()> {
        while self.read_line()? {
            let result = matching_text(&self.line, identity);
            self.line.clear();
            if let Some(text) = result? {
                return Ok(Some(text));
            }
        }
        Ok(None)
    }
}

fn matching_text(line: &[u8], identity: &MessageIdentity) -> Result<Option<String>, ()> {
    let record: Record<'_> = serde_json::from_slice(line).map_err(|_| ())?;
    if record.kind != "response_item" {
        return Ok(None);
    }
    let head: MessageHead<'_> = serde_json::from_str(record.payload.get()).map_err(|_| ())?;
    if head.kind != "message"
        || head.id != Some(identity.item.as_str())
        || head.role != Some("assistant")
    {
        return Ok(None);
    }
    let turn = head
        .internal_chat_message_metadata_passthrough
        .and_then(|metadata| metadata.turn_id);
    if turn != Some(identity.turn.as_str()) {
        return Ok(None);
    }
    if head.phase != Some(identity.phase.as_str()) {
        return Err(());
    }
    // Deserialize content only after all identity/role/phase checks. Unknown
    // fields, reasoning, tool payloads and other roles never become text.
    let message: MessageText = serde_json::from_str(record.payload.get()).map_err(|_| ())?;
    let mut text = String::new();
    for part in message.content {
        if part.kind != "output_text" || text.len().saturating_add(part.text.len()) > MAX_TEXT {
            return Err(());
        }
        text.push_str(&part.text);
    }
    Ok(Some(text))
}
