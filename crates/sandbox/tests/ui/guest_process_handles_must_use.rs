#![deny(unused_must_use)]

use sandbox::{GuestAgentProcessHandle, GuestProcessHandle, Result};

fn process_handle() -> Result<GuestProcessHandle> {
    unreachable!()
}

fn agent_process_handle() -> Result<GuestAgentProcessHandle> {
    unreachable!()
}

fn discard_process_after_unwrap() {
    process_handle().unwrap();
}

fn discard_process_after_expect() {
    process_handle().expect("process start should succeed");
}

fn discard_process_after_question_mark() -> Result<()> {
    process_handle()?;
    Ok(())
}

fn discard_agent_process_after_unwrap() {
    agent_process_handle().unwrap();
}

fn discard_agent_process_after_expect() {
    agent_process_handle().expect("Agent process start should succeed");
}

fn discard_agent_process_after_question_mark() -> Result<()> {
    agent_process_handle()?;
    Ok(())
}

fn main() {
    let _ = discard_process_after_unwrap as fn();
    let _ = discard_process_after_expect as fn();
    let _ = discard_process_after_question_mark as fn() -> Result<()>;
    let _ = discard_agent_process_after_unwrap as fn();
    let _ = discard_agent_process_after_expect as fn();
    let _ = discard_agent_process_after_question_mark as fn() -> Result<()>;
}
