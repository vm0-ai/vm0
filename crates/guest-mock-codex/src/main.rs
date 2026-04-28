//! Mock Codex CLI for testing.
//!
//! Emits Codex `exec --json` protocol events on stdout and persists a
//! zstd-compressed JSONL session file at the same path layout the real
//! Codex CLI uses (`$CODEX_HOME/sessions/YYYY/MM/DD/<thread_id>.jsonl.zst`).
//!
//! Activated in guest VMs via `USE_MOCK_CODEX=true` (handled by guest-agent).
//! This binary itself runs whenever it's invoked — the env-var dispatch lives
//! in the consumer.
//!
//! Usage (mirrors real Codex CLI):
//!   guest-mock-codex exec [--json] [--sandbox <mode>] [--skip-git-repo-check]
//!                          [-C <dir>] [-m <model>] [--append-system-prompt <s>]
//!                          [--last] [-- <prompt>]
//!   guest-mock-codex exec resume <thread_id> [-- <prompt>]

use chrono::{NaiveDate, Utc};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Parser, Debug)]
#[command(name = "guest-mock-codex", version)]
struct Cli {
    #[command(subcommand)]
    command: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Mirrors `codex exec`.
    Exec(ExecArgs),
}

#[derive(clap::Args, Debug)]
struct ExecArgs {
    #[command(subcommand)]
    sub: Option<ExecSub>,

    /// Emit JSONL output (accepted, mock always emits JSONL).
    #[arg(long)]
    json: bool,

    /// Sandbox mode (accepted, ignored).
    #[arg(long)]
    sandbox: Option<String>,

    /// Skip git-repo check (accepted, ignored).
    #[arg(long = "skip-git-repo-check")]
    skip_git_repo_check: bool,

    /// Working directory (accepted, ignored — mock writes session file under
    /// `$CODEX_HOME` regardless).
    #[arg(short = 'C', long = "cd")]
    cwd: Option<PathBuf>,

    /// Model override (accepted, ignored).
    #[arg(short = 'm', long)]
    model: Option<String>,

    /// Append-system-prompt (accepted, ignored).
    #[arg(long = "append-system-prompt")]
    append_system_prompt: Option<String>,

    /// Resume the most recent session (accepted, ignored — mock requires an
    /// explicit id via `resume <id>`).
    #[arg(long)]
    last: bool,

    /// Trailing positional prompt (everything after `--`, or after recognised
    /// flags). May be empty.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    prompt: Vec<String>,
}

#[derive(Subcommand, Debug)]
enum ExecSub {
    /// Mirrors `codex exec resume <thread_id>`.
    Resume {
        thread_id: String,

        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        prompt: Vec<String>,
    },
}

fn main() -> io::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Cmd::Exec(ExecArgs {
            sub: Some(ExecSub::Resume { thread_id, prompt }),
            ..
        }) => run(&thread_id, &join_prompt(&prompt), true),
        Cmd::Exec(ExecArgs { prompt, .. }) => {
            let id = Uuid::now_v7().to_string();
            run(&id, &join_prompt(&prompt), false)
        }
    }
}

/// Join trailing positional args into a single prompt string. A leading `--`
/// separator (sometimes left in by clap when `trailing_var_arg` is set) is
/// dropped.
fn join_prompt(parts: &[String]) -> String {
    let mut iter = parts.iter().peekable();
    if let Some(first) = iter.peek()
        && first.as_str() == "--"
    {
        iter.next();
    }
    iter.cloned().collect::<Vec<_>>().join(" ")
}

/// Resolve the Codex home directory, mirroring real Codex CLI precedence:
/// `$CODEX_HOME` > `$HOME/.codex` > `/home/user/.codex`.
fn codex_home() -> PathBuf {
    if let Ok(dir) = std::env::var("CODEX_HOME")
        && !dir.is_empty()
    {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/user".to_string());
    PathBuf::from(home).join(".codex")
}

/// Build the session file path, with `today` injected for testability.
///
/// Layout: `<codex_home>/sessions/YYYY/MM/DD/<thread_id>.jsonl.zst`
fn build_session_path(codex_home: &Path, today: NaiveDate, thread_id: &str) -> PathBuf {
    let yyyy = today.format("%Y").to_string();
    let mm = today.format("%m").to_string();
    let dd = today.format("%d").to_string();
    codex_home
        .join("sessions")
        .join(yyyy)
        .join(mm)
        .join(dd)
        .join(format!("{thread_id}.jsonl.zst"))
}

/// Build the three-event sequence the mock emits for a single turn.
fn build_events(thread_id: &str, prompt: &str) -> [Value; 3] {
    [
        json!({"type": "thread.started", "thread_id": thread_id}),
        json!({
            "type": "item.completed",
            "item": {"type": "agent_message", "text": prompt}
        }),
        json!({
            "type": "turn.completed",
            "usage": {"input_tokens": 10, "output_tokens": 20}
        }),
    ]
}

/// Write events as one JSON object per line to the writer, flushing at end.
fn emit_events<W: Write>(out: &mut W, events: &[Value]) -> io::Result<()> {
    for ev in events {
        writeln!(out, "{ev}")?;
    }
    out.flush()
}

/// Encode events as zstd-compressed JSONL and atomically write to `path`,
/// creating parent directories as needed.
fn write_session_file(path: &Path, events: &[Value]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut buf = Vec::new();
    for ev in events {
        writeln!(buf, "{ev}")?;
    }
    let compressed = zstd::encode_all(buf.as_slice(), 3)?;
    let tmp = path.with_extension("zst.tmp");
    fs::write(&tmp, compressed)?;
    fs::rename(&tmp, path)
}

/// Read a zstd-compressed JSONL session file into parsed `Value` events.
/// Used both by `append_session_file` (read-modify-write) and tests.
fn read_session_file(path: &Path) -> io::Result<Vec<Value>> {
    let bytes = fs::read(path)?;
    let mut decoder = zstd::Decoder::new(bytes.as_slice())?;
    let mut decoded = String::new();
    decoder.read_to_string(&mut decoded)?;
    let mut out = Vec::new();
    for line in decoded.lines() {
        if line.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        out.push(v);
    }
    Ok(out)
}

/// Append `new_events` to an existing session file by reading, decompressing,
/// extending, recompressing, and atomically renaming. If the file does not
/// exist, falls back to `write_session_file` so the resume call does not fail.
fn append_session_file(path: &Path, new_events: &[Value]) -> io::Result<()> {
    let mut existing = match read_session_file(path) {
        Ok(events) => events,
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e),
    };
    existing.extend_from_slice(new_events);
    write_session_file(path, &existing)
}

