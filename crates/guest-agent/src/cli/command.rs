//! CLI command construction for Claude Code and Codex.
//!
//! This module owns framework-specific argv shape, mock binary selection, and
//! Codex config override construction. Runtime process spawning stays in
//! `execute_cli`.

use crate::env;
use crate::error::AgentError;
use guest_common::log_info;

use super::LOG_TAG;

/// Build the CLI command + args based on `CLI_AGENT_TYPE`.
pub fn build_cli_command() -> Result<Vec<String>, AgentError> {
    build_cli_command_for_framework(env::Framework::from_env())
}

pub(super) fn build_cli_command_for_framework(
    framework: env::Framework,
) -> Result<Vec<String>, AgentError> {
    match framework {
        env::Framework::ClaudeCode => Ok(build_claude_command(env::use_mock_claude())),
        env::Framework::Codex => Ok(build_codex_command(env::use_mock_codex())),
    }
}

/// Build the argument list from explicit parameters (testable).
fn build_claude_args(
    resume_id: &str,
    append_system_prompt: &str,
    disallowed_tools: &str,
    tools: &str,
    settings: &str,
    prompt: &str,
) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--verbose".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    if !resume_id.is_empty() {
        log_info!(LOG_TAG, "Resuming session: {resume_id}");
        args.push("--resume".to_string());
        args.push(resume_id.to_string());
    } else {
        log_info!(LOG_TAG, "Starting new session");
    }

    if !append_system_prompt.is_empty() {
        args.push("--append-system-prompt".to_string());
        args.push(append_system_prompt.to_string());
    }

    if !disallowed_tools.is_empty() {
        args.push("--disallowed-tools".to_string());
        for tool in disallowed_tools.split(',') {
            let tool = tool.trim();
            if !tool.is_empty() {
                args.push(tool.to_string());
            }
        }
    }

    if !tools.is_empty() {
        args.push("--tools".to_string());
        for tool in tools.split(',') {
            let tool = tool.trim();
            if !tool.is_empty() {
                args.push(tool.to_string());
            }
        }
    }

    if !settings.is_empty() {
        args.push("--settings".to_string());
        args.push(settings.to_string());
    }

    // "--" terminates option parsing so Commander.js variadic options
    // (--disallowed-tools, --tools) do not consume the prompt.
    args.push("--".to_string());
    args.push(prompt.to_string());
    args
}

fn build_claude_command(use_mock: bool) -> Vec<String> {
    let args = build_claude_args(
        env::resume_session_id(),
        env::append_system_prompt(),
        env::disallowed_tools(),
        env::tools(),
        env::settings(),
        env::prompt(),
    );

    let bin = if use_mock {
        log_info!(LOG_TAG, "Using mock-claude for testing");
        // Tests can override the path so they target a cargo-built
        // artifact rather than the sandbox's baked-in `/usr/local/bin`.
        env::mock_claude_path()
    } else {
        "claude".to_string()
    };

    let mut cmd = vec![bin];
    cmd.extend(args);
    cmd
}

