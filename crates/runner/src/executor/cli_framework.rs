#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum EffectiveCliFramework {
    ClaudeCode,
    Codex,
    Pi,
}

pub(crate) fn effective_cli_framework(cli_agent_type: &str) -> EffectiveCliFramework {
    match normalized_cli_agent_type(cli_agent_type) {
        "codex" => EffectiveCliFramework::Codex,
        "pi" => EffectiveCliFramework::Pi,
        _ => {
            // Guest-agent currently falls back unknown CLI_AGENT_TYPE values to
            // Claude Code. Keep runner env gating aligned with that behavior.
            EffectiveCliFramework::ClaudeCode
        }
    }
}

pub(super) fn normalized_cli_agent_type(cli_agent_type: &str) -> &str {
    if cli_agent_type.is_empty() {
        "claude-code"
    } else {
        cli_agent_type
    }
}
