use std::path::Path;
use std::process::Command;

use super::run_cmd;

pub(crate) struct LoopDeviceGuard {
    device: String,
    detached: bool,
}

impl LoopDeviceGuard {
    pub(crate) fn attach(path: &Path, read_only: bool) -> Result<Self, String> {
        Ok(Self {
            device: attach_loop(path, read_only)?,
            detached: false,
        })
    }

    pub(crate) fn device(&self) -> &str {
        &self.device
    }

    pub(crate) fn detach(&mut self) -> Result<(), String> {
        if self.detached {
            return Ok(());
        }
        detach_loop(&self.device)?;
        self.detached = true;
        Ok(())
    }
}

impl Drop for LoopDeviceGuard {
    fn drop(&mut self) {
        if !self.detached {
            let _ = detach_loop(&self.device);
        }
    }
}

fn attach_loop(path: &Path, read_only: bool) -> Result<String, String> {
    let mut args = vec!["--find", "--show"];
    if read_only {
        args.push("--read-only");
    }
    args.push("--direct-io=on");
    let path_str = path.to_str().ok_or("invalid path")?;
    args.push(path_str);

    let output = Command::new("losetup")
        .args(&args)
        .output()
        .map_err(|e| format!("losetup failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("losetup failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn detach_loop(device: &str) -> Result<(), String> {
    run_cmd("losetup", &["-d", device])
}