/// Orchestrator: emit the three-event turn on stdout, then persist (or append)
/// to the session file under `$CODEX_HOME`.
fn run(thread_id: &str, prompt: &str, is_resume: bool) -> io::Result<()> {
    let events = build_events(thread_id, prompt);

    let mut stdout = io::stdout().lock();
    emit_events(&mut stdout, &events)?;

    let path = build_session_path(&codex_home(), Utc::now().date_naive(), thread_id);
    if is_resume {
        append_session_file(&path, &events)
    } else {
        write_session_file(&path, &events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_prompt_joins_words() {
        let parts = vec!["hello".to_string(), "world".to_string()];
        assert_eq!(join_prompt(&parts), "hello world");
    }

    #[test]
    fn join_prompt_empty() {
        assert_eq!(join_prompt(&[]), "");
    }

    #[test]
    fn join_prompt_strips_leading_double_dash() {
        let parts = vec!["--".to_string(), "hi".to_string()];
        assert_eq!(join_prompt(&parts), "hi");
    }

    #[test]
    fn join_prompt_keeps_internal_double_dash() {
        let parts = vec!["foo".to_string(), "--".to_string(), "bar".to_string()];
        assert_eq!(join_prompt(&parts), "foo -- bar");
    }

    #[test]
    fn build_session_path_zero_pads() {
        let home = Path::new("/tmp/.codex");
        let day = NaiveDate::from_ymd_opt(2026, 1, 5).unwrap();
        let p = build_session_path(home, day, "abc");
        assert_eq!(
            p,
            PathBuf::from("/tmp/.codex/sessions/2026/01/05/abc.jsonl.zst")
        );
    }

    #[test]
    fn build_session_path_typical() {
        let home = Path::new("/var/codex");
        let day = NaiveDate::from_ymd_opt(2026, 12, 31).unwrap();
        let p = build_session_path(home, day, "xyz-uuid");
        assert_eq!(
            p,
            PathBuf::from("/var/codex/sessions/2026/12/31/xyz-uuid.jsonl.zst")
        );
    }

    #[test]
    fn build_events_shape() {
        let evs = build_events("tid-1", "hello");
        assert_eq!(evs[0]["type"], "thread.started");
        assert_eq!(evs[0]["thread_id"], "tid-1");
        assert_eq!(evs[1]["type"], "item.completed");
        assert_eq!(evs[1]["item"]["type"], "agent_message");
        assert_eq!(evs[1]["item"]["text"], "hello");
        assert_eq!(evs[2]["type"], "turn.completed");
        assert_eq!(evs[2]["usage"]["input_tokens"], 10);
        assert_eq!(evs[2]["usage"]["output_tokens"], 20);
    }

    #[test]
    fn emit_events_writes_jsonl() {
        let mut buf = Vec::new();
        let evs = build_events("id-1", "echo");
        emit_events(&mut buf, &evs).unwrap();
        let text = String::from_utf8(buf).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        for line in lines {
            let _: Value = serde_json::from_str(line).unwrap();
        }
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/deep/file.jsonl.zst");
        let evs = build_events("rt-1", "hi");
        write_session_file(&path, &evs).unwrap();
        let read_back = read_session_file(&path).unwrap();
        assert_eq!(read_back.len(), 3);
        assert_eq!(read_back[0]["thread_id"], "rt-1");
    }

    #[test]
    fn append_to_missing_file_creates_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("appended.jsonl.zst");
        let evs = build_events("a-1", "first");
        append_session_file(&path, &evs).unwrap();
        let read_back = read_session_file(&path).unwrap();
        assert_eq!(read_back.len(), 3);
    }

    #[test]
    fn append_to_existing_file_extends() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("extend.jsonl.zst");
        let first = build_events("e-1", "turn-1");
        write_session_file(&path, &first).unwrap();
        let second = build_events("e-1", "turn-2");
        append_session_file(&path, &second).unwrap();
        let read_back = read_session_file(&path).unwrap();
        assert_eq!(read_back.len(), 6);
        assert_eq!(read_back[1]["item"]["text"], "turn-1");
        assert_eq!(read_back[4]["item"]["text"], "turn-2");
    }
}
