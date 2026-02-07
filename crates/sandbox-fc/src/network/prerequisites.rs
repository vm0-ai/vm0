/// Result of a prerequisite check.
#[allow(dead_code)]
pub struct PrerequisiteCheck {
    pub ok: bool,
    pub errors: Vec<String>,
}

#[allow(dead_code)]
/// Check prerequisites for networking (required commands + sudo access).
pub fn check_network_prerequisites() -> PrerequisiteCheck {
    let mut errors = Vec::new();

    let required_commands = ["ip", "iptables", "iptables-save", "sysctl"];
    for cmd in &required_commands {
        if which::which(cmd).is_err() {
            errors.push(format!("Required command not found: {cmd}"));
        }
    }

    // Check sudo access (simplified check)
    let sudo_ok = std::process::Command::new("sudo")
        .args(["-n", "true"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !sudo_ok {
        errors.push(
            "Root/sudo access required for network configuration. \
             Please run with sudo or configure sudoers."
                .to_string(),
        );
    }

    PrerequisiteCheck {
        ok: errors.is_empty(),
        errors,
    }
}