/// Build the codex argument list (testable).
///
/// Resume is a positional sub-subcommand (`codex exec resume <id> <prompt>`),
/// not a `--resume <id>` flag. Use `--` before the prompt so user text that
/// starts with `-` is not parsed as another codex option.
fn quote_toml_basic_string(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('"');
    for ch in value.chars() {
        match ch {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\u{08}' => quoted.push_str("\\b"),
            '\t' => quoted.push_str("\\t"),
            '\n' => quoted.push_str("\\n"),
            '\u{0C}' => quoted.push_str("\\f"),
            '\r' => quoted.push_str("\\r"),
            ch if ch.is_control() => quoted.push_str(&format!("\\u{:04X}", u32::from(ch))),
            ch => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

fn build_codex_developer_instructions_config(append_system_prompt: &str) -> String {
    let value = quote_toml_basic_string(append_system_prompt);
    format!("developer_instructions={value}")
}

fn build_codex_memories_config() -> String {
    "features.memories=true".to_string()
}

fn build_codex_args(
    working_dir: &str,
    model: &str,
    resume_id: &str,
    append_system_prompt: &str,
    prompt: &str,
) -> Vec<String> {
    let mut args = vec![
        "exec".to_string(),
        "--json".to_string(),
        "--sandbox".to_string(),
        "danger-full-access".to_string(),
        "--skip-git-repo-check".to_string(),
        "-C".to_string(),
        working_dir.to_string(),
    ];

    args.push("-c".to_string());
    args.push(build_codex_memories_config());

    if !model.is_empty() {
        args.push("-m".to_string());
        args.push(model.to_string());
    }

    if !append_system_prompt.is_empty() {
        args.push("-c".to_string());
        args.push(build_codex_developer_instructions_config(
            append_system_prompt,
        ));
    }

    if !resume_id.is_empty() {
        log_info!(LOG_TAG, "Resuming codex session: {resume_id}");
        args.push("resume".to_string());
        args.push(resume_id.to_string());
        args.push("--".to_string());
        args.push(prompt.to_string());
    } else {
        log_info!(LOG_TAG, "Starting new codex session");
        args.push("--".to_string());
        args.push(prompt.to_string());
    }

    args
}

fn build_codex_command(use_mock: bool) -> Vec<String> {
    let bin = if use_mock {
        log_info!(LOG_TAG, "Using mock-codex for testing");
        env::mock_codex_path()
    } else {
        "codex".to_string()
    };

    let mut cmd = vec![bin];
    cmd.extend(build_codex_args(
        env::working_dir(),
        env::openai_model(),
        env::resume_session_id(),
        env::append_system_prompt(),
        env::prompt(),
    ));
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disable_system_log() {
        guest_common::log::clear_system_log_file();
    }

    fn build_claude_args_for_test(
        resume_id: &str,
        append_system_prompt: &str,
        disallowed_tools: &str,
        tools: &str,
        settings: &str,
        prompt: &str,
    ) -> Vec<String> {
        disable_system_log();
        build_claude_args(
            resume_id,
            append_system_prompt,
            disallowed_tools,
            tools,
            settings,
            prompt,
        )
    }

    fn build_claude_command_for_test(use_mock: bool) -> Vec<String> {
        disable_system_log();
        build_claude_command(use_mock)
    }

    /// Assert prompt is last and preceded by "--" separator.
    fn assert_prompt_with_separator(args: &[String], expected_prompt: &str) {
        let len = args.len();
        assert!(len >= 2, "args too short: {args:?}");
        assert_eq!(
            args[len - 2],
            "--",
            "second-to-last arg must be '--': {args:?}"
        );
        assert_eq!(args[len - 1], expected_prompt);
    }

    #[test]
    fn build_claude_args_basic() {
        let args = build_claude_args_for_test("", "", "", "", "", "hello world");
        assert!(args.contains(&"--print".to_string()));
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
        assert_prompt_with_separator(&args, "hello world");
        assert!(!args.contains(&"--append-system-prompt".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_claude_args_with_append_system_prompt() {
        let args = build_claude_args_for_test("", "Your name is Aria.", "", "", "", "analyze this");
        let asp_idx = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
        assert_eq!(args[asp_idx + 1], "Your name is Aria.");
        assert_prompt_with_separator(&args, "analyze this");
    }

    #[test]
    fn build_claude_args_empty_append_system_prompt_omitted() {
        let args = build_claude_args_for_test("", "", "", "", "", "test");
        assert!(!args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn build_claude_args_with_resume_and_append() {
        let args = build_claude_args_for_test("sess-123", "Be helpful.", "", "", "", "prompt");
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"--append-system-prompt".to_string()));
        assert_prompt_with_separator(&args, "prompt");
    }

    #[test]
    fn build_claude_command_uses_claude_binary() {
        let cmd = build_claude_command_for_test(false);
        assert_eq!(cmd[0], "claude");
    }

    #[test]
    fn build_claude_command_uses_mock_binary() {
        // Unit tests run in the lib-test binary where
        // `VM0_MOCK_CLAUDE_PATH` is unset, so `env::mock_claude_path()`
        // falls through to `DEFAULT_MOCK_CLAUDE_PATH`. Asserting
        // against the const (not the accessor) catches regressions in
        // the default path itself — the previous form compared the
        // accessor against itself and was tautological.
        let cmd = build_claude_command_for_test(true);
        assert_eq!(cmd[0], env::DEFAULT_MOCK_CLAUDE_PATH);
    }

    fn build_codex_args_for_test(
        working_dir: &str,
        model: &str,
        resume_id: &str,
        prompt: &str,
    ) -> Vec<String> {
        disable_system_log();
        build_codex_args(working_dir, model, resume_id, "", prompt)
    }

    fn build_codex_args_with_append_for_test(
        working_dir: &str,
        model: &str,
        resume_id: &str,
        append_system_prompt: &str,
        prompt: &str,
    ) -> Vec<String> {
        disable_system_log();
        build_codex_args(working_dir, model, resume_id, append_system_prompt, prompt)
    }

    fn codex_args_have_config(args: &[String], config: &str) -> bool {
        args.windows(2)
            .any(|window| window[0] == "-c" && window[1] == config)
    }

    fn build_codex_command_for_test(use_mock: bool) -> Vec<String> {
        disable_system_log();
        build_codex_command(use_mock)
    }

    #[test]
    fn build_codex_args_basic_shape() {
        let args = build_codex_args_for_test("/workspace", "", "", "hello");
        assert_eq!(args[0], "exec");
        assert_eq!(args[1], "--json");
        let s_idx = args.iter().position(|a| a == "--sandbox").unwrap();
        assert_eq!(args[s_idx + 1], "danger-full-access");
        assert!(args.contains(&"--skip-git-repo-check".to_string()));
        let c_idx = args.iter().position(|a| a == "-C").unwrap();
        assert_eq!(args[c_idx + 1], "/workspace");
        assert!(codex_args_have_config(&args, "features.memories=true"));
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), "hello");
    }

    #[test]
    fn build_codex_args_omits_model_when_empty() {
        let args = build_codex_args_for_test("/wd", "", "", "p");
        assert!(!args.contains(&"-m".to_string()));
    }

    #[test]
    fn build_codex_args_with_model() {
        let args = build_codex_args_for_test("/wd", "gpt-5", "", "p");
        let m_idx = args.iter().position(|a| a == "-m").unwrap();
        assert_eq!(args[m_idx + 1], "gpt-5");
    }

    #[test]
    fn build_codex_args_resume_uses_positional_subcommand() {
        let args = build_codex_args_for_test("/wd", "", "thread-abc", "follow up");
        let r_idx = args.iter().position(|a| a == "resume").unwrap();
        assert_eq!(args[r_idx + 1], "thread-abc");
        assert_eq!(args[r_idx + 2], "--");
        assert_eq!(args[r_idx + 3], "follow up");
        // resume is a positional sub-subcommand, NOT a --resume flag
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn build_codex_args_resume_layout_is_resume_id_prompt() {
        let args = build_codex_args_for_test("/wd", "", "id1", "p1");
        let r_idx = args.iter().position(|a| a == "resume").unwrap();
        assert_eq!(args.len(), r_idx + 4);
        assert_eq!(args[r_idx + 1], "id1");
        assert_eq!(args[r_idx + 2], "--");
        assert_eq!(args[r_idx + 3], "p1");
    }

    #[test]
    fn build_codex_args_separates_prompt_from_options() {
        let args = build_codex_args_for_test("/wd", "gpt-5", "id", "hello");
        let r_idx = args.iter().position(|a| a == "resume").unwrap();
        assert_eq!(args[r_idx + 2], "--");
        assert_eq!(args[r_idx + 3], "hello");
    }

    #[test]
    fn build_codex_args_prompt_last_in_no_resume_path() {
        let args = build_codex_args_for_test("/wd", "gpt-5", "", "the prompt");
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), "the prompt");
    }

    #[test]
    fn build_codex_args_keeps_dash_prefixed_prompt_as_prompt() {
        let prompt = "--input-format stream-json 是说从一个文件里读取 input 吗？";
        let args = build_codex_args_for_test("/wd", "gpt-5", "", prompt);
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), prompt);
    }

    #[test]
    fn build_codex_args_resume_keeps_dash_prefixed_prompt_as_prompt() {
        let prompt = "--input-format stream-json 是说从一个文件里读取 input 吗？";
        let args = build_codex_args_for_test("/wd", "gpt-5", "id1", prompt);
        let r_idx = args.iter().position(|a| a == "resume").unwrap();
        assert_eq!(args[r_idx + 1], "id1");
        assert_eq!(args[r_idx + 2], "--");
        assert_eq!(args[r_idx + 3], prompt);
    }

    #[test]
    fn build_codex_args_with_append_system_prompt() {
        let args = build_codex_args_with_append_for_test(
            "/wd",
            "",
            "",
            "Your name is Aria.",
            "analyze this",
        );
        assert!(codex_args_have_config(&args, "features.memories=true"));
        assert!(codex_args_have_config(
            &args,
            r#"developer_instructions="Your name is Aria.""#
        ));
        assert_eq!(args[args.len() - 2], "--");
        assert_eq!(args.last().unwrap(), "analyze this");
    }

    #[test]
    fn build_codex_args_empty_append_system_prompt_omitted() {
        let args = build_codex_args_with_append_for_test("/wd", "", "", "", "test");
        assert!(codex_args_have_config(&args, "features.memories=true"));
        assert!(
            !args
                .iter()
                .any(|arg| arg.starts_with("developer_instructions="))
        );
    }

    #[test]
    fn build_codex_args_resume_with_append_system_prompt_order() {
        let args =
            build_codex_args_with_append_for_test("/wd", "", "thread-abc", "Be concise.", "next");
        let c_idx = args
            .iter()
            .position(|a| a == r#"developer_instructions="Be concise.""#)
            .unwrap();
        let r_idx = args.iter().position(|a| a == "resume").unwrap();
        assert!(c_idx < r_idx);
        assert!(codex_args_have_config(&args, "features.memories=true"));
        assert_eq!(args[c_idx], r#"developer_instructions="Be concise.""#);
        assert_eq!(args[r_idx + 1], "thread-abc");
        assert_eq!(args[r_idx + 2], "--");
        assert_eq!(args[r_idx + 3], "next");
        assert_eq!(args.len(), r_idx + 4);
    }

    #[test]
    fn build_codex_args_quotes_append_system_prompt_for_config() {
        let args = build_codex_args_with_append_for_test(
            "/wd",
            "",
            "",
            "Say \"hi\"\nPath C:\\tmp",
            "prompt",
        );
        assert!(codex_args_have_config(
            &args,
            r#"developer_instructions="Say \"hi\"\nPath C:\\tmp""#
        ));
    }

    #[test]
    fn build_codex_command_uses_codex_binary() {
        let cmd = build_codex_command_for_test(false);
        assert_eq!(cmd[0], "codex");
    }

    #[test]
    fn build_codex_command_uses_mock_binary() {
        // Mirrors `build_claude_command_uses_mock_binary`: assert against
        // the default const so regressions in the install path surface.
        let cmd = build_codex_command_for_test(true);
        assert_eq!(cmd[0], env::DEFAULT_MOCK_CODEX_PATH);
    }

    #[test]
    fn build_claude_args_with_disallowed_tools() {
        let args =
            build_claude_args_for_test("", "", "CronCreate,CronDelete,CronList", "", "", "hello");
        let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
        assert_eq!(args[dt_idx + 1], "CronCreate");
        assert_eq!(args[dt_idx + 2], "CronDelete");
        assert_eq!(args[dt_idx + 3], "CronList");
        // "--" must separate variadic tools from the prompt
        assert_prompt_with_separator(&args, "hello");
    }

    #[test]
    fn build_claude_args_empty_disallowed_tools_omitted() {
        let args = build_claude_args_for_test("", "", "", "", "", "test");
        assert!(!args.contains(&"--disallowed-tools".to_string()));
    }

    #[test]
    fn build_claude_args_with_tools() {
        let args = build_claude_args_for_test("", "", "", "Bash,Edit,Read", "", "hello");
        let t_idx = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[t_idx + 1], "Bash");
        assert_eq!(args[t_idx + 2], "Edit");
        assert_eq!(args[t_idx + 3], "Read");
        // "--" must separate variadic tools from the prompt
        assert_prompt_with_separator(&args, "hello");
    }

    #[test]
    fn build_claude_args_empty_tools_omitted() {
        let args = build_claude_args_for_test("", "", "", "", "", "test");
        assert!(!args.contains(&"--tools".to_string()));
    }

    #[test]
    fn build_claude_args_with_settings() {
        let args = build_claude_args_for_test("", "", "", "", r#"{"hooks":{}}"#, "hello");
        let s_idx = args.iter().position(|a| a == "--settings").unwrap();
        assert_eq!(args[s_idx + 1], r#"{"hooks":{}}"#);
        assert_prompt_with_separator(&args, "hello");
    }

    #[test]
    fn build_claude_args_empty_settings_omitted() {
        let args = build_claude_args_for_test("", "", "", "", "", "test");
        assert!(!args.contains(&"--settings".to_string()));
    }

    #[test]
    fn build_claude_args_all_options_combined() {
        let args = build_claude_args_for_test(
            "sess-abc",
            "Be concise.",
            "CronCreate,CronDelete",
            "Bash,Read",
            r#"{"hooks":{}}"#,
            "do something",
        );
        for expected in [
            "--resume",
            "sess-abc",
            "--append-system-prompt",
            "Be concise.",
            "--disallowed-tools",
            "CronCreate",
            "CronDelete",
            "--tools",
            "Bash",
            "Read",
            "--settings",
            r#"{"hooks":{}}"#,
        ] {
            assert!(args.iter().any(|a| a == expected), "missing: {expected}");
        }
        assert_prompt_with_separator(&args, "do something");
    }

    #[test]
    fn build_claude_args_disallowed_tools_whitespace_trimmed() {
        let args = build_claude_args_for_test("", "", " CronCreate , CronDelete ", "", "", "test");
        let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
        assert_eq!(args[dt_idx + 1], "CronCreate");
        assert_eq!(args[dt_idx + 2], "CronDelete");
    }

    #[test]
    fn build_claude_args_tools_whitespace_trimmed() {
        let args = build_claude_args_for_test("", "", "", " Bash , Read ", "", "test");
        let t_idx = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[t_idx + 1], "Bash");
        assert_eq!(args[t_idx + 2], "Read");
    }

    #[test]
    fn build_claude_args_disallowed_tools_empty_items_skipped() {
        // Trailing comma produces an empty token that should be skipped
        let args = build_claude_args_for_test("", "", "CronCreate,,CronDelete,", "", "", "test");
        let dt_idx = args.iter().position(|a| a == "--disallowed-tools").unwrap();
        // Only non-empty tools should be present
        let tool_args: Vec<&str> = args[dt_idx + 1..]
            .iter()
            .take_while(|a| a.as_str() != "--" && !a.starts_with("--"))
            .map(|s| s.as_str())
            .collect();
        assert_eq!(tool_args, vec!["CronCreate", "CronDelete"]);
    }

    #[test]
    fn build_claude_args_prompt_always_last() {
        let args = build_claude_args_for_test("", "", "", "", "", "my prompt");
        assert_eq!(args.last().unwrap(), "my prompt");
    }
}
