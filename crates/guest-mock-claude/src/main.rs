//! Mock Claude CLI for testing.
//!
//! Executes the prompt as a bash command and outputs Claude-compatible JSONL.
//! This is the Rust equivalent of `mock-claude.ts` for Firecracker VMs.
//!
//! Usage: mock-claude [options] <prompt>
//!
//! Special test prefixes:
//!   @fail:<message>           - Output message to stderr and exit with code 1
//!   @fail-no-newline:<message>
//!                             - Output message to stderr without a trailing
//!                               newline and exit with code 1
//!   @fail-invalid-utf8        - Output invalid UTF-8 bytes to stderr and exit
//!                               with code 1
//!   @fail-invalid-utf8-long   - Output many invalid UTF-8 bytes to stderr and exit
//!                               with code 1
//!   @stuck-tool               - Emit WebFetch tool_use then hang (test stuck-tool watchdog)
//!   @stuck-tool-deaf          - Same, but ignores SIGTERM so only SIGKILL
//!                               can terminate it
//!   @stuck-tool-closed-stdout-deaf
//!                             - Same, but closes stdout before hanging
//!   @orphan-pipe              - Emit events, spawn child holding stdout, then exit
//!   @hang-after-result        - Emit result event, then hang the process
//!                               (SIGTERM kills it -> exits with 143; tests
//!                               the SigtermPending->Done reap path)
//!   @hang-after-result-deaf   - Same, but ignores SIGTERM so only SIGKILL
//!                               can terminate it; tests the
//!                               SigkillPending->Done escalation path
//!   @exit-after-result        - Emit result event, exit(0) immediately;
//!                               tests that reap stays no-op on the
//!                               happy path
//!   @write-env-json:<path>    - Write current process env as JSON to path,
//!                               emit result, and exit(0)
//!   @ECHO@                    - First-line marker. Validate remaining non-empty
//!                               lines as JSONL and emit them unchanged.

mod args;
mod process;
mod scenario;
mod transcript;

fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = args::parse_args(&args);

    process::run(parsed)
}
